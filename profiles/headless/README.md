# Headless profile: model route

The `headless` profile (`dsh --profile headless "task"`) is the one-shot run path a
cron job or `launchd` job would use. It bundles only `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-headless`, and its own `cordis.patch.yml` is empty — so it keeps the
base default route (`llm-deepseek` → provider `deepseek-official`, `DEEPSEEK_API_KEY`)
and fails on this machine because that key is not exported:

```
$ dsh --profile headless "Reply with exactly HEADLESS-OK and nothing else."
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment
```

The working route on this machine is OpenCode Go, mounted in the web profile by
`profiles/web/cordis.patch.yml`. `headless-providers.cordis.patch.yml` is the same two
rows, ready to overlay.

## Try it without touching the live profile

```bash
REPO="$HOME/src/dsh-web-profile"
dsh --profile headless \
  --patch "$REPO/profiles/headless/headless-providers.cordis.patch.yml" \
  "Reply with exactly HEADLESS-OK and nothing else."
```

`--patch` is a per-run overlay (it is applied after the profile layer and is not
written anywhere). Never put the key in this file or in the repo.

### Observed on this box, 2026-10-25 (the second half of the premise)

The overlay removes the `MISSING_CREDENTIAL` failure, but the separate headless
process then fails authentication:

```
$ dsh --profile headless --patch "$PWD/profiles/headless/headless-providers.cordis.patch.yml" "Reply with exactly HEADLESS-PATCH-OK"
dsh: AUTH: 401: {"type":"authentication_error","code":"api_key_expired",
       "message":"This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store."}
```

So the route patch is necessary but **not sufficient**: the credential a fresh CLI
launch resolves for `OPENCODE_GO_API_KEY` is expired, while the already-running
`dsh web` process still serves `opencode-go/deepseek-v4.1-flash` successfully (it
resolved its credential through the web Models-page sign-in path, not the raw env
value a fresh process sees). Owner action, one of:

1. Refresh the OpenCode Go key in the Web UI → Settings → Models (that writes the
   credential the web process uses), then re-run the command above.
2. Or put a currently-valid `OPENCODE_GO_API_KEY` into the credential store the CLI
   resolves before `--run`.

Until one of those is done, `scripts/night-batch.sh --run` will fail every task with
AUTH 401 even though the dry run and the plan are correct. The interim path for
unattended work is an in-session `schedule_create` run (the web process's credential
works); the batch skeleton is ready for when the CLI credential is refreshed.

## Make it permanent (owner edit)

Add the same rows to `~/.dsh/profiles/headless/cordis.patch.yml` (the live user layer).
That file is currently the empty YAML sequence `[]` (or comments); appending rows to
`[]` produces invalid YAML, so replace it rather than `>>`-append:

```bash
head -20 "$HOME/.dsh/profiles/headless/cordis.patch.yml"   # confirm it is []/comments only
cp "$HOME/src/dsh-web-profile/profiles/headless/headless-providers.cordis.patch.yml" \
   "$HOME/.dsh/profiles/headless/cordis.patch.yml"
```

If the live file already has rows, merge the two rows into its existing list by hand —
do not append a second top-level sequence.

Then `dsh --profile headless "..."` uses the overlay with no `--patch`. Doing this also
unlocks `scripts/night-batch.sh --run`, once the credential issue above is fixed.

## Why the rows look like this

- `llm-pi-ai` already exists in `dsh-base` with an empty `providers` map. The patch
  **replaces** the row's config, so the row must repeat the whole dictionary — an
  `agent-default-model` row that names a provider the adapter does not own fails with
  `UNKNOWN_MODEL`.
- `models` is omitted on purpose: omission keeps the installed pi-ai catalog for
  `opencode-go` (29 model ids), while declaring any `models` list would replace the
  catalog wholesale (see `docs/models.md`).
- `reasoningEffort: max` matches the web default; drop it to `high` for cheaper
  headless batches.
- If you later route headless runs to DeepSeek direct, mount `DEEPSEEK_API_KEY` instead
  and set `provider: deepseek-official`; do not mount both routes with the same
  default-model row.

# agent-os — unattended runs, briefs, and spend

This directory is the durable surface for the company-OS loop: what the night batch
produced, what it cost in tokens, and the task list it ran from. Nothing here is an
external send; every file is local to this repo and reviewed by a human before it
leaves the machine.

## Layout

- `night-batch.tasks.example.md` — template task list for `scripts/night-batch.sh`.
- `runs/<stamp>/` — one directory per batch run (created by the script):
  `SUMMARY.md`, `NN-brief.md`, `NN-events.jsonl`, `NN-stderr.log`.
- Run directories are disposable evidence; promote anything worth keeping into
  `docs/` or `shared/` instead of accumulating them.

## Night batch

`scripts/night-batch.sh` reads an explicit task list, enforces a task count cap, a
per-task wall-clock cap and a whole-batch budget, refuses task text that looks like an
outbound send, and writes one brief per task. **It defaults to a dry run.** Only
`--run` executes, and `--run` needs the headless model route
(`profiles/headless/README.md`).

```bash
# Dry run: prints the plan, starts nothing.
./scripts/night-batch.sh --tasks docs/agent-os/night-batch.tasks.example.md

# Execute with a small cap.
./scripts/night-batch.sh \
  --tasks docs/agent-os/night-batch.tasks.example.md \
  --run --max-tasks 4 --task-timeout 900 --total-timeout 3600
```

Task file format: one task per line; blank lines and `#` comments are ignored; a
leading `- ` or `* ` is stripped.

Safety model, honestly stated:

- The no-external-sends guard is a coarse text match (send/email/slack/webhook/tweet/
  publish/deploy/transfer/charge/invoice). It prevents the obvious accident, not a
  determined one. The batch is still an agent with `bash`; the real fence is that the
  child runs headless with no notification tool and the run directory stays local.
- Every child gets one task, not the whole list, so a poisoned task cannot rewrite the
  plan. The script itself never loops on model output.
- Briefs are claims, not proof: verify a brief before acting on it, and never let the
  batch push, deploy, or spend money.

## schedule_create, when the owner wants it daily

The harness has durable schedules (`schedule_create`, host-wide, survives restart,
delivered back into the session that created it). A daily job is therefore:

```text
schedule_create
  title: Night batch
  prompt: Run `./scripts/night-batch.sh --tasks docs/agent-os/night-batch.tasks.example.md --run --max-tasks 4 --task-timeout 900 --total-timeout 3600` from ~/src/dsh-web-profile, then append the run's SUMMARY.md spend line from `./scripts/usage-meter.mjs --json` to docs/agent-os/runs/<date>/brief.md. Do not push or deploy. Report failures only.
  daily: 04:30:00 Asia/Seoul
```

That requires the session to be durable and the harness host running (it is, via the
launchd `com.typosbro.dsh-web` job) and the headless route patch applied to the live
headless profile — done 2026-10-26, see `profiles/headless/README.md`. The scheduled
prompt authenticates. Caps are wall-clock only: there is no token ceiling, so spend is
bounded by task count and duration and reported after the fact.

## Spend in the daily brief

`scripts/usage-meter.mjs` reads persisted session logs and prints per-turn and total
tokens (input / output / cache-read) for a session, or aggregates the last N sessions:

```bash
./scripts/usage-meter.mjs                       # newest session
./scripts/usage-meter.mjs --sessions 5 --json   # last 5, for a brief
```

It reports tokens, not currency: the harness has no per-route price table on this
machine, so any dollar figure in a brief must be derived from the provider's own
billing page and marked as an estimate. Codex consults
(`scripts/consult-codex.sh`) print their own token line on stderr and are not included
in these session totals.

## Consult Codex

`skills/consult-codex/` + `scripts/consult-codex.sh` give the orchestrator a second,
independent model for review and verification. Use it for adversarial review of a
diff, a second opinion on a risky claim, or a GPT-family answer when OpenCode Go is
limited. Read-only, one-shot, separate ChatGPT quota; never pass secrets.

## Live schedule (approved 2026-10-26)

The owner approved the 04:30 schedule after T5 cleared. It is a host-durable daily
schedule in the web session:

- 04:30 Asia/Seoul, caps `--max-tasks 4 --task-timeout 900 --total-timeout 3600`.
- The task file stays `docs/agent-os/night-batch.tasks.example.md` until a real list exists.
- Report failures only; never push, deploy or send externally.
- First manual run the same day proved the fence (caps enforced, briefs written, no
  external sends) and found a `printf` option-parsing bug in this script, fixed in
  commit `442f4a4`. The 240s manual caps were too short for these tasks; the scheduled
  run uses the approved 900s.

---
name: consult-codex
description: Ask OpenAI Codex (gpt-6.1-sol) for one independent second opinion from a DSH session — adversarial review of a working diff, verification of a risky claim, or a GPT-family answer when the primary route is down. Use when the owner says "consult Codex", "second opinion", "review this with Codex", "have Codex check it", or before claiming high-risk work done. Read-only, one-shot, separate ChatGPT quota.
---

# Consult Codex

Ask OpenAI Codex one question or one diff review, in a fresh context that did not
produce the work. The point is independence, not another editor: Codex runs read-only
in this setup and never edits the repo.

## When to use

- Adversarial review of an uncommitted diff before committing or opening a PR.
- Verifying a risky claim ("the migration is lossless", "the auth check cannot be
  bypassed") with a model that did not write the code.
- A GPT-family second opinion when OpenCode Go is rate-limited, out of quota, or the
  owner wants an uncorrelated answer.
- Reviewing a plan or spec text for holes (prompt mode).

## When not to use

- Implementation work — Codex is read-only here and the DSH agent should make edits.
- Anything secret-bearing. The prompt and diff leave this machine to OpenAI. Never
  pass `.env`, credential files, tokens, or a diff that contains them. Check
  `git status`/`git diff --stat` first.
- Routine or trivial checks a gate already covers. Each call costs tokens on a
  separate ChatGPT pool.

## Commands

Wrapper lives in the profile repo (`scripts/consult-codex.sh`); run it from any repo
with bash.

```bash
# Review the current working diff against HEAD (paths optional, scoped if given)
bash ~/src/dsh-web-profile/scripts/consult-codex.sh --review

# Review only these paths
bash ~/src/dsh-web-profile/scripts/consult-codex.sh --review scripts docs

# Review a saved diff (or stdin)
git diff HEAD > /tmp/patch.diff
bash ~/src/dsh-web-profile/scripts/consult-codex.sh --diff /tmp/patch.diff
git diff HEAD | bash ~/src/dsh-web-profile/scripts/consult-codex.sh --diff -

# One-shot question about the current repo
bash ~/src/dsh-web-profile/scripts/consult-codex.sh --cwd "$PWD" \
  "Read scripts/wt.sh and list the three failure modes that would bite a parallel agent team. Be terse."

# Pin a different model / longer cap
CONSULT_CODEX_MODEL=gpt-5.6-luna CONSULT_CODEX_TIMEOUT=300 \
  bash ~/src/dsh-web-profile/scripts/consult-codex.sh "…"

# Raw JSONL events (debugging the wrapper itself)
bash ~/src/dsh-web-profile/scripts/consult-codex.sh --raw "say ok"
```

Output contract: final message on stdout; one receipt line on stderr
(`[consult-codex] model=… in=… cached=… out=… reasoning=… elapsed=…s`). Exit 0 only
when Codex actually answered.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| exit 127, "codex not on PATH" | CLI missing from this shell | Use the full path or run where `codex` resolves; do not install from an agent turn |
| exit 1, stderr has `401` / "API key has expired" / "Sign in" | Codex auth expired or provider key dead | Report to owner: run `codex login` or fix the key; do not retry blindly |
| exit 124 | `--timeout` hit | Narrow the question/diff; raise `CONSULT_CODEX_TIMEOUT` |
| exit 2, "no diff against HEAD" | Nothing staged/unstaged to review | Commit or stage work, or use prompt mode |
| exit 2, "unknown option" | Wrapper flag typo | `--help` |
| exit 2, "review requires a git working tree" | `--cwd` not a repo | Point `--cwd` at the repo root |
| answer is `NO MATERIAL FINDINGS` | Codex found nothing material | Say so; do not invent findings |
| truncated diff note in prompt | Diff over `CONSULT_CODEX_MAX_DIFF_BYTES` | Review per-path (`--review <paths>`) |

## Cost and hygiene

- One call is one Codex turn; review prompts cost roughly 8–20k input tokens on this
  setup (observed 18.8k for a one-line prompt). Truncate large diffs, scope paths.
- Keep the prompt short and imperative; ask for findings only, not a rewrite.
- Treat Codex output as evidence, not authority: it has not seen the session. If its
  finding contradicts a gate or test result, the gate wins.
- Never paste credentials into a prompt; never let it read `.env` files (read-only
  sandbox blocks writes, not reads).

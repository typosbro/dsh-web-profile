# Epic State Contract

## Safety boundary

Invoking the epic workflow authorizes work inside the named issue tree: read Git and authenticated GitHub state, create or update non-default issue branches and draft PRs, run local validation, push those branches, and update the existing workflow checkpoint.

It does not implicitly authorize merging, deploying, publishing, mutating production, changing pricing, manually closing issues, deleting branches or worktrees, or overwriting existing work.

## Generic lease protocol

Resolve the shared Git directory:

```bash
git rev-parse --path-format=absolute --git-common-dir
```

Store leases only under `<git-common-dir>/epic-locks/` and operate them with `scripts/epic-lock.sh`:

```text
epic-lock.sh acquire <lock-dir> [token] [ttl-seconds]
epic-lock.sh verify <lock-dir> <token> [ttl-seconds]
epic-lock.sh heartbeat <lock-dir> <token> [ttl-seconds]
epic-lock.sh release <lock-dir> <token> [ttl-seconds]
```

Keys:

- Epic: `<owner>-<repository>-<issue>.lock`
- Portfolio: `portfolio-<stable-id>.lock`

The control plane holds the epic lease for the run. A portfolio controller acquires its portfolio lease, then each required epic lease in canonical sorted order before dispatch; on partial acquisition failure it releases what it acquired and reports the blocked lane.

Preserve the returned fencing token locally. Heartbeat active leases at least once per third of the TTL and verify ownership before push, PR mutation, checkpoint mutation, project-field mutation, or another branch-changing action. On ownership loss, stop the affected lane and report `blocked`. Never publish lease tokens in GitHub comments, logs intended for handoff, or worker prompts that do not mutate the protected branch.

Release a lease only after the latest result and SHA are durably checkpointed.

## Generic durable checkpoint

Keep one updatable GitHub comment on the issue containing:

```markdown
<!-- epic-flow:v2 -->
epic: <url>
tier: <fast|full>
phase: <reconcile|implement|integrate|review|remediate|final>
integration_sha: <sha-or-none>
children:
  - <issue> | <state> | <pr-or-none> | <head-sha-or-none>
active_nodes:
  - <issue-or-integration> | <implementer|primary-reviewer|adversarial-reviewer|advisor> | <branch-or-sha>
review:
  sha: <sha-or-none>
  primary: <pass|changes_required|blocked|not_run>
  adversarial: <pass|changes_required|blocked|not_run>
  escalation: <pass|changes_required|blocked|not_run>
  combined: <pass|changes_required|blocked|not_run>
remediation_cycles: <0-3>
unresolved_findings:
  - <finding-or-none>
external_blockers:
  - <blocker-or-none>
final_state: <BLOCKED|READY FOR OWNER QA|READY FOR STAGED RELEASE|in_progress>
updated_at: <ISO-8601>
```

Recognize legacy `epic-flow`, `opencode-epic-flow`, `omp-epic-flow`, and `codex-epic-flow` markers during reconciliation. Do not maintain several comments. On the next mutation, update the existing comment in place to `<!-- epic-flow:v2 -->` and role-based review fields.

Live Git and GitHub state overrides stale checkpoint data. Review evidence is valid only for its exact SHA.

## Child states

Use only:

- `not_started`
- `dirty_local_worktree`
- `branch_without_pr`
- `implementation_in_progress`
- `pr_waiting_for_ci`
- `ready_for_integration`
- `ready_for_review`
- `review_in_progress`
- `changes_required`
- `ready_for_owner_qa`
- `merged_done`
- `blocked`

## Capability and ownership invariants

- Choose workers by capability and risk, never by a required model, provider, harness, or historical agent name.
- One implementer owns one branch at a time. Do not review a branch while it is changing.
- The control plane may schedule and validate but does not edit delivered application code.
- A reviewer has read-only access and a fresh context that did not implement the reviewed SHA.
- Full-tier primary and adversarial reviews use separate fresh contexts. Different model families are optional, not required.
- If the host cannot provide isolation or fresh read-only review, the affected gate is `blocked`; a same-context self-review is not independent evidence.

## Evidence and review invariants

- Acceptance criteria and explicit non-goals are the contract.
- Pushed commits and current PR metadata override abandoned transcripts or stale summaries.
- Freeze a pushed SHA before review; a new SHA requires fresh review.
- Give reviewers the contract, exact SHA, diff, and factual validation results—not implementation reasoning.
- Preserve each initial review before any cross-review discussion.
- Do not dismiss a reproduced defect by majority vote.
- Any supported P0/P1/P2 defect means `changes_required`.
- Increment the remediation counter before dispatch so interruption cannot reset the cap.
- Maximum remediation/re-review cycles: three.
- Existing CI success cannot override contradictory source evidence or an unmet acceptance criterion.

## Dirty-worktree recovery

Never reset, clean, stash, delete, or overwrite a dirty worktree.

Record its path, branch, HEAD, tracked diff summary, and untracked inventory. If ownership is unambiguous, give an isolated implementer a bounded recovery contract on the same issue branch and preserve the original worktree until recovered commits are pushed and verified. Ambiguous ownership is `blocked`.

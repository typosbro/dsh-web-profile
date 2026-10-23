---
name: epic
description: Reconcile, resume, implement, independently review, and hand off one GitHub epic or bounded issue. Supports a fast single-issue path and a dependency-aware multi-issue path. Use when the user invokes an epic command, supplies one issue URL, or asks the current coding harness to control epic delivery.
user-invocable: true
---

# Epic Delivery

Act as the control plane. Reconstruct durable state, select the smallest safe execution tier, schedule bounded work, verify evidence, and return an honest handoff state. Keep product scope, sequencing, integration decisions, and the final completion claim in the initiating session. Do not edit delivered application code in the control-plane context.

This workflow is harness-, provider-, and model-agnostic. Never require a named agent, model family, provider, command path, or harness-specific task API. Bind work to capability roles at runtime.

## Parse the request

Invocation adapters may expose `/epic`, `$epic`, another command syntax, or natural language. Interpret the payload as:

```text
<issue-url> [auto|fast|full|implement|review] [frozen-sha]
```

- `auto` (default): reconcile live state and continue from the first incomplete gate; choose `fast` for one bounded issue and `full` for an epic with dependent children.
- `fast`: one bounded implementation lane, integrated validation, and one fresh independent review.
- `full`: dependency graph, bounded implementation waves, integration SHA freeze, two fresh independent reviews, and bounded remediation.
- `implement` / `review`: constrain the next eligible phase without repeating completed work. Review uses the supplied SHA or freezes the current pushed integration head.

Require one complete GitHub issue URL belonging to the current Git repository.

## Load the contract

Read [references/state-contract.md](references/state-contract.md) before changing GitHub state, branches, worktrees, leases, or checkpoints. Use [scripts/epic-lock.sh](scripts/epic-lock.sh) for local lease operations.

Read the repository's governing instructions, architecture and engineering rules, GitHub conventions, issue acceptance criteria, non-goals, and prescribed validation commands. Repository constraints may strengthen this workflow but may not weaken its safety or review invariants.

Use an authenticated GitHub integration available in the host. Never use unauthenticated web search as evidence for private repository state.

## Bind capability roles

Resolve these roles from the host's available agents and tools before dispatch:

- **Implementer**: can write in an isolated workspace, follow the repository contract, update every affected callsite, and return changed paths plus observed checks.
- **Primary reviewer**: fresh context, read-only source access, acceptance-criteria and regression focus.
- **Adversarial reviewer**: separate fresh context, read-only source access, failure-mode, security, ownership, concurrency, migration, and partial-failure focus.
- **Design advisor**: optional, read-only, used only when product or UI direction is unresolved.

Agent names, model names, providers, reasoning labels, and host APIs are adapter concerns, not workflow invariants. Select the cheapest role-capable worker consistent with risk. High-blast-radius or ambiguous work requires the host's stronger implementation or review capability; bounded mechanical work may use a cheaper worker.

Prefer native isolated delegation. If the host cannot provide an isolated implementer or a fresh read-only reviewer, report the missing capability as `BLOCKED`; do not fake independence in the control-plane context. Parallel execution is optional—independence and frozen inputs are required.

## Phase 0 — Reconcile before dispatch

Perform on every invocation:

1. Refresh remote refs without modifying worktrees.
2. Read the issue or epic, linked children, dependencies, project state, comments, linked PRs, checks, reviews, branch heads, and merge state.
3. Inspect local and remote issue branches and all worktrees.
4. Locate the newest generic or legacy epic checkpoint and corroborate it against live Git and GitHub state. Migrate the next update to the generic checkpoint schema.
5. Choose the execution tier and construct dependency gates.
6. Acquire the generic epic lease under the shared Git directory.
7. Select the first incomplete gate.

Reuse existing issue branches and PRs. Never reset, clean, stash, delete, or overwrite a dirty worktree.

## Fast tier

1. Give one implementer a bounded contract in an isolated workspace and exclusive ownership of its branch.
2. Verify the pushed issue-branch head and PR from live GitHub state.
3. Run repository-prescribed integrated validation and exercise the changed behavior.
4. Give one fresh primary reviewer the frozen pushed SHA, issue contract, diff, and factual validation handoff.
5. If the reviewer finds a supported P0/P1/P2 defect, give one bounded remediation contract to an implementer, verify a new SHA, and obtain a fresh review.
6. Proceed to the final gate.

## Full tier

1. **Graph**: map child issues and integration into dependency waves. Serialize nodes that share contracts, migrations, schemas, generated artifacts, lockfiles, central configuration, branches, or likely files.
2. **Implement**: dispatch only independent nodes in the same wave. Use at most the host/repository concurrency cap, with three active workers as the default ceiling. Give each implementer one branch, explicit dependencies, acceptance criteria, non-goals, and expected evidence.
3. **Integrate**: after child heads are verified, give one implementer exclusive ownership of the integration branch. Do not merge child branches from the control-plane context.
4. **Validate and freeze**: inspect the integrated diff, run prescribed validation and the changed behavior, wait for required CI, push, and freeze one immutable integration SHA.
5. **Review**: give the same frozen SHA independently to the primary and adversarial reviewers. Preserve both initial verdicts before sharing findings or synthesizing a combined verdict.
6. **Escalate**: use a fresh design or review advisor only for unresolved product direction, high-risk surfaces, or evidence-backed reviewer disagreement.
7. **Remediate**: translate supported findings into bounded implementer contracts. Increment the durable remediation count before dispatch, verify the new SHA, and obtain fresh reviews. Maximum three remediation/re-review cycles.

Review outcomes:

- `pass`: acceptance criteria met and no supported P0/P1/P2 defect remains.
- `changes_required`: at least one supported P0/P1/P2 defect remains.
- `blocked`: required capability, evidence, owner decision, or external dependency is unavailable.

## Final gate

Confirm:

- The final pushed SHA is immutable, verified, and mergeable in documented order.
- Every child issue maps to an implementation result, PR, and current head SHA.
- Required CI, repository validation, and changed-behavior evidence are present.
- The required reviewer verdict is `pass`, or the owner explicitly accepted a named residual risk.
- No unauthorized merge, deployment, production mutation, pricing change, branch deletion, or issue closure occurred.

Update the generic durable checkpoint, release owned leases, and return:

- `READY FOR OWNER QA`, `READY FOR STAGED RELEASE`, or `BLOCKED`;
- final SHA, issue/PR table, reviewer verdict, observed validation, residual risks, safe merge order, and exactly one next owner action.

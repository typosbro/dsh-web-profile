---
name: worktree
description: Create and finish one git worktree per task so parallel agents cannot overwrite each other. Use when more than one agent works at once, or when a task must not disturb the current working tree.
---

# One worktree per task

Parallel agents editing one checkout is the most common way a "multi-agent" setup loses work.
Git worktrees are the cheap fix: each task gets its own directory and branch, and the main tree
stays untouched.

## Commands

```bash
scripts/wt.sh new fix-auth            # ../<repo>.wt/fix-auth on branch fix-auth
scripts/wt.sh new fix-auth main       # from a specific base
scripts/wt.sh list
scripts/wt.sh finish fix-auth         # run the repo gate inside the worktree, print merge cmd
scripts/wt.sh rm fix-auth             # remove the directory, keep the branch
```

Worktrees live beside the repo, at `../<repo>.wt/<branch>`, with `/` in branch names flattened
to `-`. Never inside the repo: every other agent's glob and file walk would see it.

## Rules

1. One task, one worktree, one branch. Do not reuse a worktree for a second task.
2. The main tree is read-only while worktrees are active. Edits land in a worktree or nowhere.
3. `finish` runs the gate first. A green gate prints the merge command; it does not merge.
   Merging is a human decision while a task is in review.
4. Two agents never share a worktree, even for "just a quick fix". The shared file is exactly
   the one that gets clobbered.
5. Remove the worktree after merge (`wt.sh rm`). A stale worktree is a stale branch and a
   confusing `git status`.

## When not to use it

A single agent on a single task, or a read-only investigation, does not need isolation. The
overhead is real: dependencies usually need installing per worktree.

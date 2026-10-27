# Global instructions (ported from ~/.dsh/AGENTS.md, 2026-10-27)

## Evidence

Every factual claim carries a receipt: a path with a line, a command and its output, a URL, or the
word unverified. Numbers are read, not typed; cite the primary source, not someone's summary of it.
Never claim success without running the check.

## Research questions

For "is X true / what does the evidence say / which is better", check at least two independent
sources and say where they disagree. Use parallel subagents for independent lookups.

## Shared files

Before changing a file, skill root or repo another session may be using, check `git log` and
mtimes for changes in the last hour. If another agent touched it, reconcile; do not undo its work.

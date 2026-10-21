---
name: context-audit
description: Measure resident context cost (AGENTS.md plus every skill description), find rules duplicated across files, and catch skill-name collisions. Use before adding a skill or a rule, or when a long session seems to forget instructions.
---

# Context audit

Every request pays for the instruction files before it reads the user's words. This measures
that bill and finds the two failures that hide inside it: the same rule written twice, and two
skills sharing a name (one of them is unreachable).

## Run it

```bash
node scripts/context-audit.mjs                 # human report
node scripts/context-audit.mjs --json          # machine-readable
node scripts/context-audit.mjs --strict        # exit 1 when over budget or names collide
node scripts/context-audit.mjs --budget 8000   # resident-token budget
```

## What the numbers mean

- `resident`: AGENTS.md and the skill catalog, sent on every request.
- `on-demand`: skill bodies, sent only when a skill is invoked. A 12k-token skill is fine if it
  is rarely loaded and terrible if it loads on every task.
- Duplicate lines are normal between a skill and its parent; treat three or more copies as a
  stale rule that should live in one place.
- A skill without a description never gets selected. A name collision means one copy shadows
  the other.

## What to do with a bad result

1. Move a rule that appears in three skills into AGENTS.md, and delete the copies.
2. Shorten descriptions before bodies: the description is the resident cost.
3. Split a large skill into a short entry point plus reference files the agent reads on demand.
4. Re-run after the edit. The number should move; if it does not, the edit was cosmetic.

## Pitfalls

- The estimator is characters/4. Do not compare it against an invoice; compare it against the
  previous run.
- Symlinked skill roots are counted once (realpath dedupe). Without that, a symlinked directory
  reports every skill as a collision.

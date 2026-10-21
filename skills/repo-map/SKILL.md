---
name: repo-map
description: Rank a repository's files by exported symbols, recency, and role, and print a token-budgeted map. Use before exploring an unfamiliar repo, or when a directory tree is too large to read.
---

# Repo map

A directory tree says what exists. A repo map says what matters. It is the cheapest first look
at a codebase, and it is deliberately dumb: regex symbols, git recency, path role, no parser
dependencies.

## Run it

```bash
repo-map                 # cwd, 4000-token budget
repo-map --budget 8000   # bigger first look
repo-map --json          # machine-readable

Not on PATH yet? Run `node scripts/repo-map.mjs` from the profile repo, or add its
`scripts/` directory to PATH.
```

## Read it

- The header gives the file count and the top directories by file count.
- Each entry is `path: symbol, symbol, symbol`. Symbols are the file's exports and declarations.
- Ranking is `symbols*2 + recency + role`. `src/` and `lib/` rank above `test/` and `docs/`.
- The budget cut is the signal: everything below the cut is a read you have not justified yet.

## After the map

1. Read the two or three top-ranked files that own the behaviour you were asked about.
2. Grep a symbol from the map instead of opening whole directories.
3. If the task needs a file the map omitted, raise `--budget` once, then go back to targeted
   reads. Do not use a bigger map as a substitute for reading.

## Pitfalls

- Generated files and vendored trees are skipped by directory name only; add a `.gitignore`
  entry rather than editing the script.
- The symbol regex over-reports constants in large JS files. That is acceptable: a false
  positive costs a glance, a false negative costs a grep.
- On a repo with no git history, the recency term is zero and ranking falls back to symbols and
  role.

# site-generator-speed-01-run-20261122 — a faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/xJPtea/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/xJPtea/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free ES module (`solve.js`) whose `run(input)` returns exactly
what make.fun's makefun-site 1.0.0 returns for a generated site — the same
output tree (each page's `index.html`, the index and tag pages,
`build-report.txt` and each static file), byte for byte — but in about a
third of the CPU time. `main.ts` is the harness driver: it reads every case
from `/input/cases.json` and writes the answers to `/output/answers.json`.

## How it is faster

The baseline's cost is allocation and per-character work. This entry keeps the
same semantics with less of both:

- Inline Markdown renders in batched runs: plain text between special
  characters is copied whole, never escaped one character at a time.
- Markdown blocks render in a single pass with no token objects, scanning
  lines by offset and testing block starts on their first character.
- Front matter is read by line offsets and the body is sliced out of the
  source, never split and re-joined.
- Slugs and long dates are memoised per build; slug building is one native
  regex replace instead of a per-character loop.
- Templates render over a scope stack with one vars object per `for`
  execution, not one per iteration, and no linked-list scope walk.

## Verification

- Practice set (3 cases): 3/3 byte-identical to makefun-site 1.0.0.
- 9 freshly generated cases (3 sets from other seeds): 9/9 identical.
- 67 hand-written edge cases (front-matter refusals, template parse errors,
  Markdown inline/block corners, slug collisions, broken links, shadowed
  statics, tag dedup): all identical to the baseline.
- Pure `run()` compute on the practice set: ~200 ms vs the baseline's
  ~650 ms (about 3.2x), measured in-process on this machine.

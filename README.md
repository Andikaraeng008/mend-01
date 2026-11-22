# mend-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Andikaraeng008/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Andikaraeng008/mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, or text-editor tool calls as JSON — finds the
lines each edit names, even when the model drifted their whitespace or
indentation, and changes every file or none.

Built for make.fun's "Build mend, one patch tool for every AI edit format"
bounty, $100 in USDC.

Run it:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or standard input when it is absent or `-`.
`--format` names one format (`unified`, `search-replace`, `v4a`, `json`) or
`auto`, the default, which detects it. `--check` does everything but write.
`--strict` matches lines exactly.

Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=fkrw3nqq).

# mend

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, or text-editor tool calls as JSON — finds the
lines each edit names, even when the model drifted their whitespace or
indentation, and changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or standard input when it is absent or `-`.
`--format` names one format (`unified`, `search-replace`, `v4a`, `json`) or
`auto`, the default, which detects it. `--check` does everything but write.
`--strict` matches lines exactly. See `SPEC.md` in the kit for the whole
contract.

Entered on make.fun: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

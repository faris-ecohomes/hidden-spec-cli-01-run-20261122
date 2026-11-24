[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/faris-ecohomes/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/faris-ecohomes/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` is a zero-dependency command-line tool (Node 22, standard library only)
that applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats, and mend reads all of them to one written contract
(`SPEC.md`):

- unified diffs, including hunks whose line numbers drifted;
- SEARCH/REPLACE blocks;
- V4A patches (`*** Begin Patch` … `*** End Patch`);
- text-editor tool calls as JSON (one array, or JSON Lines).

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The patch comes from the file `PATCH`, or from standard input when `PATCH` is
absent or `-`. The working directory is the root of the tree; every path in the
patch is relative to it.

How mend works:

- The format is detected (or forced with `--format=`), the whole patch is
  parsed first, and only then are its edits applied, in the patch's order.
- Lines an edit names are found at the first of three matching tiers: exact,
  trailing-whitespace-insensitive, then fully whitespace-trimmed. At the
  loosest tier the replacement lines are re-indented to the file's own
  indentation, and context lines always keep the file's own bytes.
- Every edit succeeds or changes nothing, and every failure is reported. When
  any edit failed, no file is written at all; when none failed, the tool
  prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and a
  summary line.
- `--check` prints exactly what a real run would print and writes nothing;
  `--strict` turns off the two loose matching tiers.

`runner.ts` is the kit's trial runner: when `MAKEFUN_ENV_URL` is set, `main.ts`
hands over to it and it drives the CLI once per check in a fresh directory.
`check.ts` runs the public practice set the same way.

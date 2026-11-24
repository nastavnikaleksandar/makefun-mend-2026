# mend

One command-line tool that applies the edits AI models write, in four formats (unified diff, SEARCH/REPLACE blocks,
V4A patches, JSON editor calls), to a tree of files, to the specification in `SPEC.md`. Node 22, standard library only.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Run it in the root of the tree it should edit. Without `PATCH`, or with `-`, the patch comes from standard input.
It prints one line per changed path (`A`, `D`, `M`, `R old -> new`), then `ok: <n> files`, or `error: <code> <path>`
lines and `failed: <k> of <n> edits`, and writes nothing unless every edit succeeded.

## Running the checks

The public practice set (100 checks with the house reference's expected outcomes) ships in the kit:

    node check.ts hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json

A single family or key prefix narrows it: `node check.ts <practice.json> u-exact s-basic`.

`tests/extra.ts` holds further checks written from SPEC.md sentences the practice set does not exercise:

    node tests/extra.ts

Use the Node 22 install the contest requires; both scripts spawn `node main.ts` per check exactly as the grader does.

## Layout

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner, unchanged (the grader runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` set and
  this file drives the checks).
- `check.ts`: the kit's practice-check driver, unchanged.
- `SPEC.md`: the contract.
- `hidden-spec-cli-01-run-20261122-kit/`: the kit as it was handed out, untouched.
- `work/`: scratch, including the starter `main.ts` as it shipped.

## Licence

MIT, see `LICENSE`.

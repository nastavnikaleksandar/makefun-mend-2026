# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nastavnikaleksandar/makefun-mend-2026/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nastavnikaleksandar/makefun-mend-2026/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.**

mend is a Node.js 22 command-line tool that applies AI-generated edits in four formats—unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON text-editor calls—to a tree of text files. It resolves target lines through three matching tiers and applies changes atomically: either every edit succeeds or no files are modified.

**Competition:** [Build mend on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

## Run

Run from the root directory of the file tree to edit:

```bash
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

When `PATCH` is omitted or set to `-`, mend reads the patch from standard input. It uses Node.js 22 and the standard library only; no dependencies need to be installed.

## Tests

Run the 100 public practice checks:

```bash
node check.ts hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

Run the additional specification-focused checks:

```bash
node tests/extra.ts
```

## License

MIT. See [LICENSE](LICENSE).

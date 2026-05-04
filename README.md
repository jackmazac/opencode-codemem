# codemem

`codemem` is a thin OpenCode plugin plus a long-running daemon that detects semantic drift, structural duplication, API drift, architectural cycles, dead-code risk, and multi-session conflict risk in rapidly changing TypeScript codebases.

It is intentionally **not** a linter, formatter, or type checker. The plugin stays small and fast. The daemon owns indexing, hashing, graph maintenance, persistence, and heavier analysis.

## Workspace layout

- `packages/codemem-plugin`: OpenCode plugin, daemon supervision, RPC client, agent-facing tools.
- `packages/codemem-shared`: config loading, wire protocol, finding contracts, prompt-signal builder.
- `packages/codemem-daemon`: Rust sidecar daemon, SQLite-backed index, clone/type/graph/session detectors.
- `codemem.config.example.jsonc`: starter configuration.

## Install

### 1) Install toolchains and dependencies

Use Bun `1.3.13` and the Rust toolchain pinned in `rust-toolchain.toml`.

```bash
bun install
```

### 2) Build, test, and package

```bash
bun run verify
```

This runs TypeScript typecheck, Bun tests, Rust tests, the release daemon build, and local package creation. Package artifacts are written to `artifacts/`:

- `artifacts/codemem-shared-0.1.0.tgz`
- `artifacts/codemem-plugin-0.1.1.tgz`

The plugin package includes:

- the current platform daemon binary under `bin/<platform>-<arch>/codemem-daemon`
- the `codemem` CLI binary at `dist/cli.js`

### 3) Install into global OpenCode config

Add both local tarballs as dependencies in `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@codemem/shared": "file:/absolute/path/to/codemem/artifacts/codemem-shared-0.1.0.tgz",
    "@codemem/plugin": "file:/absolute/path/to/codemem/artifacts/codemem-plugin-0.1.1.tgz"
  }
}
```

Add `@codemem/plugin` to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@codemem/plugin"]
}
```

Then install config dependencies:

```bash
cd ~/.config/opencode
bun install
```

### 4) Development plugin option

For source-tree development, you can instead create `~/.config/opencode/plugins/codemem.ts`:

```ts
import plugin from "file:///absolute/path/to/codemem/packages/codemem-plugin/dist/index.js";

export default plugin;
```

Use the packaged install for smoke testing release behavior. Use the file plugin only when actively editing plugin source.

### 5) Add project config

Copy the example file into any project that needs non-default entrypoints, ignores, or package boundaries:

```bash
cp codemem.config.example.jsonc codemem.config.jsonc
```

Set at least:

- `entrypoints`
- `ignore`

You usually do not need `daemon.binaryPath` for packaged installs because the plugin resolves its bundled daemon binary. During development, `CODEMEM_DAEMON_BIN` or `daemon.binaryPath` can point at `packages/codemem-daemon/target/release/codemem-daemon`.

## First run

1. Start an OpenCode session in the project.
2. The plugin lazily starts `codemem-daemon` the first time a `codemem_*` tool is invoked or a write/edit event needs indexing.
3. The daemon creates local state under `.git/codemem` by default, or `.codemem` if no Git directory exists.
4. Run `codemem_check` from OpenCode, or use `codemem status --json` from a terminal.

The first cold run boots the daemon, scans the repo, stores the symbol/clone/type indexes, and returns compact JSON findings designed for agents.

## Tools exposed to OpenCode

- `codemem_check`: compact findings list.
- `codemem_drift_map`: bounded graph for planning/refactor agents.
- `codemem_conflicts`: overlapping dependency-cone risk across sessions.
- `codemem_change_risk`: dependency-cone and public-surface risk for paths.
- `codemem_before_edit`: pre-edit isolation/shared-surface check.
- `codemem_review_focus`: reviewer-focused high-risk files and symbols.

## Maintenance

The packaged CLI is non-interactive and RPC-backed:

```bash
codemem status
codemem check --path src/index.ts --max-findings 25 --json
codemem drift-map --max-findings 50 --json
codemem conflicts --session-id sess_123 --json
codemem maintain --dry-run
codemem maintain --apply --prune-logs --compact
codemem rebuild --dry-run
codemem rebuild --apply
codemem baseline diff --json
codemem baseline write --apply --json
codemem impact-cone --path src/index.ts --depth 2 --json
codemem api-surface --json
codemem layer-boundaries --json
codemem lockfile --json
codemem report --format sarif --json
codemem artifact --kind audit --slug codemem-audit --apply --json
codemem artifact --kind journal --apply --json
```

## Benchmarks

The local benchmark harness exercises the CLI path and reports machine-readable timings:

```bash
bun run bench -- --quick
```

Quick mode covers daemon status and `codemem check` against the current repository. Full mode creates a synthetic project and measures cold status, cold check, hot-edit check, review-focus, and warm status:

```bash
bun run bench
```

Treat the numbers as local regression evidence until CI threshold gates are added for cold-index, hot-edit, daemon restart, and RSS targets.

Use the local threshold gate to fail on obvious regressions in the synthetic-project benchmark:

```bash
bun run bench:threshold
```

The packaged runtime smoke test installs the local `.tgz` artifacts into a temporary config, verifies the `codemem` bin, starts the packaged daemon, and runs `doctor` plus `check`:

```bash
bun run smoke:packaged
```

## Operational notes

- Plugin startup is intentionally lightweight. Expensive parsing and indexing stay out of OpenCode hook paths.
- Edit hooks enqueue file changes; they do not block on full indexing.
- Findings are bounded and machine-readable.
- The daemon auth token is persisted in the state directory so OpenCode restarts can reconnect to an already-running daemon.
- Local state is bounded and pruneable.

## Development status

The TypeScript workspace is designed to type-check independently of OpenCode runtime packaging. The Rust daemon builds with the pinned Rust `1.92.0` toolchain. Windows named-pipe support remains present in code but should not be claimed as supported until it is verified on Windows CI or hardware.

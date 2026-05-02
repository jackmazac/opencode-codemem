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
- `artifacts/codemem-plugin-0.1.0.tgz`

The plugin package includes the current platform daemon binary under `bin/<platform>-<arch>/codemem-daemon`.

### 3) Install into global OpenCode config

Add both local tarballs as dependencies in `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@codemem/shared": "file:/absolute/path/to/codemem/artifacts/codemem-shared-0.1.0.tgz",
    "@codemem/plugin": "file:/absolute/path/to/codemem/artifacts/codemem-plugin-0.1.0.tgz"
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
4. Run `codemem_check` from OpenCode.

The first cold run boots the daemon, scans the repo, stores the symbol/clone/type indexes, and returns compact JSON findings designed for agents.

## Tools exposed to OpenCode

- `codemem_check`: compact findings list.
- `codemem_drift_map`: bounded graph for planning/refactor agents.
- `codemem_conflicts`: overlapping dependency-cone risk across sessions.

## Maintenance

These RPC-backed commands are intended for a small CLI wrapper or direct daemon client:

```bash
codemem status
codemem maintain --dry-run
codemem maintain --apply --prune-logs --compact
codemem rebuild --dry-run
codemem rebuild --apply
```

## Operational notes

- Plugin startup is intentionally lightweight. Expensive parsing and indexing stay out of OpenCode hook paths.
- Edit hooks enqueue file changes; they do not block on full indexing.
- Findings are bounded and machine-readable.
- Embeddings are optional and off by default.
- The daemon auth token is persisted in the state directory so OpenCode restarts can reconnect to an already-running daemon.
- Local state is bounded and pruneable.

## Development status

The TypeScript workspace is designed to type-check independently of OpenCode runtime packaging. The Rust daemon builds with the pinned Rust `1.92.0` toolchain. Windows named-pipe support remains present in code but should not be claimed as supported until it is verified on Windows CI or hardware.

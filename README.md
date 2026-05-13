# Codemem

OpenCode plugin plus Rust daemon: **code-graph indexing, drift and duplication signals, impact cones, and review focus**—all **advisory** (no edit blocking, no Concord coupling).

## What it is

- **Plugin** (`packages/codemem-plugin`): tools, daemon supervisor, JSON-RPC client.
- **Daemon** (`packages/codemem-daemon`): incremental parse/index, SQLite WAL, detectors.
- **Shared** (`packages/codemem-shared`): wire protocol, `FleetCorrelation`, finding types.

Graph identity tables never store fleet IDs; correlation is optional metadata only.

## Quick start

```bash
bun install
bun run verify
```

Artifacts land in `artifacts/` (`codemem-plugin-*.tgz`, `codemem-shared-*.tgz`). Load the plugin via Fleet, `file://` entry, or packaged tarball—see `AGENTS.md` for the full tool list and install paths.

## Development

```bash
bun run verify   # typecheck, tests, Rust tests, smoke, quick bench gates
```

Details: **`AGENTS.md`**. Deeper protocol and CLI reference: **`docs/init.md`**.

## Fleet position

| Owns | Does not own |
|------|----------------|
| Code-graph truth, drift/clones/cycles/dead-code risk, impact cone, `codemem_*` tools | Memory (Engram), doctrine/plans (Conductor), edit locks (Concord), fleet install (opencode-fleet) |

## License

See `LICENSE`.

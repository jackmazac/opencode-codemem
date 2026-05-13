# @mazac-fox/codemem-plugin — agent guide

## Scope

Code-graph truth. Drift, duplication, cycles, dead code, impact cones, API surface, layer boundaries, session conflict risk. Advisory only — no tool blocks edits, modifies project files, or interacts with Concord's lock surface.

## Canonical contracts

`FleetCorrelation` type in `packages/codemem-shared/src/protocol.ts`. Fleet IDs flow through every relevant request type as optional fields. The Rust daemon accepts them and lightly persists in session metadata (does NOT contaminate graph identity tables — `files`, `imports`, `public_exports`, `clone_fingerprints`, `type_shapes` are keyed on code-object identity only).

Current plugin version: `0.1.1` (packaged as `artifacts/mazac-fox-codemem-plugin-0.1.1.tgz`).
Shared package version: `0.1.0` (packaged as `artifacts/mazac-fox-codemem-shared-0.1.0.tgz`).

## Architecture

- **TS plugin** (`packages/codemem-plugin`): OpenCode tool registration, daemon supervisor, RPC client, prompt-injection hooks.
- **Rust daemon** (`packages/codemem-daemon`): incremental indexing, Oxc-based parsing (0.123.0), graph computation, finding detectors, SQLite WAL persistence.
- **Shared** (`packages/codemem-shared`): protocol types including `FleetCorrelation`, config schema, finding contracts, artifacts, report helpers, baseline types.

Transport: Unix domain socket (named pipe on Windows), length-prefixed JSON, JSON-RPC 2.0 envelopes. Auth token in `run/daemon.token`. State in `.git/codemem/` or `.codemem/`.

## What agents do here

- Add new finding kinds: extend `CodeMemFinding` union in `packages/codemem-shared/src/protocol.ts`, add a Rust type mirror in `packages/codemem-daemon/src/protocol.rs`, add a detector or detector branch in `packages/codemem-daemon/src/detectors/`, add test fixtures.
- Add new plugin tools: lift CLI capability into a tool in `packages/codemem-plugin/src/tools.ts` using an existing daemon RPC endpoint (or add a new one). See tool addition workflow below.
- Improve detectors: keep them deterministic (same input, same output), add test corpus fixtures, gate noise with min-size rules and severity tiers.
- Extend `FleetCorrelation`: add optional fields additively; never make existing fields required; update Rust mirror with `#[serde(default)]`.
- Add bench rows: add a threshold entry in `bench/thresholds.json` for any new daemon-backed path. Run `bun run bench:threshold` to validate.
- Extend the CLI: add a new subcommand in `packages/codemem-plugin/src/cli/` and wire it to an existing RPC method.

## What agents do NOT do here

- Make `codemem_before_edit` blocking. It is ADVISORY — it returns `level/score/focus` for the orchestrator to act on. It does not prevent edits, does not call Concord, does not set lock state.
- Contaminate graph identity with session or correlation metadata. Graph tables (`files`, `imports`, `public_exports`, `clone_fingerprints`, `type_shapes`) store code-object identity. Sessions and correlation fields are separate concerns and stay in session/event tables.
- Lower bench thresholds without justification. Thresholds are regression gates. If a new feature makes a path slower, either optimize or add a new threshold row; do not loosen existing rows silently.
- Use Zod directly in tool argument schemas. Use `tool.schema.*` (the host-adapter-wrapped surface). The `lint:no-zod` check enforces this.
- Reach into memory, doctrine, or Concord. Codemem has no dependency on Engram, Conductor, or Concord in production. Codemem artifacts are written to disk; the other plugins pick them up declaratively.
- Ship daemon errors to users as plugin failures. The supervisor catches daemon unavailability and degrades gracefully — tools return a bounded warning shape, not an uncaught exception.
- Mutate project files. Codemem is read-only on the project. `codemem_artifact` emits an artifact to `.opencode/` but does not touch project source.

## Critical invariants

- All tools are ADVISORY. `codemem_before_edit` returns `level + score + focus` — the calling orchestrator decides whether to proceed.
- `FleetCorrelation` fields are OPTIONAL on every request. Daemon accepts them; does not require them. Behavior without correlation fields is identical to pre-Wave-5.
- Graph identity tables (`files`, `imports`, `public_exports`, `clone_fingerprints`, `type_shapes`) NEVER store fleet correlation IDs. Sessions and conflicts tables may.
- Bench gates: `bun run bench:threshold -- --quick` must pass before commit. Thresholds live in `bench/thresholds.json`.
- Tool parity: every CLI command that exposes useful advisory data should have a corresponding plugin tool. Wave 5 closed the 4-tool gap (added `codemem_api_surface`, `codemem_impact_cone`, `codemem_layer_boundaries`, `codemem_artifact`). Total: 10 tools.
- Plugin startup is lazy. No indexing, parsing, or daemon contact in plugin init. The daemon is started only when a `codemem_*` tool is invoked or a write event is enqueued.
- Daemon startup must not run a full-repo bootstrap scan. Broad indexing is explicit job/rebuild work or bounded fresh-index work, and queue drops/failures must be visible in health.
- `doctor --json` emits a canonical Fleet `HealthReport`. Do not reintroduce legacy `status: pass` doctor output.
- Daemon reuse is health-first. Supervisors must attach to an already healthy daemon before spawning, coordinate starts with `run/codemem.start.lock`, and remove stale PID/socket/lock state only after proving the recorded owner is not alive.
- Daemon lifecycle failures must be visible. Spawn stdout/stderr go to `log/daemon.stdout.log` and `log/daemon.stderr.log`; lifecycle events go to `log/daemon.lifecycle.jsonl` and Host Adapter telemetry. Do not return to silent `stdio: "ignore"` failure modes.
- Cleanup is explicit. Use `codemem stop` for graceful shutdown and `codemem cleanup --stale` for stale state cleanup. Do not rely on an OpenCode plugin shutdown hook; the SDK does not provide one.

## Type safety rules

- No `as` assertions on unknown data in TypeScript. Use explicit narrowing or the contracts parsers.
- No `any`. If the type is genuinely unknown at a boundary (e.g., raw JSON from disk), narrow through a type guard before use.
- No `@ts-ignore` or `@ts-expect-error`.
- Rust: `Option<T>` for optional correlation fields; `serde rename_all = "camelCase"` on all wire types; `#[serde(default)]` where values may be absent on incoming requests.
- Plugin tool arg schemas use `tool.schema.*`, not raw Zod imports.

## Tool addition workflow

1. Add the tool implementation in `packages/codemem-plugin/src/tools.ts`.
2. Extend the daemon client method in `packages/codemem-plugin/src/daemon/client.ts` if a new RPC call is needed.
3. Add or reuse the Rust RPC handler in `packages/codemem-daemon/src/rpc.rs`.
4. Add the protocol request/response types in `packages/codemem-shared/src/protocol.ts` extending `FleetCorrelation` as appropriate.
5. Add the Rust type mirrors in `packages/codemem-daemon/src/protocol.rs` with `#[serde(default)]` on optional fields.
6. Update `packages/codemem-plugin/src/plugin-contract.test.ts` `expectedTools` array.
7. Add a bench row in `bench/thresholds.json` if the tool is daemon-backed with a meaningful latency profile.
8. Run `bun run verify` and `bun run bench:threshold -- --quick`.
9. Update fleet manifest `expected_tools` count (Fleet's manifest default + `~/.config/opencode/fleet.jsonc` if maintained separately).

## Validation before commit

```bash
bun install
bun run typecheck
bun run test
cargo test --manifest-path packages/codemem-daemon/Cargo.toml
bun run bench:threshold -- --quick
bun run smoke:packaged
bun run smoke:runtime
bun run verify
```

`bun run verify` is the canonical all-in-one command. Run it before any commit that changes TS or Rust source.

## Fleet position

Advisory. Orchestrators call:

- `codemem_before_edit` — decide whether a set of paths is risky before editing
- `codemem_impact_cone` — understand blast radius of a change
- `codemem_api_surface` — know public contract shape before and after a refactor wave
- `codemem_review_focus` — rank files for reviewer attention

Codemem never blocks tool execution itself. It does not hold edit locks (Concord does). It does not store memory across sessions (Engram does). It does not track doctrine or plans (Conductor does).

## Packaging

Distribution is `tgz` at `artifacts/mazac-fox-codemem-plugin-0.1.1.tgz`. Fleet installs via file reference. Regenerate after plugin changes:

```bash
bun run package:local
```

This rebuilds the Rust daemon for the current platform, re-bundles the plugin, and writes both tarballs to `artifacts/`.

The packaged daemon binary resolves automatically at runtime from inside the tgz. Set `CODEMEM_DAEMON_BIN` or `daemon.binaryPath` in config only for development/override scenarios.

## Links

- Canonical plan: `~/Developer/opencode-conductor/.opencode/plans/fleet-correlation.md`
- Init doc (architecture decision record): `docs/init.md`
- Protocol types: `packages/codemem-shared/src/protocol.ts`
- Tool definitions: `packages/codemem-plugin/src/tools.ts`
- Bench thresholds: `bench/thresholds.json`

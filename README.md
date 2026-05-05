# codemem

`codemem` is a thin OpenCode plugin plus a long-running Rust daemon that detects semantic drift, structural duplication, API drift, architectural cycles, dead-code risk, multi-session conflict risk, and impact cones in rapidly changing TypeScript codebases.

It is intentionally **not** a linter, formatter, or type checker. The plugin stays small and fast. The daemon owns indexing, hashing, graph maintenance, persistence, and heavier analysis. All tools are **advisory only** — no tool blocks edits or prevents execution.

## Workspace layout

- `packages/codemem-plugin`: OpenCode plugin, daemon supervision, RPC client, agent-facing tools.
- `packages/codemem-shared`: config loading, wire protocol, finding contracts, prompt-signal builder, FleetCorrelation types.
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

This runs TypeScript typecheck, Bun tests, Rust tests, the release daemon build, local package creation, runtime smoke, packaged smoke, and quick bench thresholds. Package artifacts are written to `artifacts/`:

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

For fleet-managed installs, the Fleet manifest lists `@codemem/plugin` as a plugin dependency with `expected_tools: 10`. After Wave 5, fleet-generated `opencode.json` includes codemem automatically.

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

Daemon startup does not scan the repo. Indexing is driven by explicit tool paths, fresh-index requests, rebuild jobs, or file-change events. When index state is stale or empty, tools return bounded advisory JSON and health surfaces warn rather than hiding the degraded state.

## Plugin tools

Ten tools are registered with OpenCode. All are advisory — they return structured JSON for agent reasoning but never block tool execution.

### Analysis

- `codemem_check`: compact findings list (drift, clones, cycles, dead code, conflicts).
- `codemem_drift_map`: bounded dependency-graph nodes and edges for planning/refactor agents.
- `codemem_conflicts`: overlapping dependency-cone risk across concurrent sessions.

### Impact and risk

- `codemem_change_risk`: dependency-cone and public-surface risk score for one or more paths.
- `codemem_before_edit`: pre-edit isolation/shared-surface check. Returns `safeToEdit / level / score / reasons / focus / stats`. The orchestrator decides whether to proceed — this tool NEVER blocks edits.
- `codemem_review_focus`: reviewer-focused high-risk files and symbols for changed paths.
- `codemem_impact_cone`: forward and reverse neighbor graph for a path at configurable depth.

### Contract and architecture

- `codemem_api_surface`: public export signatures and API drift summary for the workspace or a path.
- `codemem_layer_boundaries`: architectural layer violations and package-boundary crossings.

### Artifacts

- `codemem_artifact`: emit a codemem finding or summary as a conductor-compatible artifact (audit, journal, or report kind).

## Advisory-only invariant

`codemem_before_edit` is the most frequently misunderstood tool. It returns an advisory level (`low` / `medium` / `high`) and a score. **It never prevents an edit from proceeding.** The orchestrator that calls it decides what to do with the result. This is intentional and permanent — codemem is observational, not gating.

All other tools share this invariant. No codemem tool modifies project files, blocks tool execution, or interacts with Concord's edit lock surface.

## CLI surface

The packaged CLI is non-interactive and RPC-backed:

```bash
codemem status
codemem status --json
codemem check --path src/index.ts --max-findings 25 --json
codemem drift-map --max-findings 50 --json
codemem conflicts --session-id sess_123 --json
codemem change-risk --path src/index.ts --json
codemem review-focus --path src/index.ts --json
codemem impact-cone --path src/index.ts --depth 2 --json
codemem api-surface --json
codemem layer-boundaries --json
codemem baseline diff --json
codemem baseline write --apply --json
codemem maintain --dry-run
codemem maintain --apply --prune-logs --compact
codemem rebuild --dry-run
codemem rebuild --apply
codemem lockfile --json
codemem explain --finding <id> --json
codemem report --format sarif --json
codemem artifact --kind audit --slug codemem-audit --apply --json
codemem artifact --kind journal --apply --json
codemem change-delta --from <ref> --to <ref> --json
```

`codemem doctor --json` emits a canonical Fleet `HealthReport` with daemon health, protocol/schema checks, queue depth, queue drops, failed index batches, and index/cache state. Apply-mode maintenance and rebuild operations acquire store-backed leases so compaction and rebuild work cannot silently race active writer paths.

## Daemon architecture

The Rust daemon owns all expensive analysis. The TS plugin is a thin supervisor and RPC client.

- **State directory**: `.git/codemem/` (or `.codemem/` for non-Git repos)
- **Persistence**: SQLite with WAL mode — one writer, many readers, snapshot-consistent reads
- **Transport**: Unix domain socket (`run/codemem.sock`) with 4-byte length-prefixed JSON envelopes; named pipe on Windows
- **Auth**: token file at `run/daemon.token`; PID at `run/daemon.pid`
- **Protocol**: JSON-RPC 2.0 envelopes with `protocolVersion`, `authToken`, `method`, `params`, `result | error`

Core daemon tables: `files`, `imports`, `public_exports`, `clone_fingerprints`, `type_shapes`, `api_baseline`, `sessions`, `findings_cache`, `event_log`.

The indexing pipeline uses Oxc crates (0.123.0) for parsing and resolution. The detectors run after each incremental file update:

1. L1 exact/parameterized clone hashing (BLAKE3)
2. L2 SimHash near-miss clones
3. Structural type-shape hashing (BLAKE3)
4. Import/export graph update and SCC cycle detection
5. Dead-code reachability from entrypoints
6. API drift against stored baseline
7. Session conflict risk (dependency-cone overlap)

L3 semantic clone detection (embeddings + ANN) is designed into the config/protocol but disabled by default in v1.

## Correlation

Wave 5 added the `FleetCorrelation` protocol type in `packages/codemem-shared/src/protocol.ts`. Every request type that flows between the plugin and daemon extends `FleetCorrelation`:

```ts
type FleetCorrelation = {
  correlationId?: string;
  planId?: string;
  planSlug?: string;
  waveId?: string;
  agentRunId?: string;
  fleetRunId?: string;
};
```

All fields are **optional**. The daemon accepts correlation fields and lightly persists them in session metadata for tracing purposes. Correlation IDs never flow into graph identity tables (`files`, `imports`, `public_exports`, `clone_fingerprints`, `type_shapes`) — those tables are keyed on code-object identity only.

If no correlation fields are supplied, behavior is identical to pre-Wave-5.

## Fleet integration

Orchestrators in the fleet use codemem tools in two patterns:

**Pre-edit review**: Call `codemem_before_edit` with the paths you are about to modify. Check the returned `level` and `focus` fields. If `level` is `high`, consider reviewing `focus` files first or calling `codemem_impact_cone` to understand blast radius. The orchestrator decides whether to proceed — the tool never blocks.

**Impact assessment**: Call `codemem_impact_cone` with a path and `depth: 2` (default) to get the forward and reverse dependency graph. Use this to scope review, identify callers, and understand which tests are most relevant.

**API contract review**: Call `codemem_api_surface` before and after a refactor wave to confirm public export shapes have not drifted beyond intent.

**Review gating**: Call `codemem_review_focus` on changed paths to get a ranked list of high-risk files and symbols for reviewers to inspect first.

## Benchmarks

The threshold gate enforces regression bounds on the synthetic-project benchmark path via plugin-path RPC:

```bash
bun run bench:threshold -- --quick
```

Quick-mode thresholds:

| Scenario | Max ms |
|---|---|
| status | 1000 |
| check | 1500 |
| api_surface | 1500 |
| impact_cone | 1500 |
| layer_boundaries | 1500 |

Full-mode thresholds:

| Scenario | Max ms |
|---|---|
| status-cold | 1500 |
| cold-check | 1500 |
| hot-edit-check | 750 |
| review-focus | 1500 |
| status-warm | 750 |

Run the full benchmark suite:

```bash
bun run bench
```

Run quick mode (daemon status + check only):

```bash
bun run bench -- --quick
```

Run the packaged runtime smoke test (installs tgz artifacts into a temp config, verifies bin, starts packaged daemon, runs doctor and check):

```bash
bun run smoke:packaged
```

## Ownership

Codemem owns:

- Code-graph truth: symbol index, import graph, API surface baseline
- Drift detection: API changes against baseline
- Duplication: semantic clones (exact/near-miss/type-shape)
- Cycles: file and package-level
- Dead-code risk: reverse reachability from entrypoints
- Session conflict risk: dependency-cone overlap between concurrent sessions
- Impact analysis: forward and reverse neighbors
- Review focus: ranked high-risk files for changed paths

Codemem does NOT own:

- Memory retrieval or artifact ingest — that is Engram
- Doctrine, plans, run records, lifecycle artifacts — that is Conductor
- Live edit locks and conflict resolution — that is Concord
- Plugin installation, fleet manifest, health reporting — that is opencode-fleet
- Plugin boundary safety and tool-execute semantics — that is opencode-host-adapter

## Development

Run all checks:

```bash
bun run verify
```

Individual steps:

```bash
bun install
bun run typecheck
bun run test
cargo test --manifest-path packages/codemem-daemon/Cargo.toml
bun run bench:threshold -- --quick
bun run smoke:packaged
bun run smoke:runtime
```

The TypeScript workspace is designed to type-check independently of OpenCode runtime packaging. The Rust daemon builds with the pinned Rust `1.92.0` toolchain. Windows named-pipe support remains present in code but should not be claimed as supported until it is verified on Windows CI or hardware.

## License

See `LICENSE`.

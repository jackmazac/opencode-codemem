## 1. Executive recommendation

Recommend **Architecture A**: a **thin OpenCode plugin running on Bun/OpenCode** plus a **Rust sidecar daemon**. Keep the plugin lazy and almost stateless, use a **local stream socket** transport (Unix domain socket on POSIX, named pipe on Windows) with **length-prefixed JSON**, store state in **SQLite WAL**, and ship **L3 semantic embeddings off by default**. This matches the verified reality that OpenCode plugins run in-process and awaited hooks are executed sequentially, Bun can supervise detached child processes and local sockets, Bun’s FFI/Worker/native-addon boundary is still the riskier place to put a heavy analysis core, Oxc’s stable Rust line was available by late March 2026, and tsgo remained preview/unstable for programmatic compiler-style use. ([GitHub][1])

The attached implementation already covers the hard parts that matter most for a v1: daemon supervision, framed RPC, incremental indexing, exact/near-miss clone detection, structural type-shape duplication, import graph reachability and cycles, API drift, dead-code risk, and multi-session conflict risk. Embedding-based L3 is designed into the config/protocol, but deliberately not wired into the default runtime yet.

## 2. Version/API verification table

Important limitation: I hard-verified the ecosystem pieces that drive the architecture. I did **not** independently web-verify every secondary crate/package version in the sample workspace. Treat the attached `package.json`/`Cargo.toml` as implementation scaffolding and finalize exact non-core pins through lockfiles in your target CI environment.

| Component                | Verified pin/status                                   | What I verified                                                                           | Source                          |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| OpenCode                 | **v1.14.31**                                          | Tagged release exists; plugin surface verified from tagged source, not HEAD               | ([GitHub][2])                   |
| Bun                      | **v1.3.13**                                           | Release exists; spawn/socket/sqlite/ffi/worker/N-API/compile docs checked                 | ([Bun][3])                      |
| Oxc core crates          | **0.123.0**                                           | Stable March 30, 2026 crate line                                                          | ([GitHub][4])                   |
| oxlint / oxfmt           | **1.58.0 / 0.43.0**                                   | Stable March 30, 2026 release line                                                        | ([GitHub][4])                   |
| tsgo / TypeScript native | **No stable programmatic API verified** by March 2026 | Official material still described preview/native-preview and open API-shape work          | ([Microsoft for Developers][5]) |
| `oxc-parser` npm         | **0.123.0 npm binding exists**                        | Node API package exists, but I do not recommend it as the canonical daemon path under Bun | ([npm][6])                      |
| `oxc-resolver` npm       | **11.8.3 npm binding exists**                         | Node binding exists; Rust crate path is the cleaner canonical path                        | ([npm][7])                      |
| `onnxruntime-node`       | Stable official Node binding                          | Prebuilt CPU binaries documented; suitable only for optional helper/L3                    | ([ONNX Runtime][8])             |
| USearch                  | Stable JS/Rust bindings                               | Disk-view / low-overhead ANN path verified                                                | ([Unum Cloud][9])               |
| `@ast-grep/napi`         | Node/N-API package exists                             | Useful optional addon, not core path for `codemem`                                        | ([Ast Grep][10])                |

### OpenCode v1.14.31 plugin surface, verified

The tagged plugin package exposes this shape at v1.14.31:

```ts
type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  experimental_workspace: { register(type: string, adaptor: WorkspaceAdaptor): void }
  serverUrl: URL
  $: BunShell
}

type Hooks = {
  event?: (input: { event: Event }) => Promise<void>
  tool?: Record<string, ToolDefinition>
  "chat.message"?: (input, output) => Promise<void>
  "chat.params"?: (input, output) => Promise<void>
  "permission.ask"?: (input, output) => Promise<void>
  "tool.execute.before"?: (input, output) => Promise<void>
  "tool.execute.after"?: (input, output) => Promise<void>
  "experimental.session.compacting"?: (input, output) => Promise<void>
  // ...other hooks
}
```

More specifically, `tool.execute.before` receives `{ tool, sessionID, callID }` plus mutable `{ args }`; `tool.execute.after` receives `{ tool, sessionID, callID, args }` plus mutable `{ title, output, metadata }`; `chat.message` receives `{ sessionID, agent?, model?, messageID?, variant? }` plus mutable `{ message, parts }`; `chat.params` can mutate `{ temperature, topP, topK, maxOutputTokens, options }`; `permission.ask` can set `{ status: "ask" | "deny" | "allow" }`; and `experimental.session.compacting` can append `context[]` or replace the compaction `prompt`. ([GitHub][1])

The tagged `tool` helper exposes a schema convenience (`tool.schema = z`), and a tool `execute(args, context)` context that includes `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata(...)`, and `ask(...)`. That is enough for `codemem_*` tools to be session-aware without poking undocumented internals. ([GitHub][11])

`sessionID` is propagated explicitly in tool hooks and tool execution context. For prompt injection, the documented SDK call is `client.session.prompt({ path: { id }, body: { noReply: true, parts } })`; the docs say `noReply: true` returns a `UserMessage` and injects context without producing an assistant reply. One nuance: the SDK docs currently mention both `format` and `outputFormat` for structured output, so I avoided depending on that surface in the plugin. ([GitHub][1])

OpenCode documents local project plugins under `.opencode/plugins/`, global plugins under `~/.config/opencode/plugins/`, and npm-based plugins that are installed with Bun and cached under `~/.cache/opencode/node_modules/`. I found no documented sandbox for plugins themselves; combined with the in-process runtime source, the practical reading is that plugins are trusted code with the same ambient rights as OpenCode. That is an inference, not a documented guarantee. ([OpenCode][12])

Direct answers to your operational questions:

* **Can a plugin safely spawn and supervise a daemon?** Yes, but only lazily and only with a short health/start path, because PluginInput includes Bun’s shell handle and Bun supports detached child processes, while awaited hooks run in-process and sequentially. ([GitHub][1])
* **What happens if a hook throws?** In the runtime’s `trigger` loop, awaited hooks are called sequentially without per-hook isolation, so an exception can propagate into the enclosing operation. Config hooks are explicitly wrapped/ignored during init. Event hooks are invoked with `void`, so they are fire-and-forget and their failures are not surfaced synchronously. ([GitHub][13])
* **Is plugin state long-lived across sessions?** Yes. Hooks are loaded once into instance state and reused until process/plugin reload. ([GitHub][13])
* **Are hooks concurrent?** Normal triggered hooks are sequential/deterministic. Event hooks can overlap because they are dispatched without awaiting. ([GitHub][13])
* **Can plugins introspect active sessions?** I did not verify a dedicated “list active sessions” plugin API in v1.14.31. The safe, verified surfaces are session IDs carried through hooks/events plus known-session SDK calls. ([GitHub][1])

I am **not** claiming an exhaustive authoritative list of breaking changes from 1.13.x to 1.14.31, because I did not find a clean official delta document for that exact span. The safe upgrade posture is to smoke-test plugins on every OpenCode minor bump. The changelog does show real hook/SDK movement inside the 1.x line, including execute-result metadata support and later typing fixes around `WorkspaceAdaptor.create(env)`. ([OpenCode][14])

### Bun v1.3.13 capability summary

`Bun.spawn` supports detached processes; Bun’s docs/blog describe detached children as separate process groups and note that fully detached backgrounding also depends on stdio configuration. Bun also supports Unix sockets via `Bun.listen({ unix })` and request/connect patterns over Unix sockets, while its Node-compat `net` surface covers IPC-style endpoints that are usable for named-pipe style transports on Windows. ([Bun][15])

Bun’s built-in SQLite API is mature enough for the plugin/supervisor side, but the daemon does not need it if you go Rust. Where SQLite concurrency matters, WAL mode gives concurrent readers with a single writer and snapshot-style reads, which fits the `codemem` daemon very well. ([Bun][16])

The parts I would **not** bet the core analyzer on in Bun 1.3.13 are the same ones that make a Bun-native daemon risky: Bun IPC is Bun-to-Bun only, `bun:ffi` is still documented as experimental, Workers are still marked experimental, Bun advertises broad but not perfect Node-API coverage, and `bun build --compile` works best when native addons are direct `.node` dependencies rather than wrappers like `node-pre-gyp`. ([Bun][17])

Concrete runtime recommendations:

* Use **Bun** for the OpenCode plugin, daemon supervisor, and small local clients.
* Use **Rust** for the canonical daemon.
* Do **not** make `bun:ffi` the canonical bridge.
* Do **not** make a Bun-native daemon depend on `oxc-parser` + `oxc-resolver` + `usearch` + `onnxruntime-node` + `@ast-grep/napi` as a default stack.
* Prefer **rusqlite** in the Rust daemon and **avoid `better-sqlite3`** entirely in the Bun path because Bun already ships `bun:sqlite`. ([npm][6])

## 3. Architecture decision

### Decision

| Path                                         | Decision      | Why                                                                            |
| -------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| A. Rust daemon + thin Bun/OpenCode plugin    | **Choose**    | Best isolation, most stable parser/resolver path, lowest hot-path risk         |
| B. Bun-native daemon                         | Reject for v1 | Too much dependence on Bun’s native-addon boundary for parser/resolver/ANN/ORT |
| C. Hybrid Bun supervisor + Rust core via FFI | Reject        | Highest complexity; still own Rust packaging plus an unstable ABI boundary     |

The decisive factor is not “Rust is faster” in the abstract. It is that OpenCode’s verified plugin runtime is in-process and sequential for awaited hooks, so every heavy dependency you move into the plugin/Bun runtime raises UX and install risk directly. A Rust sidecar gives you process isolation, a single-writer state owner, deterministic restart boundaries, and a clean place to host Oxc-based parsing/resolution without depending on Bun’s still-evolving native-addon story. ([GitHub][13])

### Thin plugin design

The plugin in the attached workspace follows the right shape for OpenCode:

* load config lazily
* create no indexes in plugin init
* lazily start/health-check the daemon only when a codemem tool runs or a write event needs enqueueing
* subscribe to `tool.execute.after` and file-related `event` traffic
* debounce changed files per session turn
* send **notifications**, not full indexing work, in hook paths
* optionally inject terse signals with `client.session.prompt({ noReply: true })`
* fail closed on tool calls with a bounded warning if the daemon is unavailable

The implementation is here:
[index.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/index.ts) · [supervisor.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/daemon/supervisor.ts) · [client.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/daemon/client.ts) · [tools.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/tools.ts)

Hot-path targets for v1:

* plugin init: **< 50 ms**
* `tool.execute.after` p99: **< 50 ms**
* changed-file enqueue: **< 10 ms**
* no parsing, embeddings, or full indexing in plugin hooks

## 4. Detector design

### Agent-facing output contract

The contract in [protocol.ts](sandbox:/mnt/data/codemem/packages/codemem-shared/src/protocol.ts) is compact and LLM-facing:

```ts
type CodeMemFinding =
  | SemanticCloneFinding
  | TypeShapeDuplicateFinding
  | ApiDriftFinding
  | DeadCodeFinding
  | CycleFinding
  | SessionConflictFinding
```

Every finding includes:

* `kind`
* `severity`
* `confidence`
* `evidence[]`
* `action`

Example:

```json
{
  "kind": "api_drift",
  "severity": "error",
  "confidence": 0.97,
  "exportName": "createUser",
  "sourceFile": "packages/api/src/users.ts",
  "before": "(input: CreateUserDTO) => Promise<User>",
  "after": "(input: CreateUserInput) => Promise<User>",
  "affectedCallers": ["apps/web/src/actions/create-user.ts"],
  "evidence": [
    { "kind": "signature", "file": "packages/api/src/users.ts", "detail": "baseline signature: ..." },
    { "kind": "signature", "file": "packages/api/src/users.ts", "detail": "current signature: ..." }
  ],
  "action": "Update callers, add compatibility shim, or intentionally refresh baseline."
}
```

Prompt injection is deliberately terse and bounded:

```xml
<codemem_signal>
- P1 api_drift: createUser changed from old to new; 4 callers still look stale.
- P2 semantic_clone: parseDuration and stringToMs likely duplicate behavior.
</codemem_signal>
```

That format is implemented by `buildPromptSignal()` in [protocol.ts](sandbox:/mnt/data/codemem/packages/codemem-shared/src/protocol.ts).

### Shipped now vs planned

**Shipped in code now**

* exact/parameterized normalized clone buckets
* near-miss SimHash clone buckets
* structural type-shape duplication
* import/export graph
* reachability / dead-code risk
* file/package cycles
* API drift against stored baseline
* multi-session conflict risk

**Planned / off by default**

* embedding-based L3 semantic clone detection
* ANN index files
* explicit baseline-accept CLI
* richer rename heuristics
* Oxc AST-walker replacement for the current lexical extractor

### L1 exact / parameterized clones

**Algorithm.** Target design is a normalized AST Merkle hash over function/block subtrees using Oxc parsing. In the attached code, I kept the file boundary ready for that, but the current implementation uses a pragmatic v0 path: Oxc can be used as the syntax gate, while the actual fingerprinting is done over extracted function blocks with normalized tokens and a canonical BLAKE3 hash. That keeps the protocol stable while isolating the exact Oxc AST-walker swap to one file later. Oxc’s stable March 2026 parser line exists and is the right long-term parser choice. ([GitHub][4])

**Pseudocode.**

```text
for each changed file:
  extract candidate blocks
  normalize identifiers -> ID, literals -> LIT, remove trivia
  hash normalized token stream with BLAKE3
  upsert clone_fingerprints
  emit finding when a non-trivial hash bucket has >= 2 members
```

**Schema.** `clone_fingerprints(file_path, symbol, normalized_hash, simhash, token_count, statement_count, start_line, end_line, normalized_tokens_json)`

**Incremental strategy.** Delete prior fingerprints for the changed file, recompute just that file, then re-evaluate only buckets touched by those hashes.

**Budget.** ~20–60 ms for a typical edited file; ~150 ms upper bound for a large 1–2k LOC file.

**Mitigation.** Ignore generated files, require at least 24 normalized tokens and 3 statements, suppress trivial accessors/tests/fixtures later, report only the top bucket representatives.

**Output.** `semantic_clone` with `detector: "l1_ast"` and evidence entries carrying hash and spans.

### L2 near-miss clones

**Algorithm.** SimHash over normalized token shingles, plus LSH banding to produce candidate pairs. The current code uses 64-bit SimHash, exact-token Jaccard verification, token-count ratio checks, and a Hamming-radius threshold.

**Defaults.**

* token normalization: identifiers → `ID`, literals → `LIT`, whitespace/comments removed
* shingle size: **4**
* SimHash width: **64**
* LSH banding: **4 bands × 16 bits**
* default Hamming radius: **6**
* candidate verification: token Jaccard ≥ **0.72**, token-count ratio ≥ **0.60**

**Pseudocode.**

```text
for each fingerprint:
  compute 64-bit simhash
  index by band signatures
for each candidate pair from same band:
  reject identical-hash pairs
  compute hamming distance
  verify token overlap and size ratio
  emit warning if confidence >= threshold
```

**Schema.** Reuses `clone_fingerprints`; no extra table needed in v1.

**Incremental strategy.** Re-index only changed-file fingerprints and re-check the touched bands.

**Budget.** ~5–25 ms per changed file after tokenization, plus bucketed candidate checks.

**Mitigation.** Same-file/self-symbol suppression, exact-hash suppression, token-size ratio gate, keep severity at `warn`.

**Output.** `semantic_clone` with `detector: "l2_simhash"`.

### L3 semantic clones

**Recommendation.** Keep L3 **off by default** in v1. When you enable it, my default model choice is **`jinaai/jina-code-embeddings-0.5b`**, with **USearch** as the ANN layer. Jina’s code-embedding line is explicitly code-retrieval-focused and offers small specialized models with quantization story; Qwen3 Embedding is broader-purpose and code-capable; CodeRankEmbed is compact and strong for code retrieval, but I would still choose Jina first for a cross-language TypeScript-centric local default. GraphCodeBERT remains a useful historical baseline, not the default March 2026 choice I would ship here. ([Jina AI][18])

**Inference path.** Do **not** put embeddings in the OpenCode plugin. Also do **not** bake them into the canonical Rust daemon in v1. The cleanest first shipping path is an **optional helper process** for embeddings. If you insist on local Node-side inference, `onnxruntime-node` is the least-bad official route because it ships prebuilt CPU binaries, but this should stay optional and non-default. ([ONNX Runtime][8])

**Defaults.**

* min function size: **60 normalized tokens**
* candidate K: **16**
* cosine threshold: **0.88**
* severity: `warn` until reinforced by L1/L2 or graph evidence
* cache key: content hash of normalized body + model ID

**Pseudocode.**

```text
if semanticClones enabled:
  for changed file blocks without embedding cache hit:
    embed normalized body
    upsert vector
  for each changed vector:
    query top-K ANN
    verify size/symbol/path diversity
    calibrate confidence from cosine + structural overlap
```

**Schema.** Future `embeddings(file_path, symbol, model, digest, vector_ref)` + `ann/semantic.usearch`.

**Incremental strategy.** Only embed changed content hashes; unchanged hashes are cache hits.

**Budget.** Cache hit: near-zero. Local CPU cache miss: target **150–500 ms per block** depending on model and quantization.

**Mitigation.** Off by default, minimum-size gate, same-package suppression, combine with graph/type evidence, bounded findings.

### L4 type-shape hashing

**Recommendation.** Do **not** depend on tsgo for v1 type-shape work. Official TypeScript material still described the native compiler line as preview/native-preview in March 2026, and open issues show the checker/programmatic API still being shaped. For `codemem` v1, use **syntactic structural hashing** now; if you later need deeper semantic expansion, add a TypeScript compiler adapter behind an experimental flag. ([Microsoft for Developers][5])

**Shape normalization.**

* property vs method canonicalized separately
* `readonly` and `optional` preserved
* named generic types normalized to `T`
* builtins preserved (`string`, `number`, `Promise`, etc.)
* union and intersection members sorted/deduped
* common tiny shapes suppressed
* current code estimates nested depth and stores it, but does not recursively expand cross-file type aliases; that is a later upgrade

**Pseudocode.**

```text
for each interface/type/class literal:
  canonicalize member signatures
  sort + dedupe members
  hash canonical member list with BLAKE3
  bucket by shape_hash
  emit if >= 2 distinct symbols share a non-suppressed shape
```

**Schema.** `type_shapes(file_path, symbol, shape_hash, fingerprint_json, depth, suppressed)`

**Incremental strategy.** Replace rows for changed file only.

**Budget.** ~5–30 ms per typical file.

**Mitigation.** Suppress <3-member shapes and common patterns, keep severity at `warn`, require at least two distinct symbols/files.

**Output.** `type_shape_duplicate`.

### Symbol graph, dead code, cycles

**Resolver choice.** Long term, use **Oxc Resolver** in the Rust daemon because it is built for Node/webpack-style resolution and tsconfig/path alias semantics. The current attached code uses a deliberately conservative resolver with ts/js/tsx/jsx/index fallback and config-supplied package boundaries. That keeps v1 simple while leaving a clean upgrade point. ([Oxc][19])

**Graph design.**

* nodes: files, exported symbols, package boundaries
* edges: static imports/exports, dynamic-import soft edges, duplicate links, session overlaps
* entrypoints: config-driven glob expansion
* dead code: reverse reachability from entrypoints
* cycles: Tarjan SCC on file graph, then package-level aggregation
* dynamic imports: never hard-delete; mark `dynamicImportRisk: true` and lower confidence

**Pseudocode.**

```text
on changed file:
  extract imports and public exports
  update forward/reverse adjacency
  recompute SCCs for affected region
  recompute reachability from entrypoints
  diff exports against baseline
```

**Schema.** `imports(from_path, raw_specifier, to_path, is_dynamic)` and `public_exports(source_file, export_name, signature)`.

**Budget.** Single-file update: **10–40 ms**; full graph refresh at 100k LOC: target **< 1.5 s** without embeddings.

**Mitigation.** Dynamic imports only soften findings, not hard-block them. Dead code from dynamic zones is `info`/`warn`, not `error`.

### API drift

**Algorithm.**

* snapshot public exports/signatures as baseline
* on later scans, compare same `(exportName, sourceFile)` pairs
* emit `api_drift` on change/remove
* scan reverse dependents for affected callers

**Signature canonicalization.**

* normalize whitespace/comments
* normalize inline type names where possible
* preserve arity, parameter names when public contract matters, return type

**Rename heuristic.**

* recommended but **not yet implemented** in the attached code
* pair removed and added exports in the same file/package when signature similarity > 0.85 and reverse dependents overlap

**Baseline workflow.**

* current code auto-bootstraps baseline on the first scan if none exists
* recommended follow-up: explicit `codemem baseline accept` command before public rollout

**Output.** `api_drift` with before/after signatures and bounded `affectedCallers[]`.

### Session conflict risk

**Observation path.** OpenCode already propagates `sessionID` through tool hooks and several chat hooks, and its event stream includes file/session activity. That is enough for the plugin to report touched files to the daemon without any undocumented session introspection. ([GitHub][1])

**Algorithm.**

* track touched files per session with timestamps
* compute a bounded dependency cone around the touched set
* score overlap between active sessions
* decay stale sessions after configurable timeout

**Defaults.**

* cone depth: **2 hops**
* overlap threshold: **0.25**
* decay: **15 min**
* max alerted sessions per check: **8**

**Mitigation.** Only alert on overlap beyond threshold, suppress self-overlap, expire idle sessions quickly, keep severity at `warn`.

**Output.** `session_conflict`.

## 5. Persistence design

### On-disk layout

Default state directory:

* Git repo: `.git/codemem`
* non-Git repo: `.codemem`

Recommended layout:

```text
.git/codemem/
  codemem.sqlite3
  run/
    codemem.sock        # POSIX
    daemon.pid
    daemon.token
  ann/
    semantic.usearch    # only when L3 enabled
  log/
    events.ndjson       # optional rotated mirror; canonical store is SQLite in v1
```

The attached code’s canonical state is SQLite, with future ANN files reserved under `ann/`.

### SQLite schema

Implemented tables in [store.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/store.rs):

* `files`
* `imports`
* `public_exports`
* `clone_fingerprints`
* `type_shapes`
* `api_baseline`
* `sessions`
* `findings_cache`
* `event_log`

Why SQLite:

* one daemon owns writes
* WAL mode matches “many readers / one writer”
* durable local state with simple corruption recovery
* easy maintenance/compaction story

WAL is the right choice here because SQLite explicitly documents WAL’s concurrent-reader/single-writer model and snapshot reads, which matches the sidecar pattern well. ([SQLite][20])

### Atomicity, versioning, corruption recovery

* protocol version: `1`
* schema version: `1`
* DB writes wrapped in transactions
* stale PID/socket/token cleanup on startup
* rebuild trigger when protocol/schema mismatch, missing files, or DB open fails
* `maintenance.rebuild` returns a machine-readable reason
* `maintenance.maintain` supports dry-run/apply

### Memory targets

These are design targets, not measured results:

| Repo size | Steady daemon RSS (embeddings off) | Notes                                      |
| --------- | ---------------------------------: | ------------------------------------------ |
| 100K LOC  |                         120–180 MB | SQLite + in-memory graph + clone buckets   |
| 500K LOC  |                         300–500 MB | still fine on laptop-class machines        |
| 1M LOC    |                         600–900 MB | package-boundary pruning becomes important |

Mmap/page-cache strategy:

* let SQLite and future USearch ANN files lean on OS page cache
* avoid keeping all normalized bodies in resident memory
* keep hot maps in memory, cold artifacts on disk

### Configuration

The implemented schema is in [config.ts](sandbox:/mnt/data/codemem/packages/codemem-shared/src/config.ts), with an example at [codemem.config.example.jsonc](sandbox:/mnt/data/codemem/codemem.config.example.jsonc).

Representative config:

```jsonc
{
  "entrypoints": ["src/index.ts", "apps/*/src/main.ts"],
  "ignore": ["dist/**", "node_modules/**", "**/*.generated.ts"],
  "packageBoundaries": [{ "root": "packages/api", "name": "api", "kind": "package" }],
  "layers": {
    "astClones": true,
    "simhashClones": true,
    "semanticClones": false,
    "typeShapes": true,
    "symbolGraph": true,
    "apiDrift": true,
    "sessionConflicts": true,
    "dynamicDeadCode": true
  },
  "thresholds": {
    "semanticCloneCosine": 0.88,
    "simhashHammingRadius": 6
  },
  "embedding": {
    "enabled": false,
    "provider": "local",
    "model": "jinaai/jina-code-embeddings-0.5b",
    "inference": "disabled"
  }
}
```

### Observability and cleanup

Implemented RPC methods:

* `health`
* `maintenance.status`
* `maintenance.maintain`
* `maintenance.rebuild`

Recommended user-facing commands:

* `codemem status`
* `codemem maintain --dry-run`
* `codemem maintain --apply --prune-logs --compact`
* `codemem rebuild --dry-run`
* `codemem rebuild --apply`

The attached code implements the RPC layer for these commands. A thin CLI wrapper is still a follow-on task, not part of the minimum requested file set.

## 6. IPC protocol

**Choice:** local stream socket, not HTTP, not stdio, not SQLite-as-bus.

**Why this one**

* works with a long-lived reusable daemon
* easy reconnect/health-check
* lower exposure than localhost HTTP
* avoids stdio ownership issues once the daemon is detached
* trivial to debug with JSON

**Transport**

* POSIX: Unix domain socket in `state/run/codemem.sock`
* Windows: named pipe branch in daemon/server code
* auth token in `state/run/daemon.token`
* PID file in `state/run/daemon.pid`

**Wire format**

* JSON envelopes
* 4-byte big-endian length prefix
* request IDs on requests only
* notifications for `project.filesChanged`

**Envelope**

* `jsonrpc: "2.0"`
* `protocolVersion`
* `id`
* `authToken`
* `method`
* `params`
* `result | error`

**Error envelope**

```ts
type RpcErrorEnvelope = {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}
```

**Timeouts**

* health: 250 ms target
* ordinary request: 3 s default
* spawn timeout: 2.5 s

**Retries**

* retry health/connect once
* do not blindly retry mutating requests
* `project.filesChanged` is fire-and-forget from plugin hooks

**Backpressure**

* one-request-per-connection client behavior in plugin
* hard payload cap: 4 MiB
* reject oversized frames early

**Version negotiation**

* reject protocol mismatch
* return schema/protocol in health response

**Multi-project handling**

* one daemon per project root / state dir
* simpler locking, simpler cache ownership, simpler cleanup

Implemented code:
[protocol.ts](sandbox:/mnt/data/codemem/packages/codemem-shared/src/protocol.ts) · [client.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/daemon/client.ts) · [rpc.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/rpc.rs)

## 7. Full implementation files

Full workspace: [codemem workspace zip](sandbox:/mnt/data/codemem.zip)

### Plugin

* [packages/codemem-plugin/src/index.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/index.ts)
* [packages/codemem-plugin/src/daemon/supervisor.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/daemon/supervisor.ts)
* [packages/codemem-plugin/src/daemon/client.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/daemon/client.ts)
* [packages/codemem-plugin/src/tools.ts](sandbox:/mnt/data/codemem/packages/codemem-plugin/src/tools.ts)

### Shared

* [packages/codemem-shared/src/protocol.ts](sandbox:/mnt/data/codemem/packages/codemem-shared/src/protocol.ts)
* [packages/codemem-shared/src/config.ts](sandbox:/mnt/data/codemem/packages/codemem-shared/src/config.ts)

### Daemon

* [packages/codemem-daemon/src/main.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/main.rs)
* [packages/codemem-daemon/src/rpc.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/rpc.rs)
* [packages/codemem-daemon/src/indexer.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/indexer.rs)
* [packages/codemem-daemon/src/detectors/clones.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/detectors/clones.rs)
* [packages/codemem-daemon/src/detectors/types.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/detectors/types.rs)
* [packages/codemem-daemon/src/graph.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/graph.rs)
* [packages/codemem-daemon/src/store.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/store.rs)
* [packages/codemem-daemon/src/session_conflicts.rs](sandbox:/mnt/data/codemem/packages/codemem-daemon/src/session_conflicts.rs)

### Root / docs

* [codemem.config.example.jsonc](sandbox:/mnt/data/codemem/codemem.config.example.jsonc)
* [package.json](sandbox:/mnt/data/codemem/package.json)
* [README.md](sandbox:/mnt/data/codemem/README.md)

### Helper files included to make the TS sample compile here

* [types/opencode-plugin.d.ts](sandbox:/mnt/data/codemem/types/opencode-plugin.d.ts)
* [types/zod.d.ts](sandbox:/mnt/data/codemem/types/zod.d.ts)
* [types/node-shim.d.ts](sandbox:/mnt/data/codemem/types/node-shim.d.ts)

Those shims exist because the published `@opencode-ai/plugin` package has had real packaging/export/version issues in 1.x. The shims mirror the verified v1.14.31 source surface and should be replaced by the real package once your exact OpenCode install path is validated. ([GitHub][21])

## 8. Install/distribution plan

Recommend shipping `codemem` as an **npm plugin package** for usability, with a tiny local `.opencode/plugins/codemem.ts` stub that imports it. OpenCode already supports local project/global plugins and npm-installed plugins, and npm plugins are installed through Bun at startup, so the community path should be “install package, add one-line stub, let the plugin resolve the daemon binary.” ([OpenCode][12])

Recommended package layout:

* `@codemem/plugin` — pure JS/TS plugin + shared protocol
* `@codemem/daemon-darwin-arm64`
* `@codemem/daemon-darwin-x64`
* `@codemem/daemon-linux-x64-gnu`
* `@codemem/daemon-linux-arm64-gnu`
* `@codemem/daemon-win32-x64-msvc`

The plugin should declare the platform daemon packages as **optional dependencies** and resolve the correct binary by platform/arch. Avoid networked postinstall downloads. Because OpenCode installs npm plugins on startup, startup-time network fetchers or heavy postinstalls are the wrong UX and increase failure modes. ([OpenCode][12])

Distribution details:

* first run: lazy daemon start and cold index
* version checks: plugin verifies daemon `protocolVersion` + `schemaVersion`
* state location: `.git/codemem` by default
* uninstall cleanup: delete state dir; nothing else global
* OpenCode config: local project stub remains the least-surprising install surface

Because the OpenCode package layer has seen export/types/workspace-resolution issues, I would pin OpenCode and `codemem` together in CI and run a smoke test that exercises plugin loading, one codemem tool, and prompt injection on every OpenCode upgrade. ([GitHub][21])

## 9. Performance/eval plan

### Performance targets

| Operation                           |              Target |
| ----------------------------------- | ------------------: |
| plugin init                         |             < 50 ms |
| hook path p99                       |             < 50 ms |
| changed file index                  |      150–300 ms p95 |
| `codemem_check` p95, embeddings off | < 1.5 s at 100K LOC |
| `codemem_check` p95, embeddings on  |   < 5 s at 100K LOC |
| daemon steady RSS, 100K LOC         |          120–180 MB |
| daemon steady RSS, 1M LOC           |          600–900 MB |

### Benchmark repos

Use:

* TypeScript compiler
* VS Code
* Next.js
* Angular
* Prisma
* TanStack Router or Query
* a synthetic AI-agent duplication corpus

### Scenarios

Measure:

* cold index
* hot edit
* batch edit
* daemon restart
* concurrent sessions
* large monorepo package-boundary checks
* dynamic import zones
* embedding cache miss vs hit

### Evaluation metrics

* clone detection precision / recall
* type-shape duplicate precision
* API drift known-change tests
* dead-code false-positive rate
* cycle detection correctness
* agent usefulness score: “did this finding change a plan/review decision?”
* prompt injection nuisance rate

## 10. Risk register

| Risk                               | Why it is real                                                               | Mitigation                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OpenCode API/package instability   | 1.x plugin/package surface is active and publishing issues have happened     | Compile against tagged source, keep local shims until install path is proven, smoke-test every OpenCode bump. ([GitHub][21]) |
| Bun native-addon boundary          | Bun supports most, not all, Node-API; FFI and Workers are still experimental | Keep Bun thin; no canonical heavy analysis core in Bun. ([Bun][22])                                                          |
| tsgo churn                         | Native TS compiler line still preview/unstable for programmatic use          | Do not depend on tsgo in v1. ([Microsoft for Developers][5])                                                                 |
| Daemon lifecycle bugs              | stale PID/socket/token, orphaned child                                       | auth token, PID file, stale cleanup, health RPC, supervisor backoff                                                          |
| Embedding latency                  | local model miss can be slow                                                 | off by default, cache by content hash, helper process, bounded batch size                                                    |
| False positives                    | clone/type/dead-code heuristics can be noisy                                 | min-size gates, suppression rules, warn severities, bounded evidence                                                         |
| Prompt pollution                   | too many signals can degrade agent performance                               | cooldown, severity threshold, max signals per turn                                                                           |
| Index corruption                   | SQLite/db/socket state can be interrupted                                    | WAL, transactions, rebuild RPC, atomic cleanup                                                                               |
| Multi-session races                | overlapping edits are the problem `codemem` is trying to see                 | single daemon writer, session decay, dependency-cone overlap instead of raw file overlap                                     |
| Cross-platform binary distribution | Rust prebuilds are operationally heavier than TS-only                        | optional per-platform packages, no networked postinstall                                                                     |
| Security/trust model               | OpenCode plugins are effectively trusted local code                          | keep plugin minimal, local-only telemetry, no cloud embeddings by default                                                    |
| Privacy                            | code embeddings or telemetry could leak code if mishandled                   | local-only by default, structured local logs, explicit opt-in for remote providers                                           |

## 11. Roadmap

The attached workspace already covers milestones 1–9 and 11 in a first production-shaped pass, with 10/12/13/14 still open.

| Milestone                                 | Key files                            | Tests                                   | Acceptance criteria                                 | Perf target                       |
| ----------------------------------------- | ------------------------------------ | --------------------------------------- | --------------------------------------------------- | --------------------------------- |
| 1. Plugin skeleton and daemon supervision | plugin `index.ts`, `supervisor.ts`   | lazy start, stale socket, spawn failure | plugin loads and returns in-process fast            | init < 50 ms                      |
| 2. IPC protocol and health checks         | `protocol.ts`, `client.ts`, `rpc.rs` | framing, auth, mismatch, timeout        | health succeeds and version mismatch fails clearly  | health < 250 ms                   |
| 3. Incremental file indexing              | `indexer.rs`, `store.rs`             | add/change/delete file flows            | only changed file rows are replaced                 | hot edit < 300 ms                 |
| 4. L1 exact clone detector                | `detectors/clones.rs`                | exact clone corpus                      | identical normalized blocks are bucketed            | detector pass < 60 ms/file        |
| 5. Symbol graph and cycles                | `graph.rs`                           | SCC fixtures, entrypoint reachability   | file and package cycles reported                    | graph refresh < 1.5 s @100K LOC   |
| 6. API baseline/drift                     | `graph.rs`, `store.rs`               | signature-change fixtures               | before/after + reverse dependents appear            | included in normal check          |
| 7. Type-shape hashing                     | `detectors/types.rs`                 | DTO duplication fixtures                | equivalent shapes bucket together                   | < 30 ms/file                      |
| 8. Session conflict tracker               | `session_conflicts.rs`               | overlap/decay fixtures                  | only meaningful overlaps alert                      | < 20 ms/check                     |
| 9. L2 SimHash                             | `detectors/clones.rs`                | near-miss clone corpus                  | non-identical duplicates surface as warns           | < 25 ms/file after tokenize       |
| 10. L3 embeddings + ANN                   | future `embeddings.rs`/helper        | retrieval benchmark + cache-hit tests   | semantic duplicates improve recall without flooding | cache hit near-zero, miss bounded |
| 11. Agent tools + prompt injection        | `tools.ts`, `index.ts`               | tool schema + noReply injection         | tools return bounded JSON; injections are terse     | tool p95 < 1.5 s no embeddings    |
| 12. Telemetry/maintenance CLI             | future CLI wrapper                   | dry-run/apply, prune, rebuild           | maintenance commands usable from shell              | no startup penalty                |
| 13. Packaging + prebuilt binaries         | npm/package infra                    | install matrix on 5 targets             | install works offline from registry only            | first-run start < 2.5 s           |
| 14. Benchmark/eval suite                  | future bench harness                 | corpus regression CI                    | metrics tracked per release                         | full bench under CI budget        |

## 12. Open questions that require human decision

1. **API baseline UX:** should baseline creation be automatic on first run, or explicit via a human-reviewed `accept-baseline` command?
2. **L3 in first public release:** do you want embeddings present-but-off, or omitted entirely until the ANN/runtime story is benchmarked?
3. **Cloud embeddings:** should remote embedding providers exist at all, given privacy and deterministic-local-workflow goals?
4. **Prompt injection policy:** should `codemem` inject signals every turn, only on tool invocation, or never by default?
5. **Package boundaries:** should boundaries come only from config, or should `package.json`/workspace manifests auto-seed them?
6. **Windows support bar:** do you want Windows named-pipe support in v1.0, or is it acceptable to land as v1.1 once cargo-verified in CI?
7. **L1 AST strictness:** should the next step replace the lexical block extractor immediately with a full Oxc AST Merkle walker, or is the current exact/near-miss v0 path acceptable for the first beta?

[1]: https://github.com/anomalyco/opencode/blob/v1.14.31/packages/plugin/src/index.ts "https://github.com/anomalyco/opencode/blob/v1.14.31/packages/plugin/src/index.ts"
[2]: https://github.com/anomalyco/opencode/releases?utm_source=chatgpt.com "Releases · anomalyco/opencode - GitHub"
[3]: https://bun.com/blog/bun-v1.3.13 "https://bun.com/blog/bun-v1.3.13"
[4]: https://github.com/oxc-project/oxc/tags?after=oxlint_v1.60.0 "https://github.com/oxc-project/oxc/tags?after=oxlint_v1.60.0"
[5]: https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/ "https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/"
[6]: https://www.npmjs.com/package/oxc-parser "https://www.npmjs.com/package/oxc-parser"
[7]: https://www.npmjs.com/package/oxc-resolver "https://www.npmjs.com/package/oxc-resolver"
[8]: https://onnxruntime.ai/docs/get-started/with-javascript/node.html "https://onnxruntime.ai/docs/get-started/with-javascript/node.html"
[9]: https://unum-cloud.github.io/USearch/ "https://unum-cloud.github.io/USearch/"
[10]: https://ast-grep.github.io/reference/api.html "https://ast-grep.github.io/reference/api.html"
[11]: https://raw.githubusercontent.com/anomalyco/opencode/v1.14.31/packages/plugin/src/tool.ts "https://raw.githubusercontent.com/anomalyco/opencode/v1.14.31/packages/plugin/src/tool.ts"
[12]: https://opencode.ai/docs/plugins/ "https://opencode.ai/docs/plugins/"
[13]: https://github.com/anomalyco/opencode/blob/v1.14.31/packages/opencode/src/plugin/index.ts "https://github.com/anomalyco/opencode/blob/v1.14.31/packages/opencode/src/plugin/index.ts"
[14]: https://opencode.ai/changelog "OpenCode | Changelog"
[15]: https://bun.com/reference/bun/spawn "https://bun.com/reference/bun/spawn"
[16]: https://bun.com/reference/bun/sqlite "https://bun.com/reference/bun/sqlite"
[17]: https://bun.com/docs/runtime/child-process "https://bun.com/docs/runtime/child-process"
[18]: https://jina.ai/news/jina-code-embeddings-sota-code-retrieval-at-0-5b-and-1-5b/ "https://jina.ai/news/jina-code-embeddings-sota-code-retrieval-at-0-5b-and-1-5b/"
[19]: https://oxc.rs/docs/guide/usage/resolver.html "https://oxc.rs/docs/guide/usage/resolver.html"
[20]: https://sqlite.org/wal.html "https://sqlite.org/wal.html"
[21]: https://github.com/anomalyco/opencode/issues/2678 "https://github.com/anomalyco/opencode/issues/2678"
[22]: https://bun.com/reference/bun/ffi "https://bun.com/reference/bun/ffi"

# Contributing to @codemem/plugin

This plugin runs inside opencode as a tool provider with a long-lived daemon subprocess. Authoring rules are stricter than for an ordinary npm package because mistakes can crash opencode itself, not just codemem.

## Setup

```bash
bun install
bun run verify    # lint + typecheck + tests + build + package
```

## Authoring rules

### Tool args must be a `ZodRawShape` literal, not a `ZodObject`

```ts
// GOOD
import { tool } from "@opencode-ai/plugin";
const z = tool.schema;

const myTool = tool({
  description: "...",
  args: { foo: z.string(), count: z.number().optional() },
  async execute(args) { /* ... */ },
});
```

```ts
// BAD — opencode iterates Object.keys(args) and dereferences method.._zod.def → TypeError
args: z.object({ foo: z.string(), count: z.number().optional() })
```

This bug shipped to production once and caused intermittent crashes via opencode's Effect pipeline when the daemon child process exited mid-orchestrator-flow. `bun run lint:no-zod` enforces the boundary import rule. The `bun run check` script (TODO add) should also include this lint.

### Use `tool.schema`, not `import { z } from "zod"`

`bun run lint:no-zod` enforces this in plugin boundary files.

### TypeScript strict mode catches the args bug at compile time

The codemem-plugin tsconfig should have `strict: true` and the `tool()` helper's signature `<Args extends z.ZodRawShape>` will reject `z.object()` at compile time. If your tsconfig is loose, the bug ships at runtime. Always typecheck via `bun run typecheck` before committing.

### Daemon subprocess lifecycle

The codemem daemon is spawned as a child process. When it exits, opencode receives the result via Effect. Defensive practices:

- Always return from `execute` with a string or `{output, metadata}` shape.
- Never throw from `execute` if you can avoid it — wrap with try/catch and return error JSON.
- The `@mazac-fox/opencode-host-adapter` wrapper would catch thrown errors automatically, but codemem currently doesn't use it. Consider adopting it.

## Versioning

`.opencode-plugin-version` tracks the `@opencode-ai/plugin` version this package was built against.

## Debugging

See the runbook at `~/.config/opencode/runbooks/plugin-broken.md`.

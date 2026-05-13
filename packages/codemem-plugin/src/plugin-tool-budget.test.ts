import { describe, expect, test } from "bun:test";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { applyToolSurfaceBudget, resolveCodememPluginToolSurfaceMaxChars } from "./plugin-tool-budget";
import type { CodeMemConfig } from "@codemem/shared/config";

const z = tool.schema;

function measureAll(tools: Record<string, ToolDefinition>): number {
  let n = 0;
  for (const def of Object.values(tools)) {
    const schema = z.object(def.args);
    n += def.description.length + JSON.stringify(z.toJSONSchema(schema)).length;
  }
  return n;
}

const minimalConfig: CodeMemConfig = {
  entrypoints: ["src/index.ts"],
  ignore: [],
  packageBoundaries: [],
  layers: {
    astClones: true,
    simhashClones: true,
    typeShapes: true,
    symbolGraph: true,
    apiDrift: true,
    sessionConflicts: true,
    dynamicDeadCode: true,
  },
  thresholds: {
    minCloneTokens: 24,
    minCloneStatements: 3,
    simhashHammingRadius: 6,
    maxFindings: 50,
    typeShapeMinMembers: 3,
    sessionConflictOverlap: 0.25,
    sessionConflictDecayMs: 900_000,
    promptInjectionMinConfidence: 0.8,
  },
  daemon: {
    maxPayloadBytes: 4_194_304,
    healthTimeoutMs: 250,
    requestTimeoutMs: 3000,
    spawnTimeoutMs: 2500,
  },
  telemetry: {
    enabled: true,
    retainDays: 14,
    maxLogBytes: 8_388_608,
    structuredLocalOnly: true,
  },
  promptInjection: {
    enabled: true,
    mode: "turn",
    minSeverity: "warn",
    maxSignalsPerTurn: 4,
    cooldownMs: 2000,
  },
  maxFindings: 50,
  pluginToolSurfaceMaxChars: 40_000,
};

describe("resolveCodememPluginToolSurfaceMaxChars", () => {
  test("prefers CODEMEM_TOOL_SURFACE_MAX_CHARS when valid", () => {
    const prev = process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS;
    try {
      process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS = "900";
      expect(resolveCodememPluginToolSurfaceMaxChars(minimalConfig)).toBe(900);
    } finally {
      if (prev === undefined) delete process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS;
      else process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS = prev;
    }
  });

  test("falls back to config", () => {
    const prev = process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS;
    try {
      delete process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS;
      expect(resolveCodememPluginToolSurfaceMaxChars(minimalConfig)).toBe(40_000);
    } finally {
      if (prev !== undefined) process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS = prev;
    }
  });
});

describe("applyToolSurfaceBudget", () => {
  test("truncates descriptions to meet budget", () => {
    const pad = "y".repeat(5000);
    const tools: Record<string, ToolDefinition> = {
      a: tool({
        description: `${pad} a`,
        args: { q: z.string() },
        async execute() {
          return "ok";
        },
      }),
      b: tool({
        description: `${pad} b`,
        args: { q: z.string() },
        async execute() {
          return "ok";
        },
      }),
    };
    const out = applyToolSurfaceBudget(tools, 3000);
    const oa = out.a;
    const ob = out.b;
    expect(oa).toBeDefined();
    expect(ob).toBeDefined();
    if (oa === undefined || ob === undefined) throw new Error("missing");
    expect(oa.description.includes("truncated codemem tools") || ob.description.includes("truncated codemem tools")).toBe(
      true,
    );
    expect(measureAll(out)).toBeLessThanOrEqual(3000);
  });
});

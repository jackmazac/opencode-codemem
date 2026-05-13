import { describe, expect, test } from "bun:test";
import { defaultCodeMemConfig } from "@mazac-fox/codemem-shared/config";
import { createCodeMemTools, type CodeMemToolRuntime } from "./tools";

const toolCases = [
  { name: "codemem_check", args: { maxFindings: 1 } },
  { name: "codemem_drift_map", args: { maxFindings: 1 } },
  { name: "codemem_conflicts", args: {} },
  { name: "codemem_change_risk", args: { paths: ["src/index.ts"], maxFindings: 1 } },
  { name: "codemem_before_edit", args: { paths: ["src/index.ts"], maxFindings: 1 } },
  {
    name: "codemem_review_focus",
    args: { paths: ["src/index.ts"], maxFindings: 1, maxItems: 1 },
  },
  { name: "codemem_api_surface", args: { maxExports: 1 } },
  { name: "codemem_impact_cone", args: { path: "src/index.ts" } },
  { name: "codemem_layer_boundaries", args: { maxFindings: 1 } },
  { name: "codemem_artifact", args: { kind: "audit", maxFindings: 1, dryRun: true } },
];

describe("tool error envelopes", () => {
  test("all tools return stable degraded JSON when daemon readiness fails", async () => {
    const tools = createCodeMemTools(failingRuntime());

    for (const toolCase of toolCases) {
      const toolDefinition = tools[toolCase.name];
      if (!toolDefinition) throw new Error(`${toolCase.name} was not registered`);

      const result: unknown = await Reflect.apply(toolDefinition.execute, undefined, [
        toolCase.args,
        {
          sessionID: "session-a",
          messageID: "message-a",
          callID: "call-a",
          metadata() {},
        },
      ]);
      const payload = parseToolPayload(result);

      expect(readString(payload, "status")).toBe("degraded");
      expect(readBoolean(payload, "degraded")).toBe(true);
      const error = readRecord(payload, "error");
      expect(readString(error, "code")).toBe("E_CODEMEM_DAEMON_TIMEOUT");
      expect(readBoolean(error, "retryable")).toBe(true);
      expect(readString(error, "message")).toContain("codemem request timeout");
    }
  });
});

function failingRuntime(): CodeMemToolRuntime {
  return {
    projectRoot: "/repo",
    async getConfig() {
      return { path: null, config: defaultCodeMemConfig() };
    },
    async ensureReady() {
      throw new Error("codemem request timeout after 5ms");
    },
    async maybeInjectSignals() {},
  };
}

function parseToolPayload(result: unknown): Record<string, unknown> {
  const output = readToolOutput(result);
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error("tool payload was not an object");
  return parsed;
}

function readToolOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result)) throw new Error("tool result was not an object");
  if (typeof result.output !== "string") throw new Error("tool result output was not a string");
  return result.output;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`${key} was not an object`);
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} was not a string`);
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${key} was not a boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

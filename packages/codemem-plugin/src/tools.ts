import { compareSeverity, type CheckResponse, type CodeMemFinding } from "@codemem/shared/protocol";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { LoadedCodeMemConfig } from "@codemem/shared/config";
import type { DaemonClient } from "./daemon/client";

export type CodeMemToolRuntime = {
  projectRoot: string;
  getConfig(): Promise<LoadedCodeMemConfig>;
  ensureReady(options?: { waitForReady: boolean }): Promise<DaemonClient>;
  maybeInjectSignals(sessionID: string, findings: CodeMemFinding[]): Promise<void>;
};

const z = tool.schema;

export function createCodeMemTools(runtime: CodeMemToolRuntime): Record<string, ToolDefinition> {
  return {
    codemem_check: tool({
      description:
        "Run codemem semantic drift analysis for the current project and return compact JSON findings.",
      args: z.object({
        maxFindings: z.number().int().min(1).max(200).default(50),
        includeEvidence: z.boolean().default(true),
        waitForFreshIndex: z.boolean().default(false),
        paths: z.array(z.string()).optional(),
      }),
      async execute(args: {
        maxFindings?: number;
        includeEvidence?: boolean;
        waitForFreshIndex?: boolean;
        paths?: string[];
      }, context) {
        context.metadata({ title: "codemem check" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.check({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            paths: args.paths,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
            includeEvidence: args.includeEvidence ?? true,
            waitForFreshIndex: args.waitForFreshIndex ?? false,
          });
          await runtime.maybeInjectSignals(context.sessionID, response.findings);
          return {
            output: serializeResponse(response),
            metadata: summarizeCheckResponse(response),
          };
        } catch (error) {
          return {
            output: JSON.stringify({
              error: String(error),
              advice:
                "Ensure codemem-daemon is installed and configured. The plugin intentionally fails closed for direct codemem tool calls.",
            }),
          };
        }
      },
    }),

    codemem_drift_map: tool({
      description:
        "Return a compact graph of drift-relevant nodes and edges for LLM planning and refactoring.",
      args: z.object({
        maxFindings: z.number().int().min(1).max(200).default(50),
      }),
      async execute(args: { maxFindings?: number }, context) {
        context.metadata({ title: "codemem drift map" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.driftMap({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
          });
          await runtime.maybeInjectSignals(context.sessionID, response.map.findings);
          return {
            output: JSON.stringify(response),
            metadata: {
              nodes: response.map.nodes.length,
              edges: response.map.edges.length,
              findings: response.map.findings.length,
            },
          };
        } catch (error) {
          return { output: JSON.stringify({ error: String(error) }) };
        }
      },
    }),

    codemem_conflicts: tool({
      description:
        "Return concurrent-session conflict risk for overlapping dependency cones in the current project.",
      args: z.object({
        includeInfo: z.boolean().default(false),
      }),
      async execute(args: { includeInfo?: boolean }, context) {
        context.metadata({ title: "codemem conflicts" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const response = await client.conflicts({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
          });
          const filtered = args.includeInfo
            ? response.findings
            : response.findings.filter((finding) => compareSeverity(finding.severity, "warn") >= 0);
          await runtime.maybeInjectSignals(context.sessionID, filtered);
          return {
            output: JSON.stringify({ ...response, findings: filtered }),
            metadata: { findings: filtered.length },
          };
        } catch (error) {
          return { output: JSON.stringify({ error: String(error) }) };
        }
      },
    }),
  };
}

function summarizeCheckResponse(response: CheckResponse): Record<string, number | boolean> {
  return {
    findings: response.findings.length,
    truncated: response.truncated,
    cloneBuckets: response.stats.cloneBuckets,
    typeBuckets: response.stats.typeBuckets,
    sessionsTracked: response.stats.sessionsTracked,
  };
}

function serializeResponse(response: CheckResponse): string {
  return JSON.stringify(response);
}

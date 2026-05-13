import {
  type ArtifactEmitResponse,
  type ArtifactKind,
  compareSeverity,
  type ChangeRiskResponse,
  type CheckResponse,
  type CodeMemFinding,
  type CodeMemToolErrorCode,
  type CodeMemToolErrorResponse,
  type FleetCorrelation,
} from "@mazac-fox/codemem-shared/protocol";
import { createCodememAuditArtifact, createCodememJournalEntry } from "@mazac-fox/codemem-shared/artifacts";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { LoadedCodeMemConfig } from "@mazac-fox/codemem-shared/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonClient } from "./daemon/client";

export type CodeMemToolRuntime = {
  projectRoot: string;
  getConfig(): Promise<LoadedCodeMemConfig>;
  ensureReady(options?: { waitForReady: boolean }): Promise<DaemonClient>;
  maybeInjectSignals(sessionID: string, findings: CodeMemFinding[]): Promise<void>;
};

const z = tool.schema;

type FleetCorrelationArgs = FleetCorrelation;

const fleetCorrelationArgs = {
  workspace_id: z.string().optional(),
  plan_id: z.string().optional(),
  plan_slug: z.string().optional(),
  wave_id: z.string().optional(),
  agent_run_id: z.string().optional(),
  correlation_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  artifact_ref: z.string().optional(),
  lifecycle_object_id: z.string().optional(),
  concord_event_id: z.string().optional(),
  fleet_run_id: z.string().optional(),
  spine_seq: z.number().int().optional(),
};

export function createCodeMemTools(runtime: CodeMemToolRuntime): Record<string, ToolDefinition> {
  return {
    codemem_check: tool({
      description:
        "Run codemem semantic drift analysis for the current project and return compact JSON findings.",
      args: {
        maxFindings: z.number().int().min(1).max(200).default(50),
        includeEvidence: z.boolean().default(true),
        waitForFreshIndex: z.boolean().default(false),
        paths: z.array(z.string()).optional(),
        ...fleetCorrelationArgs,
      },
      async execute(
        args: {
          maxFindings?: number;
          includeEvidence?: boolean;
          waitForFreshIndex?: boolean;
          paths?: string[];
        } & FleetCorrelationArgs,
        context,
      ) {
        setToolMetadata(context, { title: "codemem check" });
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
            ...fleetCorrelationFromArgs(args),
          });
          await runtime.maybeInjectSignals(context.sessionID, response.findings);
          return {
            output: serializeResponse(response),
            metadata: summarizeCheckResponse(response),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_drift_map: tool({
      description:
        "Return a compact graph of drift-relevant nodes and edges for LLM planning and refactoring.",
      args: {
        maxFindings: z.number().int().min(1).max(200).default(50),
        ...fleetCorrelationArgs,
      },
      async execute(args: { maxFindings?: number } & FleetCorrelationArgs, context) {
        setToolMetadata(context, { title: "codemem drift map" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.driftMap({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
            ...fleetCorrelationFromArgs(args),
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
          return toolError(error);
        }
      },
    }),

    codemem_conflicts: tool({
      description:
        "Return concurrent-session conflict risk for overlapping dependency cones in the current project.",
      args: {
        includeInfo: z.boolean().default(false),
        ...fleetCorrelationArgs,
      },
      async execute(args: { includeInfo?: boolean } & FleetCorrelationArgs, context) {
        setToolMetadata(context, { title: "codemem conflicts" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const response = await client.conflicts({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            ...fleetCorrelationFromArgs(args),
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
          return toolError(error);
        }
      },
    }),

    codemem_change_risk: tool({
      description:
        "Score dependency-graph change risk for one or more paths using bounded, explainable codemem evidence.",
      args: {
        paths: z.array(z.string()).min(1),
        depth: z.number().int().min(1).max(8).default(2),
        maxFindings: z.number().int().min(1).max(200).default(50),
        maxFiles: z.number().int().min(1).max(200).default(50),
        ...fleetCorrelationArgs,
      },
      async execute(
        args: { paths: string[]; depth?: number; maxFindings?: number; maxFiles?: number } & FleetCorrelationArgs,
        context,
      ) {
        setToolMetadata(context, { title: "codemem change risk" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.changeRisk({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            paths: args.paths,
            depth: args.depth ?? 2,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
            maxFiles: args.maxFiles ?? 50,
            ...fleetCorrelationFromArgs(args),
          });
          return {
            output: JSON.stringify(response),
            metadata: summarizeChangeRisk(response),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_before_edit: tool({
      description:
        "Check whether target paths look isolated, shared, public, or conflicted before editing.",
      args: {
        paths: z.array(z.string()).min(1),
        depth: z.number().int().min(1).max(8).default(2),
        maxFindings: z.number().int().min(1).max(200).default(50),
        maxFiles: z.number().int().min(1).max(200).default(50),
        ...fleetCorrelationArgs,
      },
      async execute(
        args: { paths: string[]; depth?: number; maxFindings?: number; maxFiles?: number } & FleetCorrelationArgs,
        context,
      ) {
        setToolMetadata(context, { title: "codemem before edit" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.changeRisk({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            paths: args.paths,
            depth: args.depth ?? 2,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
            maxFiles: args.maxFiles ?? 50,
            ...fleetCorrelationFromArgs(args),
          });
          return {
            output: JSON.stringify({
              safeToEdit: response.level === "low",
              level: response.level,
              score: response.score,
              paths: response.paths,
              reasons: response.reasons,
              focus: response.focus,
              impactedFiles: response.impactedFiles,
              impactedFilesTruncated: response.impactedFilesTruncated,
              omittedImpactedFiles: response.omittedImpactedFiles,
              stats: response.stats,
              indexedAtUnixMs: response.indexedAtUnixMs,
            }),
            metadata: summarizeChangeRisk(response),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_review_focus: tool({
      description:
        "Return the highest-risk files or symbols reviewers should inspect first for changed paths.",
      args: {
        paths: z.array(z.string()).min(1),
        depth: z.number().int().min(1).max(8).default(2),
        maxFindings: z.number().int().min(1).max(200).default(50),
        maxItems: z.number().int().min(1).max(50).default(10),
        maxFiles: z.number().int().min(1).max(200).default(50),
        ...fleetCorrelationArgs,
      },
      async execute(
        args: {
          paths: string[];
          depth?: number;
          maxFindings?: number;
          maxItems?: number;
          maxFiles?: number;
        } & FleetCorrelationArgs,
        context,
      ) {
        setToolMetadata(context, { title: "codemem review focus" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.changeRisk({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            paths: args.paths,
            depth: args.depth ?? 2,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
            maxFiles: args.maxFiles ?? 50,
            ...fleetCorrelationFromArgs(args),
          });
          const maxItems = args.maxItems ?? 10;
          return {
            output: JSON.stringify({
              level: response.level,
              score: response.score,
              paths: response.paths,
              focus: response.focus.slice(0, maxItems),
              indexedAtUnixMs: response.indexedAtUnixMs,
            }),
            metadata: {
              ...summarizeChangeRisk(response),
              focus: Math.min(response.focus.length, maxItems),
            },
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_api_surface: tool({
      description:
        "List the public API surface (exported symbols and signatures) for the current project. Advisory / read-only.",
      args: {
        path: z.string().optional(),
        maxExports: z.number().int().min(1).max(2000).default(100),
        ...fleetCorrelationArgs,
      },
      async execute(args: { path?: string; maxExports?: number } & FleetCorrelationArgs, context) {
        setToolMetadata(context, { title: "codemem api surface" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const response = await client.apiSurface({
            projectRoot: runtime.projectRoot,
            path: args.path,
            maxExports: args.maxExports ?? 100,
            ...fleetCorrelationFromArgs(args),
          });
          return {
            output: JSON.stringify(response),
            metadata: { exports: response.exports.length, total: response.total },
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_impact_cone: tool({
      description: "Return the dependency impact cone for a path. Advisory / read-only.",
      args: {
        path: z.string(),
        depth: z.number().int().min(1).max(8).default(2),
        maxFiles: z.number().int().min(1).max(200).default(50),
        ...fleetCorrelationArgs,
      },
      async execute(
        args: { path: string; depth?: number; maxFiles?: number } & FleetCorrelationArgs,
        context,
      ) {
        setToolMetadata(context, { title: "codemem impact cone" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const response = await client.impactCone({
            projectRoot: runtime.projectRoot,
            path: args.path,
            depth: args.depth ?? 2,
            maxFiles: args.maxFiles ?? 50,
            ...fleetCorrelationFromArgs(args),
          });
          return {
            output: JSON.stringify(response),
            metadata: { files: response.files.length, depth: response.depth },
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_layer_boundaries: tool({
      description:
        "Report package/layer boundary information and cycle findings. Advisory / read-only.",
      args: {
        maxFindings: z.number().int().min(1).max(200).default(50),
        ...fleetCorrelationArgs,
      },
      async execute(args: { maxFindings?: number } & FleetCorrelationArgs, context) {
        setToolMetadata(context, { title: "codemem layer boundaries" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const response = await client.layerBoundaries({
            projectRoot: runtime.projectRoot,
            maxFindings: args.maxFindings ?? config.config.maxFindings,
            ...fleetCorrelationFromArgs(args),
          });
          return {
            output: JSON.stringify(response),
            metadata: { boundaries: response.boundaries.length, cycles: response.cycles.length },
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    codemem_artifact: tool({
      description:
        "Create or preview a Codemem audit or journal artifact from current findings. Advisory; dry-run by default.",
      args: {
        kind: z.enum(["audit", "journal"]),
        slug: z.string().optional(),
        maxFindings: z.number().int().min(1).max(200).default(50),
        dryRun: z.boolean().default(true),
        ...fleetCorrelationArgs,
      },
      async execute(
        args: {
          kind: ArtifactKind;
          slug?: string;
          maxFindings?: number;
          dryRun?: boolean;
        } & FleetCorrelationArgs,
        context,
      ) {
        setToolMetadata(context, { title: "codemem artifact" });
        try {
          const client = await runtime.ensureReady({ waitForReady: true });
          const config = await runtime.getConfig();
          const maxFindings = args.maxFindings ?? config.config.maxFindings;
          const check = await client.check({
            projectRoot: runtime.projectRoot,
            sessionID: context.sessionID,
            paths: undefined,
            maxFindings,
            includeEvidence: true,
            waitForFreshIndex: true,
            ...fleetCorrelationFromArgs(args),
          });
          const response = await emitArtifact({
            artifactKind: args.kind,
            dryRun: args.dryRun ?? true,
            maxFindings,
            projectRoot: runtime.projectRoot,
            slug: args.slug,
            findings: check.findings,
          });
          return {
            output: JSON.stringify(response),
            metadata: { findings: response.findings, applied: response.applied },
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),
  };
}

function fleetCorrelationFromArgs(args: FleetCorrelationArgs): FleetCorrelation {
  return {
    workspace_id: args.workspace_id,
    plan_id: args.plan_id,
    plan_slug: args.plan_slug,
    wave_id: args.wave_id,
    agent_run_id: args.agent_run_id,
    correlation_id: args.correlation_id,
    tool_call_id: args.tool_call_id,
    artifact_ref: args.artifact_ref,
    lifecycle_object_id: args.lifecycle_object_id,
    concord_event_id: args.concord_event_id,
    fleet_run_id: args.fleet_run_id,
    spine_seq: args.spine_seq,
  };
}

type EmitArtifactOptions = {
  artifactKind: ArtifactKind;
  dryRun: boolean;
  maxFindings: number;
  projectRoot: string;
  slug?: string;
  findings: CodeMemFinding[];
};

async function emitArtifact(options: EmitArtifactOptions): Promise<ArtifactEmitResponse> {
  if (options.artifactKind === "journal") {
    const entry = createCodememJournalEntry(options.findings.slice(0, options.maxFindings));
    const relativePath = ".opencode/journal.jsonl";
    const outputPath = path.join(options.projectRoot, relativePath);
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.appendFile(outputPath, `${JSON.stringify(entry)}\n`);
    }
    return {
      artifactKind: options.artifactKind,
      applied: !options.dryRun,
      entry,
      findings: options.findings.length,
      path: relativePath,
    };
  }

  const slug = options.slug ?? "codemem-audit";
  validateArtifactSlug(slug);
  const relativePath = path.join(".opencode", "audits", `${slug}.md`);
  const outputPath = path.join(options.projectRoot, relativePath);
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      outputPath,
      createCodememAuditArtifact(options.findings.slice(0, options.maxFindings)),
    );
  }
  return {
    artifactKind: options.artifactKind,
    applied: !options.dryRun,
    findings: options.findings.length,
    path: relativePath,
  };
}

function validateArtifactSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(slug)) {
    throw new Error("artifact slug must be 1-31 lowercase letters, digits, or hyphens");
  }
}

function setToolMetadata(
  context: unknown,
  metadata: { title?: string; metadata?: Record<string, unknown> },
): void {
  if (!isRecord(context) || typeof context.metadata !== "function") {
    return;
  }
  context.metadata(metadata);
}

function toolError(error: unknown): { output: string } {
  const message = errorMessage(error);
  const code = errorCode(message);
  const payload: CodeMemToolErrorResponse = {
    status: "degraded",
    degraded: true,
    error: {
      code,
      message,
      retryable: isRetryable(code),
    },
  };
  return { output: JSON.stringify(payload) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(message: string): CodeMemToolErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("timeout")) return "E_CODEMEM_DAEMON_TIMEOUT";
  if (lower.includes("protocol mismatch")) return "E_CODEMEM_PROTOCOL_MISMATCH";
  if (lower.includes("project_mismatch") || lower.includes("projectroot does not match")) {
    return "E_CODEMEM_PROJECT_MISMATCH";
  }
  if (lower.includes("payload too large")) return "E_CODEMEM_PAYLOAD_TOO_LARGE";
  if (lower.includes("unavailable") || lower.includes("unable to resolve") || lower.includes("enoent")) {
    return "E_CODEMEM_DAEMON_UNAVAILABLE";
  }
  return "E_CODEMEM_INTERNAL";
}

function isRetryable(code: CodeMemToolErrorCode): boolean {
  return code === "E_CODEMEM_DAEMON_TIMEOUT" || code === "E_CODEMEM_DAEMON_UNAVAILABLE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function summarizeChangeRisk(response: ChangeRiskResponse): Record<string, number | string> {
  return {
    level: response.level,
    score: response.score,
    paths: response.paths.length,
    impactedFiles: response.impactedFiles.length,
    reasons: response.reasons.length,
  };
}

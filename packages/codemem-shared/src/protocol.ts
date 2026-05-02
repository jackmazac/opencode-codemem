import crypto from "node:crypto";

export const CODEMEM_PROTOCOL_VERSION = 1;
export const CODEMEM_SCHEMA_VERSION = 1;

export type Severity = "info" | "warn" | "error";
export type FindingKind =
  | "semantic_clone"
  | "type_shape_duplicate"
  | "api_drift"
  | "dead_code"
  | "cycle"
  | "session_conflict";

export type Span = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type FindingEvidence = {
  kind:
    | "span"
    | "hash"
    | "signature"
    | "graph_edge"
    | "session_overlap"
    | "token_profile"
    | "dynamic_import";
  file?: string;
  symbol?: string;
  span?: Span;
  detail: string;
  score?: number;
};

export type BaseFinding = {
  kind: FindingKind;
  severity: Severity;
  confidence: number;
  evidence: FindingEvidence[];
  action: string;
};

export type SemanticCloneFinding = BaseFinding & {
  kind: "semantic_clone";
  files: string[];
  symbols: string[];
  canonicalHash?: string;
  detector: "l1_ast" | "l2_simhash" | "l3_embedding";
  recommendation: string;
};

export type TypeShapeDuplicateFinding = BaseFinding & {
  kind: "type_shape_duplicate";
  symbols: string[];
  shapeHash: string;
  recommendation: string;
};

export type ApiDriftFinding = BaseFinding & {
  kind: "api_drift";
  exportName: string;
  sourceFile: string;
  before: string;
  after: string;
  affectedCallers: string[];
};

export type DeadCodeFinding = BaseFinding & {
  kind: "dead_code";
  symbol: string;
  file: string;
  reason: string;
  dynamicImportRisk: boolean;
};

export type CycleFinding = BaseFinding & {
  kind: "cycle";
  nodes: string[];
  packageLevel: boolean;
};

export type SessionConflictFinding = BaseFinding & {
  kind: "session_conflict";
  sessions: string[];
  touchedCone: string[];
};

export type CodeMemFinding =
  | SemanticCloneFinding
  | TypeShapeDuplicateFinding
  | ApiDriftFinding
  | DeadCodeFinding
  | CycleFinding
  | SessionConflictFinding;

export type DriftMapNode = {
  id: string;
  label: string;
  kind: "file" | "package" | "export" | "type" | "session";
  severity?: Severity;
};

export type DriftMapEdge = {
  from: string;
  to: string;
  kind: "imports" | "exports" | "duplicates" | "conflicts" | "depends_on";
  dynamic?: boolean;
};

export type DriftMap = {
  nodes: DriftMapNode[];
  edges: DriftMapEdge[];
  findings: CodeMemFinding[];
};

export type RpcErrorEnvelope = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type HealthRequest = {
  projectRoot: string;
};

export type HealthResponse = {
  protocolVersion: number;
  schemaVersion: number;
  daemonVersion: string;
  projectRoot: string;
  startedAtUnixMs: number;
  healthy: boolean;
  queueDepth: number;
  indexedFiles: number;
  findingsCacheEntries: number;
};

export type FilesChangedNotification = {
  projectRoot: string;
  sessionID: string;
  files: string[];
  reason: "tool" | "event" | "manual";
  turnID?: string;
  observedAtUnixMs: number;
};

export type CheckRequest = {
  projectRoot: string;
  sessionID?: string;
  paths?: string[];
  maxFindings: number;
  includeEvidence: boolean;
  waitForFreshIndex: boolean;
};

export type CheckResponse = {
  findings: CodeMemFinding[];
  truncated: boolean;
  indexedAtUnixMs: number;
  stats: {
    filesIndexed: number;
    scanLatencyMs: number;
    cloneBuckets: number;
    typeBuckets: number;
    sessionsTracked: number;
  };
};

export type DriftMapRequest = {
  projectRoot: string;
  sessionID?: string;
  maxFindings: number;
};

export type DriftMapResponse = {
  map: DriftMap;
  indexedAtUnixMs: number;
};

export type ConflictsRequest = {
  projectRoot: string;
  sessionID?: string;
};

export type ConflictsResponse = {
  findings: SessionConflictFinding[];
  indexedAtUnixMs: number;
};

export type StatusRequest = {
  projectRoot: string;
};

export type StatusResponse = {
  health: HealthResponse;
  stateDirectory: string;
  protocolVersion: number;
};

export type MaintainRequest = {
  projectRoot: string;
  dryRun: boolean;
  pruneLogs?: boolean;
  compact?: boolean;
};

export type MaintainResponse = {
  actions: Array<{ kind: string; detail: string; estimatedBytes?: number }>;
  applied: boolean;
};

export type RebuildRequest = {
  projectRoot: string;
  dryRun: boolean;
};

export type RebuildResponse = {
  wouldRebuild: boolean;
  reason: string;
};

export type RpcMethodMap = {
  health: { params: HealthRequest; result: HealthResponse };
  "project.filesChanged": { params: FilesChangedNotification; result: { accepted: boolean } };
  "analysis.check": { params: CheckRequest; result: CheckResponse };
  "analysis.driftMap": { params: DriftMapRequest; result: DriftMapResponse };
  "analysis.conflicts": { params: ConflictsRequest; result: ConflictsResponse };
  "maintenance.status": { params: StatusRequest; result: StatusResponse };
  "maintenance.maintain": { params: MaintainRequest; result: MaintainResponse };
  "maintenance.rebuild": { params: RebuildRequest; result: RebuildResponse };
};

export type RpcMethod = keyof RpcMethodMap;

export type RpcRequestEnvelope<M extends RpcMethod = RpcMethod> = {
  jsonrpc: "2.0";
  protocolVersion: number;
  id: string;
  authToken?: string;
  method: M;
  params: RpcMethodMap[M]["params"];
};

export type RpcNotificationEnvelope<M extends RpcMethod = RpcMethod> = {
  jsonrpc: "2.0";
  protocolVersion: number;
  authToken?: string;
  method: M;
  params: RpcMethodMap[M]["params"];
};

export type RpcResponseEnvelope<M extends RpcMethod = RpcMethod> = {
  jsonrpc: "2.0";
  protocolVersion: number;
  id: string;
  result?: RpcMethodMap[M]["result"];
  error?: RpcErrorEnvelope;
};

export function createRequestId(prefix = "cm"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createRpcRequest<M extends RpcMethod>(
  method: M,
  params: RpcMethodMap[M]["params"],
  authToken?: string,
): RpcRequestEnvelope<M> {
  return {
    jsonrpc: "2.0",
    protocolVersion: CODEMEM_PROTOCOL_VERSION,
    id: createRequestId(method.replace(/[^a-z]/gi, "").slice(0, 6).toLowerCase() || "cm"),
    authToken,
    method,
    params,
  };
}

export function createRpcNotification<M extends RpcMethod>(
  method: M,
  params: RpcMethodMap[M]["params"],
  authToken?: string,
): RpcNotificationEnvelope<M> {
  return {
    jsonrpc: "2.0",
    protocolVersion: CODEMEM_PROTOCOL_VERSION,
    authToken,
    method,
    params,
  };
}

export function createRpcError(
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): RpcErrorEnvelope {
  return { code, message, retryable, details };
}

export function isRpcErrorResponse(response: RpcResponseEnvelope): response is RpcResponseEnvelope & { error: RpcErrorEnvelope } {
  return Boolean(response.error);
}

export function encodeFrame(message: RpcRequestEnvelope | RpcNotificationEnvelope | RpcResponseEnvelope): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export function decodeFrames(buffer: Buffer): {
  messages: Array<RpcRequestEnvelope | RpcNotificationEnvelope | RpcResponseEnvelope>;
  remainder: Buffer;
} {
  const messages: Array<RpcRequestEnvelope | RpcNotificationEnvelope | RpcResponseEnvelope> = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 4 + length > buffer.length) {
      break;
    }
    const start = offset + 4;
    const end = start + length;
    const parsed = JSON.parse(buffer.subarray(start, end).toString("utf8")) as
      | RpcRequestEnvelope
      | RpcNotificationEnvelope
      | RpcResponseEnvelope;
    messages.push(parsed);
    offset = end;
  }

  return { messages, remainder: buffer.subarray(offset) };
}

export function buildPromptSignal(findings: CodeMemFinding[], maxLines = 4): string {
  const lines = findings.slice(0, maxLines).map((finding) => {
    switch (finding.kind) {
      case "api_drift":
        return `- P1 api_drift: ${finding.exportName} changed from ${finding.before} to ${finding.after}; ${finding.affectedCallers.length} callers still look stale.`;
      case "semantic_clone":
        return `- P2 semantic_clone: ${finding.symbols.slice(0, 2).join(" and ")} likely duplicate behavior (${finding.detector}, conf=${finding.confidence.toFixed(2)}).`;
      case "type_shape_duplicate":
        return `- P2 type_shape_duplicate: ${finding.symbols.slice(0, 3).join(", ")} share shape ${finding.shapeHash.slice(0, 8)}.`;
      case "dead_code":
        return `- P3 dead_code: ${finding.symbol} looks unreachable; dynamicRisk=${finding.dynamicImportRisk}.`;
      case "cycle":
        return `- P2 cycle: ${finding.nodes.slice(0, 4).join(" -> ")}${finding.nodes.length > 4 ? " -> …" : ""}.`;
      case "session_conflict":
        return `- P2 session_conflict: sessions ${finding.sessions.join(", ")} overlap on ${finding.touchedCone.slice(0, 3).join(", ")}.`;
      default:
        return `- P3 signal: attention recommended.`;
    }
  });

  if (lines.length === 0) {
    return "<codemem_signal>\n- none\n</codemem_signal>";
  }

  return `<codemem_signal>\n${lines.join("\n")}\n</codemem_signal>`;
}

export function compareSeverity(a: Severity, b: Severity): number {
  const rank: Record<Severity, number> = { info: 0, warn: 1, error: 2 };
  return rank[a] - rank[b];
}

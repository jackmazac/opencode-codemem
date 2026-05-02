import type { CodeMemFinding, FindingKind, Severity } from "./protocol";

export type FindingBaselineEntry = {
  id: string;
  kind: FindingKind;
  severity: Severity;
  action: string;
};

export type FindingBaseline = {
  version: 1;
  generatedAtUnixMs: number;
  findings: FindingBaselineEntry[];
};

export type FindingBaselineDiff = {
  added: CodeMemFinding[];
  removed: FindingBaselineEntry[];
  unchanged: CodeMemFinding[];
};

export function createFindingBaseline(findings: CodeMemFinding[], generatedAtUnixMs: number): FindingBaseline {
  return {
    version: 1,
    generatedAtUnixMs,
    findings: findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      action: finding.action,
    })),
  };
}

export function diffFindingBaseline(
  baseline: FindingBaseline,
  currentFindings: CodeMemFinding[],
): FindingBaselineDiff {
  const baselineById = new Map(baseline.findings.map((finding) => [finding.id, finding]));
  const currentById = new Map(currentFindings.map((finding) => [finding.id, finding]));

  const added = currentFindings.filter((finding) => !baselineById.has(finding.id));
  const unchanged = currentFindings.filter((finding) => baselineById.has(finding.id));
  const removed = baseline.findings.filter((finding) => !currentById.has(finding.id));

  return { added, removed, unchanged };
}

export function parseFindingBaselineJson(raw: string): FindingBaseline {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) {
    throw new Error("baseline must be a JSON object");
  }
  const version = Reflect.get(parsed, "version");
  const generatedAtUnixMs = Reflect.get(parsed, "generatedAtUnixMs");
  const findings = Reflect.get(parsed, "findings");
  if (version !== 1) {
    throw new Error("unsupported baseline version");
  }
  if (typeof generatedAtUnixMs !== "number") {
    throw new Error("baseline generatedAtUnixMs must be a number");
  }
  if (!Array.isArray(findings)) {
    throw new Error("baseline findings must be an array");
  }

  return {
    version,
    generatedAtUnixMs,
    findings: findings.map(parseBaselineEntry),
  };
}

function parseBaselineEntry(value: unknown): FindingBaselineEntry {
  if (!isObject(value)) {
    throw new Error("baseline finding must be an object");
  }
  const id = Reflect.get(value, "id");
  const kind = Reflect.get(value, "kind");
  const severity = Reflect.get(value, "severity");
  const action = Reflect.get(value, "action");
  if (typeof id !== "string") throw new Error("baseline finding id must be a string");
  if (!isFindingKind(kind)) throw new Error("baseline finding kind is invalid");
  if (!isSeverity(severity)) throw new Error("baseline finding severity is invalid");
  if (typeof action !== "string") throw new Error("baseline finding action must be a string");
  return { id, kind, severity, action };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isFindingKind(value: unknown): value is FindingKind {
  return (
    value === "semantic_clone"
    || value === "type_shape_duplicate"
    || value === "api_drift"
    || value === "dead_code"
    || value === "cycle"
    || value === "session_conflict"
  );
}

function isSeverity(value: unknown): value is Severity {
  return value === "info" || value === "warn" || value === "error";
}

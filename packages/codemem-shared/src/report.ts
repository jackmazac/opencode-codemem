import type { CodeMemFinding, Severity } from "./protocol";

export type SarifReport = {
  version: "2.1.0";
  runs: Array<{
    tool: { driver: { name: "codemem"; rules: [] } };
    results: SarifResult[];
  }>;
};

type SarifResult = {
  ruleId: string;
  level: "note" | "warning" | "error";
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
  properties: {
    id: string;
    confidence: number;
  };
};

export function explainFinding(finding: CodeMemFinding): string {
  return [
    `${finding.id}`,
    `kind: ${finding.kind}`,
    `severity: ${finding.severity}`,
    `confidence: ${finding.confidence.toFixed(2)}`,
    `action: ${finding.action}`,
  ].join("\n");
}

export function createMarkdownReport(findings: CodeMemFinding[]): string {
  if (findings.length === 0) {
    return "# Codemem Report\n\nNo findings.\n";
  }

  const sections = findings.map((finding) =>
    [
      `## ${finding.kind}`,
      "",
      `id: ${finding.id}`,
      `severity: ${finding.severity}`,
      `confidence: ${finding.confidence.toFixed(2)}`,
      "",
      finding.action,
    ].join("\n"),
  );
  return ["# Codemem Report", "", ...sections, ""].join("\n");
}

export function createSarifReport(findings: CodeMemFinding[]): SarifReport {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "codemem", rules: [] } },
        results: findings.map(findingToSarifResult),
      },
    ],
  };
}

function findingToSarifResult(finding: CodeMemFinding): SarifResult {
  return {
    ruleId: finding.kind,
    level: severityToSarifLevel(finding.severity),
    message: { text: finding.action },
    locations: [{ physicalLocation: { artifactLocation: { uri: primaryFile(finding) } } }],
    properties: {
      id: finding.id,
      confidence: finding.confidence,
    },
  };
}

function severityToSarifLevel(severity: Severity): "note" | "warning" | "error" {
  switch (severity) {
    case "info":
      return "note";
    case "warn":
      return "warning";
    case "error":
      return "error";
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
}

function primaryFile(finding: CodeMemFinding): string {
  switch (finding.kind) {
    case "semantic_clone":
      return finding.files[0] ?? "unknown";
    case "type_shape_duplicate": {
      const firstSymbol = finding.symbols[0] ?? "unknown";
      return firstSymbol.split("::")[0] ?? firstSymbol;
    }
    case "api_drift":
      return finding.sourceFile;
    case "dead_code":
      return finding.file;
    case "cycle":
      return finding.nodes[0] ?? "unknown";
    case "session_conflict":
      return finding.touchedCone[0] ?? "unknown";
    default: {
      const exhaustive: never = finding;
      return exhaustive;
    }
  }
}

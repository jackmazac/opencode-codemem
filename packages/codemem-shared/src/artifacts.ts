import type { CodeMemFinding } from "./protocol";
import { createMarkdownReport } from "./report";

export type CodememJournalEntry = {
  ts: string;
  type: "discovery";
  content: string;
};

export function createCodememJournalEntry(
  findings: CodeMemFinding[],
  generatedAtUnixMs = Date.now(),
): CodememJournalEntry {
  const top = findings[0];
  return {
    ts: new Date(generatedAtUnixMs).toISOString(),
    type: "discovery",
    content: top
      ? `codemem report: ${findings.length} finding(s); top finding ${top.kind} ${top.id} - ${top.action}`
      : "codemem report: 0 finding(s)",
  };
}

export function createCodememAuditArtifact(findings: CodeMemFinding[]): string {
  return `# Codemem Audit\n\n${createMarkdownReport(findings)}`;
}

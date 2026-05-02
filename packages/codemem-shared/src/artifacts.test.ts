import { describe, expect, test } from "bun:test";
import type { CodeMemFinding } from "./protocol";
import { createCodememAuditArtifact, createCodememJournalEntry } from "./artifacts";

describe("codemem artifact emission", () => {
  test("creates journal and audit artifacts from findings", () => {
    const finding = deadCodeFinding();

    expect(createCodememJournalEntry([finding], 1234)).toEqual({
      ts: "1970-01-01T00:00:01.234Z",
      type: "discovery",
      content: "codemem report: 1 finding(s); top finding dead_code dead:src/a.ts:unused - Remove unused export.",
    });
    expect(createCodememAuditArtifact([finding])).toContain("# Codemem Audit");
    expect(createCodememAuditArtifact([finding])).toContain("dead:src/a.ts:unused");
  });
});

function deadCodeFinding(): CodeMemFinding {
  return {
    id: "dead:src/a.ts:unused",
    kind: "dead_code",
    severity: "warn",
    confidence: 0.9,
    evidence: [],
    action: "Remove unused export.",
    symbol: "unused",
    file: "src/a.ts",
    reason: "unreachable_from_entrypoints",
    dynamicImportRisk: false,
  };
}

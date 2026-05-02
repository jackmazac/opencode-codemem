import { describe, expect, test } from "bun:test";
import type { CodeMemFinding } from "./protocol";
import { createMarkdownReport, createSarifReport, explainFinding } from "./report";

describe("finding reports", () => {
  test("explains a finding with stable id and action", () => {
    const explanation = explainFinding(deadCodeFinding());

    expect(explanation).toContain("dead:src/a.ts:unused");
    expect(explanation).toContain("dead_code");
    expect(explanation).toContain("Remove unused export.");
  });

  test("creates markdown and SARIF-compatible reports", () => {
    const finding = deadCodeFinding();

    expect(createMarkdownReport([finding])).toContain("## dead_code");
    expect(createSarifReport([finding])).toEqual({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "codemem", rules: [] } },
          results: [
            {
              ruleId: "dead_code",
              level: "warning",
              message: { text: "Remove unused export." },
              locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" } } }],
              properties: {
                id: "dead:src/a.ts:unused",
                confidence: 0.9,
              },
            },
          ],
        },
      ],
    });
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

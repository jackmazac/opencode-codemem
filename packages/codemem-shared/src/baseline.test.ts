import { describe, expect, test } from "bun:test";
import type { CodeMemFinding } from "./protocol";
import { createFindingBaseline, diffFindingBaseline } from "./baseline";

describe("finding baselines", () => {
  test("creates a compact baseline from current findings", () => {
    const baseline = createFindingBaseline([deadCodeFinding("dead:src/a.ts:unused", "unused")], 1234);

    expect(baseline).toEqual({
      version: 1,
      generatedAtUnixMs: 1234,
      findings: [
        {
          id: "dead:src/a.ts:unused",
          kind: "dead_code",
          severity: "warn",
          action: "Remove unused export.",
        },
      ],
    });
  });

  test("diffs current findings by stable id", () => {
    const baseline = createFindingBaseline([deadCodeFinding("dead:src/a.ts:old", "old")], 1234);
    const current = [deadCodeFinding("dead:src/a.ts:new", "new")];

    const diff = diffFindingBaseline(baseline, current);

    expect(diff.added.map((finding) => finding.id)).toEqual(["dead:src/a.ts:new"]);
    expect(diff.removed.map((finding) => finding.id)).toEqual(["dead:src/a.ts:old"]);
    expect(diff.unchanged).toEqual([]);
  });
});

function deadCodeFinding(id: string, symbol: string): CodeMemFinding {
  return {
    id,
    kind: "dead_code",
    severity: "warn",
    confidence: 0.9,
    evidence: [],
    action: "Remove unused export.",
    symbol,
    file: "src/a.ts",
    reason: "unreachable_from_entrypoints",
    dynamicImportRisk: false,
  };
}

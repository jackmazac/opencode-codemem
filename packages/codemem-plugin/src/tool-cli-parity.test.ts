import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./cli";

const toolToCliCommand: Record<string, string[]> = {
  codemem_check: ["check", "--json"],
  codemem_drift_map: ["drift-map", "--json"],
  codemem_conflicts: ["conflicts", "--json"],
  codemem_change_risk: ["change-risk", "--path", "src/index.ts", "--json"],
  codemem_before_edit: ["before-edit", "--path", "src/index.ts", "--json"],
  codemem_review_focus: ["review-focus", "--path", "src/index.ts", "--json"],
  codemem_api_surface: ["api-surface", "--path", "src/index.ts", "--json"],
  codemem_impact_cone: ["impact-cone", "--path", "src/index.ts", "--json"],
  codemem_layer_boundaries: ["layer-boundaries", "--json"],
};

const documentedAsymmetries = {
  codemem_artifact:
    "CLI artifact writes local .opencode artifacts; plugin tool keeps the same dry-run default but is intentionally not mirrored as a daemon RPC.",
};

describe("tool to CLI parity", () => {
  test("every advisory plugin tool has a headless CLI command or documented asymmetry", () => {
    for (const [toolName, argv] of Object.entries(toolToCliCommand)) {
      const parsed = parseCliArgs(argv, "/repo");
      expect(parsed.ok, `${toolName} should parse ${argv.join(" ")}`).toBe(true);
    }

    expect(Object.keys(documentedAsymmetries)).toEqual(["codemem_artifact"]);
    const artifact = parseCliArgs(["artifact", "--kind", "audit", "--json"], "/repo");
    expect(artifact.ok).toBe(true);
  });

  test("shared path-scoped surfaces use the same flag shape", () => {
    for (const argv of [
      ["check", "--path", "src/a.ts", "--json"],
      ["change-risk", "--path", "src/a.ts", "--json"],
      ["before-edit", "--path", "src/a.ts", "--json"],
      ["review-focus", "--path", "src/a.ts", "--json"],
      ["impact-cone", "--path", "src/a.ts", "--json"],
      ["api-surface", "--path", "src/a.ts", "--json"],
    ]) {
      const parsed = parseCliArgs(argv, "/repo");
      expect(parsed.ok, argv.join(" ")).toBe(true);
    }
  });
});

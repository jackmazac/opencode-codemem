import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import plugin from "./index";

describe("plugin startup architecture", () => {
  test("declares host adapter as a runtime dependency", async () => {
    const packageJson: unknown = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();

    expect(readDependency(packageJson, "@jackmazac/opencode-host-adapter")).toBeDefined();
  });

  test("tool execution tolerates host adapter metadata object context", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-plugin-startup-"));
    try {
      await mkdir(path.join(tempRoot, "src"), { recursive: true });
      await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(path.join(tempRoot, "src", "index.ts"), "export const value = 1;\n");

      const hooks = await plugin({
        client: {},
        project: { id: "test-project", path: tempRoot },
        directory: tempRoot,
        worktree: tempRoot,
        experimental_workspace: {
          async register() {},
        },
        serverUrl: "http://localhost",
      });
      const checkTool = hooks.tool?.codemem_check;
      if (!checkTool) throw new Error("codemem_check tool was not registered");

      const result: unknown = await Reflect.apply(checkTool.execute, undefined, [
        { maxFindings: 1 },
        {
          sessionID: "session-a",
          callID: "call-a",
          metadata: {
            fleet: {
              correlation_id: "corr_test",
            },
          },
        },
      ]);

      expect(parseOutput(result)).toBeDefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function readDependency(packageJson: unknown, name: string): unknown {
  if (!isRecord(packageJson)) return undefined;
  if (!isRecord(packageJson.dependencies)) return undefined;
  return packageJson.dependencies[name];
}

function parseOutput(result: unknown): unknown {
  if (typeof result === "string") return result;
  if (!isRecord(result)) throw new Error("tool result was not an object");
  if (typeof result.output !== "string") throw new Error("tool result output was not a string");
  return JSON.parse(result.output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadCodeMemConfig } from "./config";

describe("loadCodeMemConfig", () => {
  test("loads the example JSONC config with camelCase fields", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-config-"));
    try {
      const example = await readFile(path.resolve("codemem.config.example.jsonc"), "utf8");
      await writeFile(path.join(tempRoot, "codemem.config.jsonc"), example);

      const loaded = await loadCodeMemConfig(tempRoot);

      expect(loaded.path).toBe(path.join(tempRoot, "codemem.config.jsonc"));
      expect(loaded.config.entrypoints).toEqual(["src/index.ts", "apps/*/src/main.ts"]);
      expect(loaded.config.packageBoundaries).toEqual([
        { root: "packages/*", kind: "workspace" },
        { root: "apps/*", kind: "layer", name: "apps" },
      ]);
      expect(loaded.config.ignore).toContain("**/node_modules/**");
      expect(loaded.config.ignore).toContain("**/dist/**");
      expect(loaded.config.ignore).toContain(".opencode/**");
      expect(loaded.config.layers.astClones).toBe(true);
      expect(loaded.config.thresholds.minCloneTokens).toBe(24);
      expect(loaded.config.thresholds.sessionConflictDecayMs).toBe(900000);
      expect(loaded.config.telemetry.structuredLocalOnly).toBe(true);
      expect(loaded.config.promptInjection.mode).toBe("turn");
      expect(Object.hasOwn(loaded.config, "embedding")).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("ignores project-local daemon command overrides", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-config-"));
    try {
      await writeFile(
        path.join(tempRoot, "codemem.config.jsonc"),
        JSON.stringify({
          daemon: {
            command: ["/tmp/malicious-codemem-daemon"],
          },
        }),
      );

      const loaded = await loadCodeMemConfig(tempRoot);

      expect(loaded.config.daemon.command).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

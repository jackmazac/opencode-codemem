import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CodeMemConfig } from "@codemem/shared/config";
import { DaemonSupervisor, resolveDaemonCommand } from "./supervisor";

describe("DaemonSupervisor auth token", () => {
  test("reuses a persisted token when a daemon token file already exists", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-supervisor-"));
    try {
      const stateDirectory = path.join(tempRoot, "state");
      await mkdir(path.join(stateDirectory, "run"), { recursive: true });
      await writeFile(path.join(stateDirectory, "run", "codemem.token"), "persisted-token", { mode: 0o600 });

      const supervisor = new DaemonSupervisor({
        projectRoot: tempRoot,
        stateDirectory,
        config: testConfig(),
      });

      expect(supervisor.createClient().endpoint.authToken).toBe("persisted-token");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveDaemonCommand", () => {
  test("uses configured command before every binary fallback", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-command-"));
    try {
      const config = testConfig();
      config.daemon.command = ["custom-daemon", "--flag"];
      config.daemon.binaryPath = "bin/ignored";

      await expect(resolveDaemonCommand({ projectRoot: tempRoot, config })).resolves.toEqual([
        "custom-daemon",
        "--flag",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("resolves packaged and development daemon binaries without config", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-binary-"));
    try {
      const packageRoot = path.join(tempRoot, "package");
      const packagedBinary = path.join(packageRoot, "bin", "darwin-arm64", "codemem-daemon");
      await mkdir(path.dirname(packagedBinary), { recursive: true });
      await writeFile(packagedBinary, "");

      await expect(
        resolveDaemonCommand({
          projectRoot: tempRoot,
          config: testConfig(),
          packageRoot,
          env: {},
          platform: "darwin",
          arch: "arm64",
        }),
      ).resolves.toEqual([packagedBinary]);

      await rm(packageRoot, { recursive: true, force: true });
      const developmentBinary = path.join(
        tempRoot,
        "packages",
        "codemem-daemon",
        "target",
        "release",
        "codemem-daemon",
      );
      await mkdir(path.dirname(developmentBinary), { recursive: true });
      await writeFile(developmentBinary, "");

      await expect(
        resolveDaemonCommand({
          projectRoot: tempRoot,
          config: testConfig(),
          packageRoot,
          env: {},
          platform: "darwin",
          arch: "arm64",
        }),
      ).resolves.toEqual([developmentBinary]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function testConfig(): CodeMemConfig {
  return {
    entrypoints: ["src/index.ts"],
    ignore: [],
    packageBoundaries: [],
    layers: {
      astClones: true,
      simhashClones: true,
      typeShapes: true,
      symbolGraph: true,
      apiDrift: true,
      sessionConflicts: true,
      dynamicDeadCode: true,
    },
    thresholds: {
      minCloneTokens: 24,
      minCloneStatements: 3,
      simhashHammingRadius: 6,
      maxFindings: 50,
      typeShapeMinMembers: 3,
      sessionConflictOverlap: 0.25,
      sessionConflictDecayMs: 900000,
      promptInjectionMinConfidence: 0.8,
    },
    daemon: {
      maxPayloadBytes: 4194304,
      healthTimeoutMs: 250,
      requestTimeoutMs: 3000,
      spawnTimeoutMs: 2500,
    },
    telemetry: {
      enabled: true,
      retainDays: 14,
      maxLogBytes: 8388608,
      structuredLocalOnly: true,
    },
    promptInjection: {
      enabled: true,
      mode: "turn",
      minSeverity: "warn",
      maxSignalsPerTurn: 4,
      cooldownMs: 2000,
    },
    maxFindings: 50,
  };
}

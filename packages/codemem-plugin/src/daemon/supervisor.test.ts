import net from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CodeMemConfig } from "@mazac-fox/codemem-shared/config";
import { CODEMEM_PROTOCOL_VERSION, decodeFrames, encodeFrame } from "@mazac-fox/codemem-shared/protocol";
import {
  cleanupStaleEndpoint,
  DaemonSupervisor,
  resolveDaemonCommand,
  resolveLifecycleLogPaths,
} from "./supervisor";

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

describe("DaemonSupervisor lifecycle", () => {
  test("reuses a healthy daemon without spawning", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-reuse-"));
    const stateDirectory = path.join(tempRoot, "state");
    const endpoint = path.join(stateDirectory, "run", "codemem.sock");
    await mkdir(path.dirname(endpoint), { recursive: true });
    const server = await startHealthServer(endpoint, tempRoot);
    try {
      const config = testConfig();
      config.daemon.command = ["missing-daemon-that-should-not-run"];
      const supervisor = new DaemonSupervisor({
        projectRoot: tempRoot,
        stateDirectory,
        config,
      });
      const secondSupervisor = new DaemonSupervisor({
        projectRoot: tempRoot,
        stateDirectory,
        config,
      });

      const [first, second, third] = await Promise.all([
        supervisor.ensureDaemon(true),
        supervisor.ensureDaemon(true),
        secondSupervisor.ensureDaemon(true),
      ]);

      expect(first.started).toBe(true);
      expect(first.reused).toBe(true);
      expect(second.started).toBe(true);
      expect(second.reused).toBe(true);
      expect(third.started).toBe(true);
      expect(third.reused).toBe(true);
      expect(server.requests).toBe(3);
    } finally {
      server.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("reports stale endpoint cleanup", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-stale-"));
    try {
      const endpoint = path.join(tempRoot, "codemem.sock");
      const pidFile = path.join(tempRoot, "codemem.pid");
      await writeFile(endpoint, "");
      await writeFile(pidFile, "999999999");

      const result = await cleanupStaleEndpoint(endpoint, pidFile);

      expect(result.removedEndpoint).toBe(true);
      expect(result.removedPidFile).toBe(true);
      expect(result.pidAlive).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("resolves lifecycle log paths under the state directory", () => {
    const logs = resolveLifecycleLogPaths("/repo/.git/codemem");

    expect(logs.stdout).toBe(path.join("/repo/.git/codemem", "log", "daemon.stdout.log"));
    expect(logs.stderr).toBe(path.join("/repo/.git/codemem", "log", "daemon.stderr.log"));
    expect(logs.lifecycle).toBe(path.join("/repo/.git/codemem", "log", "daemon.lifecycle.jsonl"));
  });

  test("returns a warning and lifecycle log when daemon spawn fails", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-start-fail-"));
    try {
      const stateDirectory = path.join(tempRoot, "state");
      const config = testConfig();
      config.daemon.command = [path.join(tempRoot, "missing-codemem-daemon")];
      const supervisor = new DaemonSupervisor({
        projectRoot: tempRoot,
        stateDirectory,
        config,
      });

      const status = await supervisor.ensureDaemon(true);

      expect(status.started).toBe(false);
      expect(status.warning).toContain("codemem-daemon");
      const lifecycleLog = await readFile(status.lifecycleLogFile, "utf8");
      expect(lifecycleLog).toContain("daemon.start_failed");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("keeps the start lock during non-blocking spawn until readiness times out", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-nonblocking-lock-"));
    try {
      const stateDirectory = path.join(tempRoot, "state");
      const config = testConfig();
      config.daemon.command = ["/bin/sh", "-c", "sleep 1"];
      config.daemon.spawnTimeoutMs = 120;
      const supervisor = new DaemonSupervisor({
        projectRoot: tempRoot,
        stateDirectory,
        config,
      });

      const status = await supervisor.ensureDaemon(false);

      expect(status.started).toBe(true);
      await expect(access(status.startLockFile)).resolves.toBeNull();
      await sleep(200);
      await expect(access(status.startLockFile)).rejects.toThrow();
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
    pluginToolSurfaceMaxChars: 40_000,
  };
}

async function startHealthServer(
  endpoint: string,
  projectRoot: string,
): Promise<{ close(): void; requests: number }> {
  const state = { requests: 0 };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.remainder;
      for (const message of decoded.messages) {
        if (!("id" in message)) continue;
        state.requests += 1;
        socket.write(
          encodeFrame({
            jsonrpc: "2.0",
            protocolVersion: CODEMEM_PROTOCOL_VERSION,
            id: message.id,
            result: {
              protocolVersion: CODEMEM_PROTOCOL_VERSION,
              schemaVersion: 1,
              daemonVersion: "test",
              projectRoot,
              startedAtUnixMs: 1,
              healthy: true,
              queueDepth: 0,
              droppedBatches: 0,
              failedBatches: 0,
              indexedFiles: 1,
              findingsCacheEntries: 0,
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return {
    close() {
      server.close();
    },
    get requests() {
      return state.requests;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

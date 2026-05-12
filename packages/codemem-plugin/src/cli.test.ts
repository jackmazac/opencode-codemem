import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateHealthReport } from "@jackmazac/opencode-fleet-contracts";
import {
  CODEMEM_PROTOCOL_VERSION,
  decodeFrames,
  encodeFrame,
  type RpcResponseEnvelope,
} from "@codemem/shared/protocol";
import { parseCliArgs, runCodeMemCli, type CliRuntime } from "./cli";
import { DaemonClient } from "./daemon/client";

describe("parseCliArgs", () => {
  test("parses status with json output and project root", () => {
    const parsed = parseCliArgs(["status", "--json", "--project-root", "/repo"], "/fallback");

    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: "status",
        json: true,
        projectRoot: "/repo",
      },
    });
  });

  test("parses doctor as fleet-standard status health check", () => {
    const parsed = parseCliArgs(["doctor", "--json", "--project-root", "/repo"], "/fallback");

    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: "doctor",
        json: true,
        projectRoot: "/repo",
      },
    });
  });

  test("parses daemon stop and stale cleanup commands", () => {
    expect(parseCliArgs(["stop", "--json", "--project-root", "/repo"], "/fallback")).toEqual({
      ok: true,
      command: {
        kind: "stop",
        json: true,
        projectRoot: "/repo",
      },
    });
    expect(parseCliArgs(["cleanup", "--stale", "--json", "--project-root", "/repo"], "/fallback")).toEqual({
      ok: true,
      command: {
        kind: "cleanup",
        json: true,
        projectRoot: "/repo",
        stale: true,
      },
    });
  });

  test("resolves relative project roots against the invocation cwd", () => {
    const parsed = parseCliArgs(["status", "--project-root", "."], "/repo");

    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: "status",
        json: false,
        projectRoot: "/repo",
      },
    });
  });

  test("parses check paths and max findings", () => {
    const parsed = parseCliArgs(
      ["check", "--path", "src/a.ts", "--path", "src/b.ts", "--max-findings", "5", "--json"],
      "/repo",
    );

    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: "check",
        includeEvidence: false,
        json: true,
        maxFindings: 5,
        paths: ["src/a.ts", "src/b.ts"],
        pathsFromStdin: false,
        projectRoot: "/repo",
        waitForFreshIndex: true,
      },
    });
  });

  test("parses maintain as dry-run unless apply is explicit", () => {
    const dryRun = parseCliArgs(["maintain", "--prune-logs", "--compact", "--json"], "/repo");
    const apply = parseCliArgs(["maintain", "--apply", "--json"], "/repo");

    expect(dryRun).toEqual({
      ok: true,
      command: {
        kind: "maintain",
        compact: true,
        dryRun: true,
        json: true,
        projectRoot: "/repo",
        pruneLogs: true,
      },
    });
    expect(apply).toEqual({
      ok: true,
      command: {
        kind: "maintain",
        compact: false,
        dryRun: false,
        json: true,
        projectRoot: "/repo",
        pruneLogs: false,
      },
    });
  });

  test("parses rebuild as dry-run unless apply is explicit", () => {
    const parsed = parseCliArgs(["rebuild", "--apply", "--json"], "/repo");

    expect(parsed).toEqual({
      ok: true,
      command: {
        kind: "rebuild",
        dryRun: false,
        json: true,
        projectRoot: "/repo",
      },
    });
  });

  test("parses baseline diff and write commands", () => {
    const diff = parseCliArgs(
      ["baseline", "diff", "--baseline", ".codemem/base.json", "--json"],
      "/repo",
    );
    const write = parseCliArgs(["baseline", "write", "--apply", "--json"], "/repo");

    expect(diff).toEqual({
      ok: true,
      command: {
        kind: "baseline-diff",
        baselinePath: ".codemem/base.json",
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
      },
    });
    expect(write).toEqual({
      ok: true,
      command: {
        kind: "baseline-write",
        baselinePath: undefined,
        dryRun: false,
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
      },
    });
  });

  test("parses impact, api-surface, layer-boundaries, and lockfile commands", () => {
    expect(
      parseCliArgs(["impact-cone", "--path", "src/a.ts", "--depth", "3", "--json"], "/repo"),
    ).toEqual({
      ok: true,
      command: {
        kind: "impact-cone",
        depth: 3,
        json: true,
        maxFiles: 50,
        path: "src/a.ts",
        projectRoot: "/repo",
      },
    });
    expect(parseCliArgs(["api-surface", "--json"], "/repo")).toEqual({
      ok: true,
      command: {
        kind: "api-surface",
        json: true,
        maxExports: 100,
        path: undefined,
        projectRoot: "/repo",
      },
    });
    expect(parseCliArgs(["layer-boundaries", "--max-findings", "7", "--json"], "/repo")).toEqual({
      ok: true,
      command: {
        kind: "layer-boundaries",
        json: true,
        maxFindings: 7,
        projectRoot: "/repo",
      },
    });
    expect(parseCliArgs(["lockfile", "--json"], "/repo")).toEqual({
      ok: true,
      command: {
        kind: "lockfile",
        json: true,
        projectRoot: "/repo",
      },
    });
  });

  test("parses change risk, review focus, and change delta commands", () => {
    expect(
      parseCliArgs(
        [
          "change-risk",
          "--path",
          "src/a.ts",
          "--path",
          "src/b.ts",
          "--depth",
          "3",
          "--max-findings",
          "25",
          "--json",
        ],
        "/repo",
      ),
    ).toEqual({
      ok: true,
      command: {
        kind: "change-risk",
        depth: 3,
        json: true,
        maxFiles: 50,
        maxFindings: 25,
        paths: ["src/a.ts", "src/b.ts"],
        pathsFromStdin: false,
        projectRoot: "/repo",
      },
    });
    expect(
      parseCliArgs(["before-edit", "--path", "src/a.ts", "--max-files", "12", "--json"], "/repo"),
    ).toEqual({
      ok: true,
      command: {
        kind: "before-edit",
        depth: 2,
        json: true,
        maxFiles: 12,
        maxFindings: 50,
        paths: ["src/a.ts"],
        pathsFromStdin: false,
        projectRoot: "/repo",
      },
    });
    expect(
      parseCliArgs(["before-edit", "--paths-stdin", "--json"], "/repo"),
    ).toEqual({
      ok: true,
      command: {
        kind: "before-edit",
        depth: 2,
        json: true,
        maxFiles: 50,
        maxFindings: 50,
        paths: [],
        pathsFromStdin: true,
        projectRoot: "/repo",
      },
    });
    expect(
      parseCliArgs(["review-focus", "--path", "src/a.ts", "--max-items", "7", "--json"], "/repo"),
    ).toEqual({
      ok: true,
      command: {
        kind: "review-focus",
        depth: 2,
        json: true,
        maxFiles: 50,
        maxFindings: 50,
        maxItems: 7,
        paths: ["src/a.ts"],
        pathsFromStdin: false,
        projectRoot: "/repo",
      },
    });
    expect(
      parseCliArgs(["change-delta", "--baseline", ".codemem/base.json", "--json"], "/repo"),
    ).toEqual({
      ok: true,
      command: {
        kind: "change-delta",
        baselinePath: ".codemem/base.json",
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
      },
    });
  });

  test("parses explain and report commands", () => {
    expect(parseCliArgs(["explain", "--id", "dead:src/a.ts:unused", "--json"], "/repo")).toEqual({
      ok: true,
      command: {
        kind: "explain",
        findingId: "dead:src/a.ts:unused",
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
      },
    });
    expect(parseCliArgs(["report", "--format", "sarif", "--json"], "/repo")).toEqual({
      ok: true,
      command: {
        kind: "report",
        format: "sarif",
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
      },
    });
  });

  test("parses artifact emission as dry-run unless apply is explicit", () => {
    expect(
      parseCliArgs(
        ["artifact", "--kind", "audit", "--slug", "codemem-audit", "--apply", "--json"],
        "/repo",
      ),
    ).toEqual({
      ok: true,
      command: {
        kind: "artifact",
        artifactKind: "audit",
        dryRun: false,
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
        slug: "codemem-audit",
      },
    });
    expect(parseCliArgs(["artifact", "--kind", "journal", "--json"], "/repo")).toEqual({
      ok: true,
      command: {
        kind: "artifact",
        artifactKind: "journal",
        dryRun: true,
        json: true,
        maxFindings: 50,
        projectRoot: "/repo",
        slug: "codemem-audit",
      },
    });
  });

  test("rejects option values that are missing or look like flags", () => {
    expect(parseCliArgs(["check", "--path", "--json"], "/repo")).toEqual({
      ok: false,
      exitCode: 2,
      message: "Missing value for --path\n\nExample: codemem check --path src/index.ts",
    });
    expect(parseCliArgs(["impact-cone", "--path", "src/a.ts", "--depth", "zero"], "/repo")).toEqual(
      {
        ok: false,
        exitCode: 2,
        message:
          "Invalid --depth value: zero\n\nExample: codemem impact-cone --path src/index.ts --depth 2",
      },
    );
  });

  test("prints layered subcommand help without root option spam", () => {
    const parsed = parseCliArgs(["check", "--help"], "/repo");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected help");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.message).toContain("Usage: codemem check");
    expect(parsed.message).toContain("Examples:");
    expect(parsed.message).toContain("codemem check --path src/index.ts --max-findings 25 --json");
    expect(parsed.message).not.toContain("Commands:");
  });

  test("unknown options return one actionable example", () => {
    const parsed = parseCliArgs(["check", "--wat"], "/repo");

    expect(parsed).toEqual({
      ok: false,
      exitCode: 2,
      message: "Unknown codemem option: --wat\n\nExample: codemem check --path src/index.ts --json",
    });
  });
});

describe("runCodeMemCli", () => {
  test("prints status as json", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime: CliRuntime = {
      async status() {
        return {
          health: {
            protocolVersion: 1,
            schemaVersion: 1,
            daemonVersion: "0.1.0",
            projectRoot: "/repo",
            startedAtUnixMs: 1,
            healthy: true,
            queueDepth: 0,
            indexedFiles: 2,
            findingsCacheEntries: 0,
            metrics: {
              operations: {},
              counters: {},
              capturedAtUnixMs: 1,
            },
          },
          lifecycle: {
            pid: 123,
            endpoint: "/repo/.git/codemem/run/codemem.sock",
            pidFile: "/repo/.git/codemem/run/codemem.pid",
            stdoutLogFile: "/repo/.git/codemem/log/daemon.stdout.log",
            stderrLogFile: "/repo/.git/codemem/log/daemon.stderr.log",
            lifecycleLogFile: "/repo/.git/codemem/log/daemon.lifecycle.jsonl",
          },
          stateDirectory: "/repo/.git/codemem",
          protocolVersion: 1,
        };
      },
      async check() {
        throw new Error("check should not run");
      },
      async driftMap() {
        throw new Error("drift-map should not run");
      },
      async conflicts() {
        throw new Error("conflicts should not run");
      },
      async maintain() {
        throw new Error("maintain should not run");
      },
      async rebuild() {
        throw new Error("rebuild should not run");
      },
    };

    const exitCode = await runCodeMemCli(["status", "--json", "--project-root", "/repo"], {
      cwd: "/repo",
      runtime,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      health: {
        protocolVersion: 1,
        schemaVersion: 1,
        daemonVersion: "0.1.0",
        projectRoot: "/repo",
        startedAtUnixMs: 1,
        healthy: true,
        queueDepth: 0,
        indexedFiles: 2,
        findingsCacheEntries: 0,
        metrics: {
          operations: {},
          counters: {},
          capturedAtUnixMs: 1,
        },
      },
        lifecycle: {
          pid: 123,
          endpoint: "/repo/.git/codemem/run/codemem.sock",
          pidFile: "/repo/.git/codemem/run/codemem.pid",
          stdoutLogFile: "/repo/.git/codemem/log/daemon.stdout.log",
          stderrLogFile: "/repo/.git/codemem/log/daemon.stderr.log",
          lifecycleLogFile: "/repo/.git/codemem/log/daemon.lifecycle.jsonl",
        },
      stateDirectory: "/repo/.git/codemem",
      protocolVersion: 1,
    });
  });

  test("prints doctor as canonical ok health report", async () => {
    const stdout: string[] = [];
    const runtime: CliRuntime = {
      async status() {
        return {
          health: {
            protocolVersion: 1,
            schemaVersion: 1,
            daemonVersion: "0.1.0",
            projectRoot: "/repo",
            startedAtUnixMs: 1,
            healthy: true,
            queueDepth: 0,
            indexedFiles: 2,
            findingsCacheEntries: 0,
            metrics: {
              operations: {},
              counters: {},
              capturedAtUnixMs: 1,
            },
          },
          stateDirectory: "/repo/.git/codemem",
          protocolVersion: 1,
        };
      },
      async check() {
        throw new Error("check should not run");
      },
      async driftMap() {
        throw new Error("drift-map should not run");
      },
      async conflicts() {
        throw new Error("conflicts should not run");
      },
      async maintain() {
        throw new Error("maintain should not run");
      },
      async rebuild() {
        throw new Error("rebuild should not run");
      },
    };

    const exitCode = await runCodeMemCli(["doctor", "--json", "--project-root", "/repo"], {
      cwd: "/repo",
      runtime,
      stdout: (line) => stdout.push(line),
    });

    const parsed: unknown = JSON.parse(stdout.join("\n"));
    const validation = validateHealthReport(parsed);

    expect(exitCode).toBe(0);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error(validation.errors.join("; "));
    expect(validation.value.status).toBe("ok");
  });

  test("prints doctor as canonical failing health report when daemon health is unhealthy", async () => {
    const stdout: string[] = [];
    const runtime: CliRuntime = {
      async status() {
        return {
          health: {
            protocolVersion: 1,
            schemaVersion: 1,
            daemonVersion: "0.1.0",
            projectRoot: "/repo",
            startedAtUnixMs: 1,
            healthy: false,
            queueDepth: 0,
            indexedFiles: 2,
            findingsCacheEntries: 0,
          },
          stateDirectory: "/repo/.git/codemem",
          protocolVersion: 1,
        };
      },
      async check() {
        throw new Error("check should not run");
      },
      async driftMap() {
        throw new Error("drift-map should not run");
      },
      async conflicts() {
        throw new Error("conflicts should not run");
      },
      async maintain() {
        throw new Error("maintain should not run");
      },
      async rebuild() {
        throw new Error("rebuild should not run");
      },
    };

    const exitCode = await runCodeMemCli(["doctor", "--json", "--project-root", "/repo"], {
      cwd: "/repo",
      runtime,
      stdout: (line) => stdout.push(line),
    });
    const parsed: unknown = JSON.parse(stdout.join("\n"));
    const validation = validateHealthReport(parsed);

    expect(exitCode).toBe(0);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error(validation.errors.join("; "));
    expect(validation.value.status).toBe("fail");
  });

  test("prints maintain dry-run result as json", async () => {
    const stdout: string[] = [];
    const runtime: CliRuntime = {
      async status() {
        throw new Error("status should not run");
      },
      async check() {
        throw new Error("check should not run");
      },
      async driftMap() {
        throw new Error("drift-map should not run");
      },
      async conflicts() {
        throw new Error("conflicts should not run");
      },
      async maintain(command) {
        expect(command.dryRun).toBe(true);
        return {
          applied: false,
          actions: [{ kind: "compact", detail: "VACUUM the sqlite store and checkpoint WAL" }],
        };
      },
      async rebuild() {
        throw new Error("rebuild should not run");
      },
    };

    const exitCode = await runCodeMemCli(["maintain", "--compact", "--json"], {
      cwd: "/repo",
      runtime,
      stdout: (line) => stdout.push(line),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      applied: false,
      actions: [{ kind: "compact", detail: "VACUUM the sqlite store and checkpoint WAL" }],
    });
  });

  test("prints check result as predictable text", async () => {
    const stdout: string[] = [];
    const runtime: CliRuntime = {
      async status() {
        throw new Error("status should not run");
      },
      async check() {
        return {
          findings: [],
          truncated: false,
          indexedAtUnixMs: 123,
          stats: {
            filesIndexed: 2,
            scanLatencyMs: 5,
            cloneBuckets: 0,
            typeBuckets: 0,
            sessionsTracked: 0,
          },
        };
      },
      async driftMap() {
        throw new Error("drift-map should not run");
      },
      async conflicts() {
        throw new Error("conflicts should not run");
      },
      async maintain() {
        throw new Error("maintain should not run");
      },
      async rebuild() {
        throw new Error("rebuild should not run");
      },
    };

    const exitCode = await runCodeMemCli(["check", "--path", "src/index.ts"], {
      cwd: "/repo",
      runtime,
      stdout: (line) => stdout.push(line),
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toBe("findings: 0\ntruncated: false\nindexed_at_unix_ms: 123");
  });

  test("reports actionable parse errors on stderr", async () => {
    const stderr: string[] = [];

    const exitCode = await runCodeMemCli(["check", "--max-findings", "zero"], {
      cwd: "/repo",
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Invalid --max-findings value: zero");
    expect(stderr.join("\n")).toContain("Example: codemem check --max-findings 25");
  });

  test("reports parse errors as JSON envelopes when json is requested", async () => {
    const stderr: string[] = [];

    const exitCode = await runCodeMemCli(["check", "--max-findings", "zero", "--json"], {
      cwd: "/repo",
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stderr.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_CODEMEM_CLI_USAGE");
    expect(parsed.error.example).toBe("codemem check --max-findings 25");
    expect(parsed.operation.name).toBe("check");
  });

  test("hydrates before-edit paths from stdin", async () => {
    const stdout: string[] = [];
    const seenPaths: string[][] = [];
    const runtime: CliRuntime = {
      async status() {
        throw new Error("status should not run");
      },
      async check() {
        throw new Error("check should not run");
      },
      async driftMap() {
        throw new Error("drift-map should not run");
      },
      async conflicts() {
        throw new Error("conflicts should not run");
      },
      async maintain() {
        throw new Error("maintain should not run");
      },
      async rebuild() {
        throw new Error("rebuild should not run");
      },
      async beforeEdit(command) {
        seenPaths.push(command.paths);
        return {
          score: 10,
          level: "low",
          paths: command.paths,
          depth: command.depth,
          reasons: [],
          impactedFiles: ["src/a.ts"],
          focus: [],
          indexedAtUnixMs: 123,
          stats: {
            impactedFiles: 1,
            reverseDependents: 0,
            publicExports: 0,
            findings: 0,
            sessionConflicts: 0,
          },
        };
      },
      async changeRisk() {
        throw new Error("change-risk should not run");
      },
      async reviewFocus() {
        throw new Error("review-focus should not run");
      },
      async changeDelta() {
        throw new Error("change-delta should not run");
      },
      async baselineDiff() {
        throw new Error("baseline diff should not run");
      },
      async baselineWrite() {
        throw new Error("baseline write should not run");
      },
      async impactCone() {
        throw new Error("impact-cone should not run");
      },
      async apiSurface() {
        throw new Error("api-surface should not run");
      },
      async layerBoundaries() {
        throw new Error("layer-boundaries should not run");
      },
      async lockfile() {
        throw new Error("lockfile should not run");
      },
    };

    const exitCode = await runCodeMemCli(["before-edit", "--paths-stdin", "--json"], {
      cwd: "/repo",
      runtime,
      stdin: async () => "src/a.ts\nsrc/b.ts\n",
      stdout: (line) => stdout.push(line),
    });

    expect(exitCode).toBe(0);
    expect(seenPaths).toEqual([["src/a.ts", "src/b.ts"]]);
    expect(JSON.parse(stdout.join("\n")).safeToEdit).toBe(true);
  });

  test("smokes status through the daemon protocol against a fixture project", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-cli-smoke-"));
    const socketPath = path.join(tempRoot, "codemem.sock");
    const stdout: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeFrames(buffer);
        buffer = decoded.remainder;
        for (const message of decoded.messages) {
          if (!("method" in message) || !("id" in message)) {
            continue;
          }
          if (message.method !== "maintenance.status") {
            continue;
          }
          const response: RpcResponseEnvelope = {
            jsonrpc: "2.0",
            protocolVersion: CODEMEM_PROTOCOL_VERSION,
            id: message.id,
            result: {
              health: {
                protocolVersion: CODEMEM_PROTOCOL_VERSION,
                schemaVersion: 1,
                daemonVersion: "0.1.0-test",
                projectRoot: tempRoot,
                startedAtUnixMs: 1,
                healthy: true,
                queueDepth: 0,
                indexedFiles: 0,
                findingsCacheEntries: 0,
              },
              stateDirectory: path.join(tempRoot, ".codemem"),
              protocolVersion: CODEMEM_PROTOCOL_VERSION,
            },
          };
          socket.write(encodeFrame(response));
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const client = new DaemonClient({
        address: socketPath,
        maxPayloadBytes: 1024 * 1024,
        connectTimeoutMs: 250,
        requestTimeoutMs: 1000,
      });
      const runtime: CliRuntime = {
        status: (projectRoot) => client.status({ projectRoot }),
        async check() {
          throw new Error("check should not run");
        },
        async driftMap() {
          throw new Error("drift-map should not run");
        },
        async conflicts() {
          throw new Error("conflicts should not run");
        },
        async maintain() {
          throw new Error("maintain should not run");
        },
        async rebuild() {
          throw new Error("rebuild should not run");
        },
      };

      const exitCode = await runCodeMemCli(["status", "--json", "--project-root", tempRoot], {
        cwd: tempRoot,
        runtime,
        stdout: (line) => stdout.push(line),
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join("\n")).health.daemonVersion).toBe("0.1.0-test");
    } finally {
      server.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

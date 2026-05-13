import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeMemConfig } from "@mazac-fox/codemem-shared/config";
import { CODEMEM_PROTOCOL_VERSION, type HealthResponse } from "@mazac-fox/codemem-shared/protocol";
import { makeEnvelope } from "@mazac-fox/opencode-fleet-contracts";
import { emitFleet } from "@mazac-fox/opencode-host-adapter";
import { DaemonClient, type DaemonEndpoint } from "./client";

export type SupervisorOptions = {
  projectRoot: string;
  stateDirectory: string;
  config: CodeMemConfig;
};

export type DaemonCommandResolutionOptions = {
  projectRoot: string;
  config: CodeMemConfig;
  packageRoot?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
};

export type SupervisorStatus = {
  started: boolean;
  reused: boolean;
  endpoint: string;
  pidFile: string;
  authTokenFile: string;
  startLockFile: string;
  stdoutLogFile: string;
  stderrLogFile: string;
  lifecycleLogFile: string;
  health?: HealthResponse;
  warning?: string;
  staleCleanup?: StaleEndpointCleanup;
};

export type LifecycleLogPaths = {
  stdout: string;
  stderr: string;
  lifecycle: string;
};

export type StaleEndpointCleanup = {
  pid: number | null;
  pidAlive: boolean;
  removedEndpoint: boolean;
  removedPidFile: boolean;
};

export type DaemonStopResult = {
  stopped: boolean;
  pid: number | null;
  endpoint: string;
  pidFile: string;
  shutdownRequested: boolean;
  signaled: boolean;
  staleCleanup: StaleEndpointCleanup;
  warning?: string;
};

export class DaemonSupervisor {
  private readonly projectRoot: string;
  private readonly stateDirectory: string;
  private readonly config: CodeMemConfig;
  private readonly endpointAddress: string;
  private readonly pidFile: string;
  private readonly startLockFile: string;
  private readonly authTokenFile: string;
  private readonly authToken: string;
  private readonly logs: LifecycleLogPaths;
  private startPromise: Promise<SupervisorStatus> | null = null;
  private lastWarning: string | null = null;

  constructor(options: SupervisorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.config = options.config;
    const fingerprint = projectFingerprint(this.projectRoot);
    this.endpointAddress = resolveEndpointAddress(this.stateDirectory, fingerprint);
    this.pidFile = path.join(this.stateDirectory, "run", "codemem.pid");
    this.startLockFile = path.join(this.stateDirectory, "run", "codemem.start.lock");
    this.authTokenFile = path.join(this.stateDirectory, "run", "codemem.token");
    this.authToken = readExistingAuthToken(this.authTokenFile) ?? crypto.randomBytes(16).toString("hex");
    this.logs = resolveLifecycleLogPaths(this.stateDirectory);
  }

  get warning(): string | null {
    return this.lastWarning;
  }

  createClient(): DaemonClient {
    const endpoint: DaemonEndpoint = {
      address: this.endpointAddress,
      authToken: this.authToken,
      maxPayloadBytes: this.config.daemon.maxPayloadBytes,
      connectTimeoutMs: this.config.daemon.healthTimeoutMs,
      requestTimeoutMs: this.config.daemon.requestTimeoutMs,
    };
    return new DaemonClient(endpoint);
  }

  async health(): Promise<HealthResponse | null> {
    try {
      return await this.createClient().health({ projectRoot: this.projectRoot });
    } catch {
      return null;
    }
  }

  async ensureDaemon(waitForReady: boolean): Promise<SupervisorStatus> {
    const healthy = await this.health();
    if (healthy) {
      await this.recordLifecycle("daemon.attach", { reused: true, pidFile: this.pidFile });
      return {
        started: true,
        reused: true,
        endpoint: this.endpointAddress,
        pidFile: this.pidFile,
        startLockFile: this.startLockFile,
        authTokenFile: this.authTokenFile,
        stdoutLogFile: this.logs.stdout,
        stderrLogFile: this.logs.stderr,
        lifecycleLogFile: this.logs.lifecycle,
        health: healthy,
      };
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.start(waitForReady).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async maybeStartDetached(): Promise<void> {
    await this.ensureDaemon(false);
  }

  async cleanupStale(): Promise<StaleEndpointCleanup> {
    return cleanupStaleEndpoint(this.endpointAddress, this.pidFile);
  }

  async stop(): Promise<DaemonStopResult> {
    const pid = await readPid(this.pidFile);
    let shutdownRequested = false;
    let signaled = false;
    const healthy = await this.health();
    if (healthy) {
      try {
        const response = await this.createClient().shutdown({ projectRoot: this.projectRoot });
        shutdownRequested = response.accepted;
      } catch (error) {
        this.lastWarning = `Failed to request codemem-daemon shutdown: ${String(error)}`;
        await this.recordLifecycle("daemon.stop_failed", { warning: this.lastWarning });
      }
    }
    const exitedAfterShutdown = pid ? await waitForPidExit(pid, 1_000) : true;
    if (pid && !exitedAfterShutdown && isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        signaled = true;
      } catch (error) {
        this.lastWarning = `Failed to signal codemem-daemon ${pid}: ${String(error)}`;
        await this.recordLifecycle("daemon.stop_failed", { warning: this.lastWarning, pid });
      }
    }
    const exitedAfterSignal = pid ? await waitForPidExit(pid, 1_000) : true;
    const staleCleanup = await cleanupStaleEndpoint(this.endpointAddress, this.pidFile);
    const stopped = !pid || exitedAfterShutdown || exitedAfterSignal || !isPidAlive(pid);
    await this.recordLifecycle(stopped ? "daemon.stopped" : "daemon.stop_failed", {
      pid,
      shutdownRequested,
      signaled,
      stopped,
    });
    const result: DaemonStopResult = {
      stopped,
      pid,
      endpoint: this.endpointAddress,
      pidFile: this.pidFile,
      shutdownRequested,
      signaled,
      staleCleanup,
    };
    if (!stopped) {
      result.warning = this.lastWarning ?? `codemem-daemon ${pid} is still alive`;
    }
    return result;
  }

  private async start(waitForReady: boolean): Promise<SupervisorStatus> {
    await fs.mkdir(path.join(this.stateDirectory, "run"), { recursive: true });
    await fs.mkdir(path.join(this.stateDirectory, "log"), { recursive: true });
    await fs.writeFile(this.authTokenFile, this.authToken, { mode: 0o600 });
    const staleCleanup = await cleanupStaleEndpoint(this.endpointAddress, this.pidFile);
    if (staleCleanup.removedEndpoint || staleCleanup.removedPidFile) {
      await this.recordLifecycle("daemon.stale_cleaned", staleCleanup);
    }

    const startLock = await acquireStartLock(this.startLockFile);
    if (!startLock.acquired) {
      await this.recordLifecycle("daemon.start_wait", {
        lockOwnerPid: startLock.ownerPid,
        lockPath: this.startLockFile,
      });
      const attached = await this.waitForHealthy(waitForReady);
      if (attached) {
        return {
          started: true,
          reused: true,
          endpoint: this.endpointAddress,
          pidFile: this.pidFile,
          startLockFile: this.startLockFile,
          authTokenFile: this.authTokenFile,
          stdoutLogFile: this.logs.stdout,
          stderrLogFile: this.logs.stderr,
          lifecycleLogFile: this.logs.lifecycle,
          health: attached,
          staleCleanup,
        };
      }
      this.lastWarning = `codemem-daemon did not become healthy while another process held ${this.startLockFile}`;
      await this.recordLifecycle("daemon.start_failed", { warning: this.lastWarning });
      return this.unavailableStatus(staleCleanup);
    }

    let releaseLockOnExit = true;
    try {
      const command = await this.resolveCommand();
      const env = {
        ...process.env,
        CODEMEM_PROJECT_ROOT: this.projectRoot,
        CODEMEM_STATE_DIR: this.stateDirectory,
        CODEMEM_ENDPOINT: this.endpointAddress,
        CODEMEM_AUTH_TOKEN: this.authToken,
        CODEMEM_PROTOCOL_VERSION: String(CODEMEM_PROTOCOL_VERSION),
      };

      if (typeof Bun === "undefined") {
        this.lastWarning = "Bun runtime unavailable; cannot launch codemem-daemon from plugin";
        await this.recordLifecycle("daemon.start_failed", { warning: this.lastWarning });
        return this.unavailableStatus(staleCleanup);
      }

      try {
        const child = spawnDetached(command, this.projectRoot, env, this.logs);
        if (!child.pid) {
          throw new Error("spawn returned no child pid");
        }
        await fs.writeFile(this.pidFile, String(child.pid), { mode: 0o600 });
        await this.recordLifecycle("daemon.spawned", { pid: child.pid, stdout: this.logs.stdout, stderr: this.logs.stderr });
      } catch (error) {
        this.lastWarning = `Failed to spawn codemem-daemon: ${String(error)}`;
        await this.recordLifecycle("daemon.start_failed", { warning: this.lastWarning });
        return this.unavailableStatus(staleCleanup);
      }

      if (!waitForReady) {
        releaseLockOnExit = false;
        void this.waitForHealthy(true).finally(() => releaseStartLock(this.startLockFile));
        return {
          started: true,
          reused: false,
          endpoint: this.endpointAddress,
          pidFile: this.pidFile,
          startLockFile: this.startLockFile,
          authTokenFile: this.authTokenFile,
          stdoutLogFile: this.logs.stdout,
          stderrLogFile: this.logs.stderr,
          lifecycleLogFile: this.logs.lifecycle,
          staleCleanup,
        };
      }

      const healthy = await this.waitForHealthy(true);
      if (healthy) {
        this.lastWarning = null;
        return {
          started: true,
          reused: false,
          endpoint: this.endpointAddress,
          pidFile: this.pidFile,
          startLockFile: this.startLockFile,
          authTokenFile: this.authTokenFile,
          stdoutLogFile: this.logs.stdout,
          stderrLogFile: this.logs.stderr,
          lifecycleLogFile: this.logs.lifecycle,
          health: healthy,
          staleCleanup,
        };
      }

      this.lastWarning = `codemem-daemon did not become healthy within ${this.config.daemon.spawnTimeoutMs}ms`;
      await this.recordLifecycle("daemon.start_failed", { warning: this.lastWarning });
      return this.unavailableStatus(staleCleanup);
    } finally {
      if (releaseLockOnExit) {
        await releaseStartLock(this.startLockFile);
      }
    }
  }

  private async waitForHealthy(waitForReady: boolean): Promise<HealthResponse | null> {
    if (!waitForReady) {
      return null;
    }
    const deadline = Date.now() + this.config.daemon.spawnTimeoutMs;
    while (Date.now() < deadline) {
      const healthy = await this.health();
      if (healthy) {
        return healthy;
      }
      await sleep(60);
    }
    return null;
  }

  private unavailableStatus(staleCleanup?: StaleEndpointCleanup): SupervisorStatus {
    const status: SupervisorStatus = {
      started: false,
      reused: false,
      endpoint: this.endpointAddress,
      pidFile: this.pidFile,
      startLockFile: this.startLockFile,
      authTokenFile: this.authTokenFile,
      stdoutLogFile: this.logs.stdout,
      stderrLogFile: this.logs.stderr,
      lifecycleLogFile: this.logs.lifecycle,
    };
    if (this.lastWarning !== null) {
      status.warning = this.lastWarning;
    }
    if (staleCleanup) {
      status.staleCleanup = staleCleanup;
    }
    return status;
  }

  private async resolveCommand(): Promise<string[]> {
    return resolveDaemonCommand({
      projectRoot: this.projectRoot,
      config: this.config,
    });
  }

  private async recordLifecycle(kind: `${string}.${string}`, detail: Record<string, unknown>): Promise<void> {
    emitDaemonTelemetry("codemem", kind, detail);
    try {
      await fs.mkdir(path.dirname(this.logs.lifecycle), { recursive: true });
      await fs.appendFile(
        this.logs.lifecycle,
        `${JSON.stringify({ ts: new Date().toISOString(), kind, ...detail })}\n`,
      );
    } catch {
      // lifecycle logging is best-effort and must not break daemon startup
    }
  }
}

function emitDaemonTelemetry(
  plugin: string,
  kind: `${string}.${string}`,
  detail: Record<string, unknown>,
): void {
  const errorMessage = typeof detail.warning === "string" ? detail.warning : undefined;
  emitFleet(
    makeEnvelope({
      kind,
      plugin,
      status: errorMessage ? "error" : "ok",
      error: errorMessage ? { message: errorMessage } : undefined,
    }),
  );
}

export async function resolveDaemonCommand(options: DaemonCommandResolutionOptions): Promise<string[]> {
  if (options.config.daemon.command?.length) {
    return [...options.config.daemon.command];
  }

  if (options.config.daemon.binaryPath) {
    return [path.resolve(options.projectRoot, options.config.daemon.binaryPath)];
  }

  const env = options.env ?? process.env;
  if (env.CODEMEM_DAEMON_BIN) {
    return [env.CODEMEM_DAEMON_BIN];
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const packagedBinary = await resolvePackagedBinary(packageRoot, platform, arch);
  if (packagedBinary) {
    return [packagedBinary];
  }

  const developmentBinary = await resolveDevelopmentBinary(options.projectRoot, platform);
  if (developmentBinary) {
    return [developmentBinary];
  }

  throw new Error(
    "Unable to resolve codemem-daemon binary. Set codemem.daemon.binaryPath, CODEMEM_DAEMON_BIN, or install the packaged daemon binary.",
  );
}

export function projectFingerprint(projectRoot: string): string {
  return crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
}

export function resolveEndpointAddress(stateDirectory: string, fingerprint: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codemem-${fingerprint}`;
  }

  const preferred = path.join(stateDirectory, "run", "codemem.sock");
  if (preferred.length <= 100) {
    return preferred;
  }
  return path.join(os.tmpdir(), `codemem-${fingerprint}.sock`);
}

export function resolveLifecycleLogPaths(stateDirectory: string): LifecycleLogPaths {
  const logDirectory = path.join(stateDirectory, "log");
  return {
    stdout: path.join(logDirectory, "daemon.stdout.log"),
    stderr: path.join(logDirectory, "daemon.stderr.log"),
    lifecycle: path.join(logDirectory, "daemon.lifecycle.jsonl"),
  };
}

export async function cleanupStaleEndpoint(
  endpointAddress: string,
  pidFile: string,
): Promise<StaleEndpointCleanup> {
  const pid = await readPid(pidFile);
  const alive = pid ? isPidAlive(pid) : false;
  if (alive) {
    return { pid, pidAlive: true, removedEndpoint: false, removedPidFile: false };
  }

  let removedEndpoint = false;
  if (process.platform !== "win32") {
    try {
      await fs.rm(endpointAddress, { force: true });
      removedEndpoint = true;
    } catch {
      // ignore stale socket removal errors
    }
  }

  let removedPidFile = false;
  try {
    await fs.rm(pidFile, { force: true });
    removedPidFile = true;
  } catch {
    // ignore stale pid file removal errors
  }
  return { pid, pidAlive: false, removedEndpoint, removedPidFile };
}

async function readPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidFile, "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readExistingAuthToken(authTokenFile: string): string | null {
  try {
    const token = fsSync.readFileSync(authTokenFile, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(40);
  }
  return !isPidAlive(pid);
}

type StartLockResult =
  | { acquired: true; ownerPid?: number; staleRemoved: boolean }
  | { acquired: false; ownerPid?: number; staleRemoved: boolean };

async function acquireStartLock(lockPath: string): Promise<StartLockResult> {
  const ownerPid = await readPid(lockPath);
  const staleRemoved = ownerPid ? !isPidAlive(ownerPid) : false;
  if (staleRemoved) {
    await fs.rm(lockPath, { force: true });
  }
  try {
    writeExclusiveFile(lockPath, `${currentPid()}\n`);
    return startLockResult(true, ownerPid, staleRemoved);
  } catch {
    return startLockResult(false, ownerPid, staleRemoved);
  }
}

async function releaseStartLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true });
}

function spawnDetached(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  logs: LifecycleLogPaths,
) {
  const executable = command[0];
  if (!executable) {
    throw new Error("daemon command is empty");
  }
  fsSync.mkdirSync(path.dirname(logs.stdout), { recursive: true });
  const spawnEnv = {
    ...env,
    CODEMEM_DAEMON_STDOUT: logs.stdout,
    CODEMEM_DAEMON_STDERR: logs.stderr,
  };
  const cmd =
    process.platform === "win32"
      ? [executable, ...command.slice(1)]
      : [
          "/bin/sh",
          "-c",
          'exec "$0" "$@" >> "$CODEMEM_DAEMON_STDOUT" 2>> "$CODEMEM_DAEMON_STDERR"',
          executable,
          ...command.slice(1),
        ];
  return Bun.spawn({
    cmd,
    cwd,
    env: spawnEnv,
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

function writeExclusiveFile(filePath: string, content: string): void {
  const openSync = Reflect.get(fsSync, "openSync");
  const writeFileSync = Reflect.get(fsSync, "writeFileSync");
  const closeSync = Reflect.get(fsSync, "closeSync");
  if (
    typeof openSync !== "function" ||
    typeof writeFileSync !== "function" ||
    typeof closeSync !== "function"
  ) {
    throw new Error("exclusive file creation is unavailable");
  }
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function currentPid(): number {
  const pid = Reflect.get(process, "pid");
  if (typeof pid === "number" && Number.isFinite(pid)) {
    return pid;
  }
  return 0;
}

function startLockResult(
  acquired: boolean,
  ownerPid: number | null,
  staleRemoved: boolean,
): StartLockResult {
  if (ownerPid === null) {
    return { acquired, staleRemoved };
  }
  return { acquired, ownerPid, staleRemoved };
}

function defaultPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}

async function resolvePackagedBinary(packageRoot: string, platform: string, arch: string): Promise<string | null> {
  const extension = platform === "win32" ? ".exe" : "";
  const candidates = [path.resolve(packageRoot, `bin/${platform}-${arch}/codemem-daemon${extension}`)];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing package binary candidates
    }
  }
  return null;
}

async function resolveDevelopmentBinary(projectRoot: string, platform: string): Promise<string | null> {
  const extension = platform === "win32" ? ".exe" : "";
  const candidates = [
    path.resolve(projectRoot, `packages/codemem-daemon/target/release/codemem-daemon${extension}`),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing development binary candidates
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

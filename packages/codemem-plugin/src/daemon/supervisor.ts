import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeMemConfig } from "@codemem/shared/config";
import { CODEMEM_PROTOCOL_VERSION, type HealthResponse } from "@codemem/shared/protocol";
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
  endpoint: string;
  pidFile: string;
  authTokenFile: string;
  health?: HealthResponse;
  warning?: string;
};

export class DaemonSupervisor {
  private readonly projectRoot: string;
  private readonly stateDirectory: string;
  private readonly config: CodeMemConfig;
  private readonly endpointAddress: string;
  private readonly pidFile: string;
  private readonly authTokenFile: string;
  private readonly authToken: string;
  private startPromise: Promise<SupervisorStatus> | null = null;
  private lastWarning: string | null = null;

  constructor(options: SupervisorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.config = options.config;
    const fingerprint = projectFingerprint(this.projectRoot);
    this.endpointAddress = resolveEndpointAddress(this.stateDirectory, fingerprint);
    this.pidFile = path.join(this.stateDirectory, "run", "codemem.pid");
    this.authTokenFile = path.join(this.stateDirectory, "run", "codemem.token");
    this.authToken = readExistingAuthToken(this.authTokenFile) ?? crypto.randomBytes(16).toString("hex");
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
      return {
        started: true,
        endpoint: this.endpointAddress,
        pidFile: this.pidFile,
        authTokenFile: this.authTokenFile,
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

  private async start(waitForReady: boolean): Promise<SupervisorStatus> {
    await fs.mkdir(path.join(this.stateDirectory, "run"), { recursive: true });
    await fs.mkdir(path.join(this.stateDirectory, "log"), { recursive: true });
    await fs.writeFile(this.authTokenFile, this.authToken, { mode: 0o600 });
    await removeStaleEndpoint(this.endpointAddress, this.pidFile);

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
      return {
        started: false,
        endpoint: this.endpointAddress,
        pidFile: this.pidFile,
        authTokenFile: this.authTokenFile,
        warning: this.lastWarning,
      };
    }

    try {
      const child = Bun.spawn({
        cmd: command,
        cwd: this.projectRoot,
        env,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });

      await fs.writeFile(this.pidFile, String(child.pid), { mode: 0o600 });
    } catch (error) {
      this.lastWarning = `Failed to spawn codemem-daemon: ${String(error)}`;
      return {
        started: false,
        endpoint: this.endpointAddress,
        pidFile: this.pidFile,
        authTokenFile: this.authTokenFile,
        warning: this.lastWarning,
      };
    }

    if (!waitForReady) {
      return {
        started: true,
        endpoint: this.endpointAddress,
        pidFile: this.pidFile,
        authTokenFile: this.authTokenFile,
      };
    }

    const deadline = Date.now() + this.config.daemon.spawnTimeoutMs;
    while (Date.now() < deadline) {
      const healthy = await this.health();
      if (healthy) {
        this.lastWarning = null;
        return {
          started: true,
          endpoint: this.endpointAddress,
          pidFile: this.pidFile,
          authTokenFile: this.authTokenFile,
          health: healthy,
        };
      }
      await sleep(60);
    }

    this.lastWarning = `codemem-daemon did not become healthy within ${this.config.daemon.spawnTimeoutMs}ms`;
    return {
      started: false,
      endpoint: this.endpointAddress,
      pidFile: this.pidFile,
      authTokenFile: this.authTokenFile,
      warning: this.lastWarning,
    };
  }

  private async resolveCommand(): Promise<string[]> {
    return resolveDaemonCommand({
      projectRoot: this.projectRoot,
      config: this.config,
    });
  }
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

async function removeStaleEndpoint(endpointAddress: string, pidFile: string): Promise<void> {
  const pid = await readPid(pidFile);
  const alive = pid ? isPidAlive(pid) : false;
  if (alive) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      await fs.rm(endpointAddress, { force: true });
    } catch {
      // ignore stale socket removal errors
    }
  }

  try {
    await fs.rm(pidFile, { force: true });
  } catch {
    // ignore stale pid file removal errors
  }
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

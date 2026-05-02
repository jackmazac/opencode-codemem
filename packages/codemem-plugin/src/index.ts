import path from "node:path";
import {
  buildPromptSignal,
  compareSeverity,
  type CodeMemFinding,
  type FilesChangedNotification,
  type Severity,
} from "@codemem/shared/protocol";
import { loadCodeMemConfig, resolveStateDirectory, type LoadedCodeMemConfig } from "@codemem/shared/config";
import type { Plugin } from "@opencode-ai/plugin";
import { createCodeMemTools, type CodeMemToolRuntime } from "./tools";
import { DaemonSupervisor } from "./daemon/supervisor";
import type { DaemonClient } from "./daemon/client";

const WRITE_LIKE_TOOL = /(write|edit|patch|replace|create|delete|rename|move|file)/i;
const CODE_FILE = /\.(?:[cm]?tsx?|jsx?)$/i;

class PluginRuntime implements CodeMemToolRuntime {
  readonly projectRoot: string;
  private readonly client: any;
  private loadedConfig: Promise<LoadedCodeMemConfig> | null = null;
  private supervisorPromise: Promise<DaemonSupervisor> | null = null;
  private readonly pendingFiles = new Map<string, Set<string>>();
  private readonly pendingReason = new Map<string, FilesChangedNotification["reason"]>();
  private readonly pendingTimer = new Map<string, NodeJS.Timeout>();
  private readonly injectedAt = new Map<string, number>();
  private readonly turnCounter = new Map<string, number>();

  constructor(projectRoot: string, client: any) {
    this.projectRoot = projectRoot;
    this.client = client;
  }

  getConfig(): Promise<LoadedCodeMemConfig> {
    if (!this.loadedConfig) {
      this.loadedConfig = loadCodeMemConfig(this.projectRoot);
    }
    const current = this.loadedConfig;
    return current;
  }

  async ensureReady(options?: { waitForReady: boolean }): Promise<DaemonClient> {
    const supervisor = await this.getSupervisor();
    const status = await supervisor.ensureDaemon(options?.waitForReady ?? true);
    if (!status.started) {
      throw new Error(status.warning ?? "codemem-daemon unavailable");
    }
    return supervisor.createClient();
  }

  async maybeInjectSignals(sessionID: string, findings: CodeMemFinding[]): Promise<void> {
    const loaded = await this.getConfig();
    const policy = loaded.config.promptInjection;
    if (!policy.enabled || policy.mode === "off") {
      return;
    }

    const eligible = findings
      .filter((finding) => compareSeverity(finding.severity, policy.minSeverity) >= 0)
      .filter((finding) => finding.confidence >= loaded.config.thresholds.promptInjectionMinConfidence)
      .slice(0, policy.maxSignalsPerTurn);

    if (eligible.length === 0) {
      return;
    }

    const last = this.injectedAt.get(sessionID) ?? 0;
    const now = Date.now();
    if (now - last < policy.cooldownMs) {
      return;
    }

    const payload = buildPromptSignal(eligible, policy.maxSignalsPerTurn);
    this.injectedAt.set(sessionID, now);

    try {
      await this.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: payload }],
        },
      } as any);
    } catch {
      // prompt injection is best-effort only
    }
  }

  async queueChangedFiles(
    sessionID: string,
    files: string[],
    reason: FilesChangedNotification["reason"],
  ): Promise<void> {
    const filtered = files.map((file) => normalizeProjectRelative(this.projectRoot, file)).filter(isEligibleCodePath);
    if (filtered.length === 0) {
      return;
    }

    const bucket = this.pendingFiles.get(sessionID) ?? new Set<string>();
    for (const file of filtered) {
      bucket.add(file);
    }
    this.pendingFiles.set(sessionID, bucket);
    this.pendingReason.set(sessionID, reason);
    const previous = this.pendingTimer.get(sessionID);
    if (previous) {
      clearTimeout(previous as any);
    }
    const timer = setTimeout(() => {
      void this.flushChangedFiles(sessionID);
    }, 175);
    this.pendingTimer.set(sessionID, timer);
  }

  async currentWarning(): Promise<string | null> {
    const supervisor = await this.getSupervisor();
    return supervisor.warning;
  }

  private async flushChangedFiles(sessionID: string): Promise<void> {
    this.pendingTimer.delete(sessionID);
    const files = [...(this.pendingFiles.get(sessionID) ?? [])];
    this.pendingFiles.delete(sessionID);
    const reason = this.pendingReason.get(sessionID) ?? "tool";
    this.pendingReason.delete(sessionID);
    if (files.length === 0) {
      return;
    }

    try {
      const client = await this.ensureReady({ waitForReady: false });
      const turn = (this.turnCounter.get(sessionID) ?? 0) + 1;
      this.turnCounter.set(sessionID, turn);
      await client.filesChanged({
        projectRoot: this.projectRoot,
        sessionID,
        files,
        reason,
        turnID: `turn-${turn}`,
        observedAtUnixMs: Date.now(),
      });
    } catch {
      // Hot path must stay non-blocking; direct tools fail closed instead.
    }
  }

  private async getSupervisor(): Promise<DaemonSupervisor> {
    if (!this.supervisorPromise) {
      this.supervisorPromise = (async () => {
        const loaded = await this.getConfig();
        const stateDirectory = await resolveStateDirectory(loaded.config, this.projectRoot);
        return new DaemonSupervisor({
          projectRoot: this.projectRoot,
          stateDirectory,
          config: loaded.config,
        });
      })();
    }
    return this.supervisorPromise;
  }
}

const plugin: Plugin = async (input) => {
  const runtime = new PluginRuntime(input.worktree || input.directory, input.client);

  return {
    tool: createCodeMemTools(runtime),

    event: async ({ event }) => {
      const eventType = String(event?.type ?? "");
      if (eventType === "file.edited") {
        const file = event?.properties?.file;
        if (typeof file === "string") {
          const sessionID = typeof event?.properties?.sessionID === "string" ? event.properties.sessionID : "event";
          await runtime.queueChangedFiles(sessionID, [file], "event");
        }
        return;
      }

      if (eventType === "file.watcher.updated") {
        const file = event?.properties?.file;
        const changeKind = event?.properties?.event;
        if (typeof file === "string" && (changeKind === "add" || changeKind === "change")) {
          await runtime.queueChangedFiles("watcher", [file], "event");
        }
      }
    },

    "tool.execute.after": async (hook, output) => {
      const changedFiles = extractChangedFiles(hook.tool, hook.args, runtime.projectRoot);
      if (changedFiles.length > 0) {
        await runtime.queueChangedFiles(hook.sessionID, changedFiles, "tool");
      }

      const warning = await runtime.currentWarning();
      if (warning && changedFiles.length > 0) {
        output.metadata = {
          ...(output.metadata ?? {}),
          codememWarning: warning,
        };
      }
    },
  };
};

export default plugin;

function extractChangedFiles(toolName: string, args: unknown, projectRoot: string): string[] {
  if (!WRITE_LIKE_TOOL.test(toolName)) {
    const extracted = collectPathCandidates(args, projectRoot);
    return extracted.filter(isEligibleCodePath);
  }
  return collectPathCandidates(args, projectRoot).filter(isEligibleCodePath);
}

function collectPathCandidates(value: unknown, projectRoot: string, depth = 0, keyHint = ""): string[] {
  if (depth > 4) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const keyLooksPath = /(path|file|target|source|destination|old|new)/i.test(keyHint);
    if (keyLooksPath && looksLikePath(trimmed)) {
      return [normalizeProjectRelative(projectRoot, trimmed)];
    }

    if (!keyLooksPath || trimmed.length > 1_024) {
      return [];
    }

    const embedded = trimmed
      .split(/\s+/)
      .filter(looksLikePath)
      .map((entry) => normalizeProjectRelative(projectRoot, entry));
    return embedded;
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPathCandidates(item, projectRoot, depth + 1, keyHint));
  }

  if (value && typeof value === "object") {
    const result: string[] = [];
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result.push(...collectPathCandidates(nested, projectRoot, depth + 1, key));
    }
    return result;
  }

  return [];
}

function looksLikePath(value: string): boolean {
  if (value.includes("\n")) {
    return false;
  }
  return /[./\\]/.test(value) || CODE_FILE.test(value);
}

function normalizeProjectRelative(projectRoot: string, candidate: string): string {
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
  return path.relative(projectRoot, absolute).replace(/\\/g, "/");
}

function isEligibleCodePath(candidate: string): boolean {
  return Boolean(candidate) && !candidate.startsWith("..") && CODE_FILE.test(candidate);
}

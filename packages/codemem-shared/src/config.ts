import fs from "node:fs/promises";
import path from "node:path";
import type { Severity } from "./protocol";

export type CodeMemLayerToggles = {
  astClones: boolean;
  simhashClones: boolean;
  typeShapes: boolean;
  symbolGraph: boolean;
  apiDrift: boolean;
  sessionConflicts: boolean;
  dynamicDeadCode: boolean;
};

export type CodeMemThresholds = {
  minCloneTokens: number;
  minCloneStatements: number;
  simhashHammingRadius: number;
  maxFindings: number;
  typeShapeMinMembers: number;
  sessionConflictOverlap: number;
  sessionConflictDecayMs: number;
  promptInjectionMinConfidence: number;
};

export type TelemetryConfig = {
  enabled: boolean;
  retainDays: number;
  maxLogBytes: number;
  structuredLocalOnly: boolean;
};

export type PromptInjectionPolicy = {
  enabled: boolean;
  mode: "off" | "tool-only" | "turn";
  minSeverity: Severity;
  maxSignalsPerTurn: number;
  cooldownMs: number;
};

export type DaemonConfig = {
  stateDirectory?: string;
  maxPayloadBytes: number;
  healthTimeoutMs: number;
  requestTimeoutMs: number;
  spawnTimeoutMs: number;
  binaryPath?: string;
  command?: string[];
};

export type PackageBoundary = {
  root: string;
  name?: string;
  kind?: "workspace" | "package" | "layer";
};

export type CodeMemConfig = {
  entrypoints: string[];
  ignore: string[];
  packageBoundaries: PackageBoundary[];
  layers: CodeMemLayerToggles;
  thresholds: CodeMemThresholds;
  daemon: DaemonConfig;
  telemetry: TelemetryConfig;
  promptInjection: PromptInjectionPolicy;
  maxFindings: number;
};

export type LoadedCodeMemConfig = {
  path: string | null;
  config: CodeMemConfig;
};

const DEFAULT_CONFIG: CodeMemConfig = {
  entrypoints: ["src/index.ts"],
  ignore: [
    "node_modules/**",
    "**/node_modules/**",
    ".opencode/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    ".next/**",
    "coverage/**",
    "**/*.generated.ts",
    "**/*.generated.tsx",
    "**/*.gen.ts",
    "**/*.gen.tsx",
  ],
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
    sessionConflictDecayMs: 15 * 60 * 1000,
    promptInjectionMinConfidence: 0.8,
  },
  daemon: {
    maxPayloadBytes: 4 * 1024 * 1024,
    healthTimeoutMs: 250,
    requestTimeoutMs: 3_000,
    spawnTimeoutMs: 2_500,
  },
  telemetry: {
    enabled: true,
    retainDays: 14,
    maxLogBytes: 8 * 1024 * 1024,
    structuredLocalOnly: true,
  },
  promptInjection: {
    enabled: true,
    mode: "turn",
    minSeverity: "warn",
    maxSignalsPerTurn: 4,
    cooldownMs: 2_000,
  },
  maxFindings: 50,
};

export async function loadCodeMemConfig(
  projectRoot: string,
  explicitPath?: string,
): Promise<LoadedCodeMemConfig> {
  const configPath = explicitPath ?? (await resolveConfigPath(projectRoot));
  if (!configPath) {
    return { path: null, config: structuredClone(DEFAULT_CONFIG) };
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = parseJsonc(raw);
  const merged = mergeConfig(DEFAULT_CONFIG, parsed as Partial<CodeMemConfig>);
  // Project-local config is intentionally not trusted to choose an arbitrary
  // daemon executable. Development overrides should use CODEMEM_DAEMON_BIN or
  // a directly constructed supervisor config in tests.
  merged.daemon.command = undefined;
  return {
    path: configPath,
    config: normalizeConfig(merged),
  };
}

export async function resolveConfigPath(projectRoot: string): Promise<string | null> {
  const candidates = [
    path.join(projectRoot, "codemem.config.jsonc"),
    path.join(projectRoot, "codemem.config.json"),
    path.join(projectRoot, ".codememrc.jsonc"),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function resolveStateDirectory(config: CodeMemConfig, projectRoot: string): Promise<string> {
  if (config.daemon.stateDirectory) {
    return path.resolve(projectRoot, config.daemon.stateDirectory);
  }

  const gitDir = path.join(projectRoot, ".git");
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isDirectory()) {
      return path.join(gitDir, "codemem");
    }
  } catch {
    // ignore
  }

  return path.join(projectRoot, ".codemem");
}

export function normalizeProjectPath(projectRoot: string, candidate: string): string {
  if (path.isAbsolute(candidate)) {
    return path.normalize(candidate);
  }
  return path.normalize(path.join(projectRoot, candidate));
}

export function normalizeConfig(config: CodeMemConfig): CodeMemConfig {
  const normalized: CodeMemConfig = structuredClone(config);
  normalized.entrypoints = dedupe(normalized.entrypoints.map((entry) => toPortablePath(entry)));
  normalized.ignore = dedupe(normalized.ignore.map((glob) => glob.trim()).filter(Boolean));
  normalized.packageBoundaries = normalized.packageBoundaries.map((boundary) => ({
    root: toPortablePath(boundary.root),
    name: boundary.name?.trim() || undefined,
    kind: boundary.kind ?? "package",
  }));

  if (normalized.maxFindings <= 0) {
    normalized.maxFindings = DEFAULT_CONFIG.maxFindings;
  }
  normalized.thresholds.maxFindings = Math.max(1, normalized.thresholds.maxFindings);

  return normalized;
}

export function parseJsonc(input: string): unknown {
  const stripped = stripJsonComments(input);
  const withoutTrailingCommas = stripTrailingCommas(stripped);
  return JSON.parse(withoutTrailingCommas);
}

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let stringQuote = '"';
  let escaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === stringQuote) {
        inString = false;
      }
      continue;
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

export function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, "$1");
}

function mergeConfig(base: CodeMemConfig, next: Partial<CodeMemConfig>): CodeMemConfig {
  const merged: CodeMemConfig = structuredClone(base);

  if (Array.isArray(next.entrypoints)) merged.entrypoints = [...next.entrypoints];
  if (Array.isArray(next.ignore)) merged.ignore = [...next.ignore];
  if (Array.isArray(next.packageBoundaries)) merged.packageBoundaries = [...next.packageBoundaries];
  if (typeof next.maxFindings === "number") merged.maxFindings = next.maxFindings;

  if (next.layers) merged.layers = { ...merged.layers, ...next.layers };
  if (next.thresholds) merged.thresholds = { ...merged.thresholds, ...next.thresholds };
  if (next.daemon) merged.daemon = { ...merged.daemon, ...next.daemon };
  if (next.telemetry) merged.telemetry = { ...merged.telemetry, ...next.telemetry };
  if (next.promptInjection) {
    merged.promptInjection = { ...merged.promptInjection, ...next.promptInjection };
  }

  return merged;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function defaultCodeMemConfig(): CodeMemConfig {
  return structuredClone(DEFAULT_CONFIG);
}

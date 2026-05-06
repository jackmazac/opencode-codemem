#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { makeHealthReport, type HealthCheck, type HealthReport } from "@jackmazac/opencode-fleet-contracts";
import {
  createCodememAuditArtifact,
  createCodememJournalEntry,
  type CodememJournalEntry,
} from "@codemem/shared/artifacts";
import {
  createFindingBaseline,
  diffFindingBaseline,
  parseFindingBaselineJson,
  type FindingBaseline,
  type FindingBaselineDiff,
} from "@codemem/shared/baseline";
import { loadCodeMemConfig, resolveStateDirectory } from "@codemem/shared/config";
import { createMarkdownReport, createSarifReport, explainFinding } from "@codemem/shared/report";
import type {
  CheckResponse,
  ChangeRiskResponse,
  ConflictsResponse,
  DriftMapResponse,
  ImpactConeResponse,
  ApiSurfaceResponse,
  LayerBoundariesResponse,
  LockfileResponse,
  MaintainResponse,
  RebuildResponse,
  StatusResponse,
} from "@codemem/shared/protocol";
import { DaemonSupervisor, type DaemonStopResult, type StaleEndpointCleanup } from "./daemon/supervisor";

type BaseCliCommand = {
  json: boolean;
  projectRoot: string;
};

export type StatusCliCommand = BaseCliCommand & {
  kind: "status";
};

export type DoctorCliCommand = BaseCliCommand & {
  kind: "doctor";
};

export type StopCliCommand = BaseCliCommand & {
  kind: "stop";
};

export type CleanupCliCommand = BaseCliCommand & {
  kind: "cleanup";
  stale: boolean;
};

export type CheckCliCommand = BaseCliCommand & {
  kind: "check";
  includeEvidence: boolean;
  maxFindings: number;
  paths: string[];
  waitForFreshIndex: boolean;
};

export type DriftMapCliCommand = BaseCliCommand & {
  kind: "drift-map";
  maxFindings: number;
};

export type ConflictsCliCommand = BaseCliCommand & {
  kind: "conflicts";
  sessionID?: string;
};

export type MaintainCliCommand = BaseCliCommand & {
  kind: "maintain";
  compact: boolean;
  dryRun: boolean;
  pruneLogs: boolean;
};

export type RebuildCliCommand = BaseCliCommand & {
  kind: "rebuild";
  dryRun: boolean;
};

export type BaselineDiffCliCommand = BaseCliCommand & {
  kind: "baseline-diff";
  baselinePath?: string;
  maxFindings: number;
};

export type BaselineWriteCliCommand = BaseCliCommand & {
  kind: "baseline-write";
  baselinePath?: string;
  dryRun: boolean;
  maxFindings: number;
};

export type ImpactConeCliCommand = BaseCliCommand & {
  kind: "impact-cone";
  depth: number;
  path: string;
};

export type ChangeRiskCliCommand = BaseCliCommand & {
  kind: "change-risk";
  depth: number;
  maxFindings: number;
  paths: string[];
};

export type ReviewFocusCliCommand = BaseCliCommand & {
  kind: "review-focus";
  depth: number;
  maxFindings: number;
  maxItems: number;
  paths: string[];
};

export type ChangeDeltaCliCommand = BaseCliCommand & {
  kind: "change-delta";
  baselinePath?: string;
  maxFindings: number;
};

export type ApiSurfaceCliCommand = BaseCliCommand & {
  kind: "api-surface";
  maxExports: number;
};

export type LayerBoundariesCliCommand = BaseCliCommand & {
  kind: "layer-boundaries";
  maxFindings: number;
};

export type LockfileCliCommand = BaseCliCommand & {
  kind: "lockfile";
};

export type ExplainCliCommand = BaseCliCommand & {
  kind: "explain";
  findingId: string;
  maxFindings: number;
};

export type ReportCliCommand = BaseCliCommand & {
  kind: "report";
  format: "json" | "markdown" | "sarif";
  maxFindings: number;
};

export type ArtifactEmitCliCommand = BaseCliCommand & {
  kind: "artifact";
  artifactKind: "audit" | "journal";
  dryRun: boolean;
  maxFindings: number;
  slug: string;
};

export type CliCommand =
  | StatusCliCommand
  | DoctorCliCommand
  | StopCliCommand
  | CleanupCliCommand
  | CheckCliCommand
  | DriftMapCliCommand
  | ConflictsCliCommand
  | MaintainCliCommand
  | RebuildCliCommand
  | BaselineDiffCliCommand
  | BaselineWriteCliCommand
  | ImpactConeCliCommand
  | ChangeRiskCliCommand
  | ReviewFocusCliCommand
  | ChangeDeltaCliCommand
  | ApiSurfaceCliCommand
  | LayerBoundariesCliCommand
  | LockfileCliCommand
  | ExplainCliCommand
  | ReportCliCommand
  | ArtifactEmitCliCommand;

export type BaselineDiffResponse = FindingBaselineDiff & {
  baselinePath: string;
};

export type BaselineWriteResponse = {
  baselinePath: string;
  applied: boolean;
  baseline: FindingBaseline;
};

export type ArtifactEmitResponse = {
  artifactKind: "audit" | "journal";
  applied: boolean;
  path: string;
  findings: number;
  entry?: CodememJournalEntry;
};

export type CleanupResponse = {
  stale: boolean;
  cleanup: StaleEndpointCleanup;
};

export type CliParseResult =
  | { ok: true; command: CliCommand }
  | { ok: false; exitCode: number; message: string };

type CliErrorResult = { ok: false; exitCode: number; message: string };

export type CliRuntime = {
  status(projectRoot: string): Promise<StatusResponse>;
  check(command: CheckCliCommand): Promise<CheckResponse>;
  driftMap(command: DriftMapCliCommand): Promise<DriftMapResponse>;
  conflicts(command: ConflictsCliCommand): Promise<ConflictsResponse>;
  maintain(command: MaintainCliCommand): Promise<MaintainResponse>;
  rebuild(command: RebuildCliCommand): Promise<RebuildResponse>;
  baselineDiff(command: BaselineDiffCliCommand): Promise<BaselineDiffResponse>;
  baselineWrite(command: BaselineWriteCliCommand): Promise<BaselineWriteResponse>;
  impactCone(command: ImpactConeCliCommand): Promise<ImpactConeResponse>;
  changeRisk(command: ChangeRiskCliCommand): Promise<ChangeRiskResponse>;
  reviewFocus(command: ReviewFocusCliCommand): Promise<ChangeRiskResponse>;
  changeDelta(command: ChangeDeltaCliCommand): Promise<BaselineDiffResponse>;
  apiSurface(command: ApiSurfaceCliCommand): Promise<ApiSurfaceResponse>;
  layerBoundaries(command: LayerBoundariesCliCommand): Promise<LayerBoundariesResponse>;
  lockfile(command: LockfileCliCommand): Promise<LockfileResponse>;
  stop?(command: StopCliCommand): Promise<DaemonStopResult>;
  cleanup?(command: CleanupCliCommand): Promise<CleanupResponse>;
};

export type CliRunOptions = {
  cwd?: string;
  runtime?: CliRuntime;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

const DEFAULT_MAX_FINDINGS = 50;

export function parseCliArgs(argv: string[], cwd: string): CliParseResult {
  const [commandName, ...rest] = argv;
  if (!commandName || commandName === "--help" || commandName === "-h") {
    return { ok: false, exitCode: 0, message: rootHelp() };
  }

  if (commandName === "baseline") {
    return parseBaselineCommand(rest, cwd);
  }

  const parsedOptions = parseOptions(rest, cwd);
  if (!parsedOptions.ok) {
    return parsedOptions;
  }
  const options = parsedOptions.options;

  switch (commandName) {
    case "status":
      return {
        ok: true,
        command: {
          kind: "status",
          json: options.json,
          projectRoot: options.projectRoot,
        },
      };
    case "doctor":
      return {
        ok: true,
        command: {
          kind: "doctor",
          json: options.json,
          projectRoot: options.projectRoot,
        },
      };
    case "stop":
      return {
        ok: true,
        command: {
          kind: "stop",
          json: options.json,
          projectRoot: options.projectRoot,
        },
      };
    case "cleanup":
      return {
        ok: true,
        command: {
          kind: "cleanup",
          json: options.json,
          projectRoot: options.projectRoot,
          stale: options.stale,
        },
      };
    case "check":
      return {
        ok: true,
        command: {
          kind: "check",
          includeEvidence: options.includeEvidence,
          json: options.json,
          maxFindings: options.maxFindings,
          paths: options.paths,
          projectRoot: options.projectRoot,
          waitForFreshIndex: options.waitForFreshIndex,
        },
      };
    case "drift-map":
      return {
        ok: true,
        command: {
          kind: "drift-map",
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    case "conflicts":
      return {
        ok: true,
        command: {
          kind: "conflicts",
          json: options.json,
          projectRoot: options.projectRoot,
          sessionID: options.sessionID,
        },
      };
    case "maintain":
      return {
        ok: true,
        command: {
          kind: "maintain",
          compact: options.compact,
          dryRun: !options.apply,
          json: options.json,
          projectRoot: options.projectRoot,
          pruneLogs: options.pruneLogs,
        },
      };
    case "rebuild":
      return {
        ok: true,
        command: {
          kind: "rebuild",
          dryRun: !options.apply,
          json: options.json,
          projectRoot: options.projectRoot,
        },
      };
    case "impact-cone": {
      const path = firstPath(options);
      if (!path.ok) return path;
      return {
        ok: true,
        command: {
          kind: "impact-cone",
          depth: options.depth,
          json: options.json,
          path: path.value,
          projectRoot: options.projectRoot,
        },
      };
    }
    case "change-risk": {
      const paths = requiredPaths(options, "change-risk");
      if (!paths.ok) return paths;
      return {
        ok: true,
        command: {
          kind: "change-risk",
          depth: options.depth,
          json: options.json,
          maxFindings: options.maxFindings,
          paths: paths.value,
          projectRoot: options.projectRoot,
        },
      };
    }
    case "review-focus": {
      const paths = requiredPaths(options, "review-focus");
      if (!paths.ok) return paths;
      return {
        ok: true,
        command: {
          kind: "review-focus",
          depth: options.depth,
          json: options.json,
          maxFindings: options.maxFindings,
          maxItems: options.maxItems,
          paths: paths.value,
          projectRoot: options.projectRoot,
        },
      };
    }
    case "change-delta":
      return {
        ok: true,
        command: {
          kind: "change-delta",
          baselinePath: options.baselinePath,
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    case "api-surface":
      return {
        ok: true,
        command: {
          kind: "api-surface",
          json: options.json,
          maxExports: options.maxExports,
          projectRoot: options.projectRoot,
        },
      };
    case "layer-boundaries":
      return {
        ok: true,
        command: {
          kind: "layer-boundaries",
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    case "lockfile":
      return {
        ok: true,
        command: {
          kind: "lockfile",
          json: options.json,
          projectRoot: options.projectRoot,
        },
      };
    case "explain": {
      if (!options.findingId) {
        return {
          ok: false,
          exitCode: 2,
          message: "Missing --id for explain\n\nExample: codemem explain --id dead:src/a.ts:unused",
        };
      }
      return {
        ok: true,
        command: {
          kind: "explain",
          findingId: options.findingId,
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    }
    case "report":
      return {
        ok: true,
        command: {
          kind: "report",
          format: options.format,
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    case "artifact":
      return {
        ok: true,
        command: {
          kind: "artifact",
          artifactKind: options.artifactKind,
          dryRun: !options.apply,
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
          slug: options.slug,
        },
      };
    default:
      return {
        ok: false,
        exitCode: 2,
        message: `Unknown codemem command: ${commandName}\n\n${rootHelp()}`,
      };
  }
}

export async function runCodeMemCli(
  argv: string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseCliArgs(argv, cwd);

  if (!parsed.ok) {
    const write = parsed.exitCode === 0 ? stdout : stderr;
    write(parsed.message);
    return parsed.exitCode;
  }

  try {
    if (!options.runtime && parsed.command.kind === "stop") {
      stdout(formatStop(await runStopCommand(parsed.command)));
      return 0;
    }
    if (!options.runtime && parsed.command.kind === "cleanup") {
      stdout(formatCleanup(await runCleanupCommand(parsed.command)));
      return 0;
    }
    const runtime = options.runtime ?? (await createDaemonRuntime(parsed.command.projectRoot));
    stdout(await executeAndFormat(parsed.command, runtime));
    return 0;
  } catch (error) {
    stderr(formatError(error));
    return 1;
  }
}

async function createDaemonRuntime(projectRoot: string): Promise<CliRuntime> {
  const loaded = await loadCodeMemConfig(projectRoot);
  const stateDirectory = await resolveStateDirectory(loaded.config, projectRoot);
  const supervisor = new DaemonSupervisor({
    projectRoot,
    stateDirectory,
    config: loaded.config,
  });
  const status = await supervisor.ensureDaemon(true);
  if (!status.started) {
    throw new Error(status.warning ?? "codemem-daemon did not start");
  }
  const client = supervisor.createClient();

  return {
    status: (requestProjectRoot) => client.status({ projectRoot: requestProjectRoot }),
    check: (command) =>
      client.check({
        projectRoot: command.projectRoot,
        paths: command.paths.length > 0 ? command.paths : undefined,
        maxFindings: command.maxFindings,
        includeEvidence: command.includeEvidence,
        waitForFreshIndex: command.waitForFreshIndex,
      }),
    driftMap: (command) =>
      client.driftMap({
        projectRoot: command.projectRoot,
        maxFindings: command.maxFindings,
      }),
    conflicts: (command) =>
      client.conflicts({
        projectRoot: command.projectRoot,
        sessionID: command.sessionID,
      }),
    maintain: (command) =>
      client.maintain({
        projectRoot: command.projectRoot,
        dryRun: command.dryRun,
        pruneLogs: command.pruneLogs,
        compact: command.compact,
      }),
    rebuild: (command) =>
      client.rebuild({
        projectRoot: command.projectRoot,
        dryRun: command.dryRun,
      }),
    baselineDiff: async (command) => {
      const baselinePath = resolveBaselinePath(
        stateDirectory,
        command.projectRoot,
        command.baselinePath,
      );
      const baseline = parseFindingBaselineJson(await fs.readFile(baselinePath, "utf8"));
      const current = await client.check({
        projectRoot: command.projectRoot,
        maxFindings: command.maxFindings,
        includeEvidence: false,
        waitForFreshIndex: true,
      });
      return {
        baselinePath,
        ...diffFindingBaseline(baseline, current.findings),
      };
    },
    baselineWrite: async (command) => {
      const baselinePath = resolveBaselinePath(
        stateDirectory,
        command.projectRoot,
        command.baselinePath,
      );
      const current = await client.check({
        projectRoot: command.projectRoot,
        maxFindings: command.maxFindings,
        includeEvidence: false,
        waitForFreshIndex: true,
      });
      const baseline = createFindingBaseline(current.findings, Date.now());
      if (!command.dryRun) {
        await fs.mkdir(path.dirname(baselinePath), { recursive: true });
        await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      }
      return {
        baselinePath,
        applied: !command.dryRun,
        baseline,
      };
    },
    impactCone: (command) =>
      client.impactCone({
        projectRoot: command.projectRoot,
        path: command.path,
        depth: command.depth,
      }),
    changeRisk: (command) =>
      client.changeRisk({
        projectRoot: command.projectRoot,
        paths: command.paths,
        depth: command.depth,
        maxFindings: command.maxFindings,
      }),
    reviewFocus: (command) =>
      client.changeRisk({
        projectRoot: command.projectRoot,
        paths: command.paths,
        depth: command.depth,
        maxFindings: command.maxFindings,
      }),
    changeDelta: async (command) => {
      const baselinePath = resolveBaselinePath(
        stateDirectory,
        command.projectRoot,
        command.baselinePath,
      );
      const baseline = parseFindingBaselineJson(await fs.readFile(baselinePath, "utf8"));
      const current = await client.check({
        projectRoot: command.projectRoot,
        maxFindings: command.maxFindings,
        includeEvidence: false,
        waitForFreshIndex: true,
      });
      return {
        baselinePath,
        ...diffFindingBaseline(baseline, current.findings),
      };
    },
    apiSurface: (command) =>
      client.apiSurface({
        projectRoot: command.projectRoot,
        maxExports: command.maxExports,
      }),
    layerBoundaries: (command) =>
      client.layerBoundaries({
        projectRoot: command.projectRoot,
        maxFindings: command.maxFindings,
      }),
    lockfile: (command) =>
      client.lockfile({
        projectRoot: command.projectRoot,
      }),
  };
}

async function createSupervisor(projectRoot: string): Promise<DaemonSupervisor> {
  const loaded = await loadCodeMemConfig(projectRoot);
  const stateDirectory = await resolveStateDirectory(loaded.config, projectRoot);
  return new DaemonSupervisor({
    projectRoot,
    stateDirectory,
    config: loaded.config,
  });
}

async function runStopCommand(command: StopCliCommand): Promise<DaemonStopResult> {
  return (await createSupervisor(command.projectRoot)).stop();
}

async function runCleanupCommand(command: CleanupCliCommand): Promise<CleanupResponse> {
  if (!command.stale) {
    throw new Error("cleanup requires --stale to avoid removing live daemon state");
  }
  return {
    stale: command.stale,
    cleanup: await (await createSupervisor(command.projectRoot)).cleanupStale(),
  };
}

async function executeAndFormat(command: CliCommand, runtime: CliRuntime): Promise<string> {
  switch (command.kind) {
    case "status": {
      const result = await runtime.status(command.projectRoot);
      return command.json ? JSON.stringify(result, null, 2) : formatStatus(result);
    }
    case "doctor": {
      const result = await runtime.status(command.projectRoot);
      const report = createDoctorHealthReport(result);
      return command.json ? JSON.stringify(report, null, 2) : formatDoctor(report);
    }
    case "stop": {
      const result = runtime.stop ? await runtime.stop(command) : await runStopCommand(command);
      return command.json ? JSON.stringify(result, null, 2) : formatStop(result);
    }
    case "cleanup": {
      const result = runtime.cleanup ? await runtime.cleanup(command) : await runCleanupCommand(command);
      return command.json ? JSON.stringify(result, null, 2) : formatCleanup(result);
    }
    case "check": {
      const result = await runtime.check(command);
      return command.json ? JSON.stringify(result, null, 2) : formatCheck(result);
    }
    case "drift-map": {
      const result = await runtime.driftMap(command);
      return command.json ? JSON.stringify(result, null, 2) : formatDriftMap(result);
    }
    case "conflicts": {
      const result = await runtime.conflicts(command);
      return command.json ? JSON.stringify(result, null, 2) : formatConflicts(result);
    }
    case "maintain": {
      const result = await runtime.maintain(command);
      return command.json ? JSON.stringify(result, null, 2) : formatMaintain(result);
    }
    case "rebuild": {
      const result = await runtime.rebuild(command);
      return command.json ? JSON.stringify(result, null, 2) : formatRebuild(result);
    }
    case "baseline-diff": {
      const result = await runtime.baselineDiff(command);
      return command.json ? JSON.stringify(result, null, 2) : formatBaselineDiff(result);
    }
    case "baseline-write": {
      const result = await runtime.baselineWrite(command);
      return command.json ? JSON.stringify(result, null, 2) : formatBaselineWrite(result);
    }
    case "impact-cone": {
      const result = await runtime.impactCone(command);
      return command.json ? JSON.stringify(result, null, 2) : formatImpactCone(result);
    }
    case "change-risk": {
      const result = await runtime.changeRisk(command);
      return command.json ? JSON.stringify(result, null, 2) : formatChangeRisk(result);
    }
    case "review-focus": {
      const result = await runtime.reviewFocus(command);
      const focused = { ...result, focus: result.focus.slice(0, command.maxItems) };
      return command.json ? JSON.stringify(focused, null, 2) : formatReviewFocus(focused);
    }
    case "change-delta": {
      const result = await runtime.changeDelta(command);
      return command.json ? JSON.stringify(result, null, 2) : formatBaselineDiff(result);
    }
    case "api-surface": {
      const result = await runtime.apiSurface(command);
      return command.json ? JSON.stringify(result, null, 2) : formatApiSurface(result);
    }
    case "layer-boundaries": {
      const result = await runtime.layerBoundaries(command);
      return command.json ? JSON.stringify(result, null, 2) : formatLayerBoundaries(result);
    }
    case "lockfile": {
      const result = await runtime.lockfile(command);
      return command.json ? JSON.stringify(result, null, 2) : formatLockfile(result);
    }
    case "explain": {
      const check = await runtime.check(checkCommandFor(command));
      const finding = check.findings.find((item) => item.id === command.findingId);
      if (!finding) {
        throw new Error(`finding not found in latest check: ${command.findingId}`);
      }
      return command.json
        ? JSON.stringify({ explanation: explainFinding(finding), finding }, null, 2)
        : explainFinding(finding);
    }
    case "report": {
      const check = await runtime.check(checkCommandFor(command));
      switch (command.format) {
        case "json":
          return JSON.stringify(check, null, 2);
        case "markdown":
          return createMarkdownReport(check.findings);
        case "sarif":
          return JSON.stringify(createSarifReport(check.findings), null, 2);
        default: {
          const exhaustive: never = command.format;
          return exhaustive;
        }
      }
    }
    case "artifact": {
      const check = await runtime.check(checkCommandFor(command));
      const result = await emitArtifact(command, check.findings);
      return command.json ? JSON.stringify(result, null, 2) : formatArtifactEmit(result);
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

async function emitArtifact(
  command: ArtifactEmitCliCommand,
  findings: CheckResponse["findings"],
): Promise<ArtifactEmitResponse> {
  if (command.artifactKind === "journal") {
    const entry = createCodememJournalEntry(findings);
    const dest = path.join(command.projectRoot, ".opencode", "journal.jsonl");
    if (!command.dryRun) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.appendFile(dest, `${JSON.stringify(entry)}\n`);
    }
    return {
      artifactKind: command.artifactKind,
      applied: !command.dryRun,
      entry,
      findings: findings.length,
      path: path.relative(command.projectRoot, dest),
    };
  }

  validateArtifactSlug(command.slug);
  const dest = path.join(command.projectRoot, ".opencode", "audits", `${command.slug}.md`);
  if (!command.dryRun) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, createCodememAuditArtifact(findings));
  }
  return {
    artifactKind: command.artifactKind,
    applied: !command.dryRun,
    findings: findings.length,
    path: path.relative(command.projectRoot, dest),
  };
}

function formatArtifactEmit(result: ArtifactEmitResponse): string {
  return [
    `artifact: ${result.artifactKind}`,
    `applied: ${result.applied}`,
    `findings: ${result.findings}`,
    `file: ${result.path}`,
  ].join("\n");
}

function formatStatus(status: StatusResponse): string {
  return [
    `codemem daemon: ${status.health.healthy ? "ok" : "unhealthy"}`,
    `project: ${status.health.projectRoot}`,
    `state: ${status.stateDirectory}`,
    status.lifecycle ? `pid: ${status.lifecycle.pid ?? "unknown"}` : undefined,
    status.lifecycle ? `endpoint: ${status.lifecycle.endpoint}` : undefined,
    status.lifecycle ? `stdout_log: ${status.lifecycle.stdoutLogFile}` : undefined,
    status.lifecycle ? `stderr_log: ${status.lifecycle.stderrLogFile}` : undefined,
    status.lifecycle ? `lifecycle_log: ${status.lifecycle.lifecycleLogFile}` : undefined,
    `files_indexed: ${status.health.indexedFiles}`,
    `queue_depth: ${status.health.queueDepth}`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function formatDoctor(report: HealthReport): string {
  return [
    `status: ${report.status}`,
    ...report.checks.map((check) => {
      const detail = check.message ? ` - ${check.message}` : "";
      return `${check.status}: ${check.name}${detail}`;
    }),
  ].join("\n");
}

function formatStop(result: DaemonStopResult): string {
  return [
    `stopped: ${result.stopped}`,
    `pid: ${result.pid ?? "none"}`,
    `shutdown_requested: ${result.shutdownRequested}`,
    `signaled: ${result.signaled}`,
    `endpoint: ${result.endpoint}`,
    result.warning ? `warning: ${result.warning}` : undefined,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function formatCleanup(result: CleanupResponse): string {
  return [
    `stale: ${result.stale}`,
    `pid: ${result.cleanup.pid ?? "none"}`,
    `pid_alive: ${result.cleanup.pidAlive}`,
    `removed_endpoint: ${result.cleanup.removedEndpoint}`,
    `removed_pid_file: ${result.cleanup.removedPidFile}`,
  ].join("\n");
}

function createDoctorHealthReport(status: StatusResponse): HealthReport {
  const startedAt = new Date().toISOString();
  const checks: HealthCheck[] = [
    {
      name: "daemon",
      status: status.health.healthy ? "ok" : "fail",
      message: status.health.healthy ? "codemem daemon is healthy" : "codemem daemon reported unhealthy",
      detail: {
        daemonVersion: status.health.daemonVersion,
        projectRoot: status.health.projectRoot,
        stateDirectory: status.stateDirectory,
        lifecycle: status.lifecycle,
      },
    },
    {
      name: "protocol_version",
      status: status.protocolVersion === status.health.protocolVersion ? "ok" : "fail",
      message:
        status.protocolVersion === status.health.protocolVersion
          ? `protocol ${status.protocolVersion}`
          : `client protocol ${status.protocolVersion} differs from daemon protocol ${status.health.protocolVersion}`,
    },
    {
      name: "schema_version",
      status: status.health.schemaVersion === 1 ? "ok" : "fail",
      message: `schema ${status.health.schemaVersion}`,
    },
    {
      name: "queue_depth",
      status: status.health.queueDepth > 0 ? "warn" : "ok",
      message: `${status.health.queueDepth} pending index batches`,
    },
    {
      name: "index_state",
      status: status.health.indexedFiles > 0 ? "ok" : "warn",
      message: `${status.health.indexedFiles} files indexed`,
    },
    {
      name: "findings_cache",
      status: "ok",
      message: `${status.health.findingsCacheEntries} cached finding sets`,
    },
  ];
  return makeHealthReport({
    source: "codemem",
    checks,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });
}

function formatCheck(check: CheckResponse): string {
  return [
    `findings: ${check.findings.length}`,
    `truncated: ${check.truncated}`,
    `indexed_at_unix_ms: ${check.indexedAtUnixMs}`,
  ].join("\n");
}

function formatDriftMap(driftMap: DriftMapResponse): string {
  return [
    `nodes: ${driftMap.map.nodes.length}`,
    `edges: ${driftMap.map.edges.length}`,
    `findings: ${driftMap.map.findings.length}`,
    `indexed_at_unix_ms: ${driftMap.indexedAtUnixMs}`,
  ].join("\n");
}

function formatConflicts(conflicts: ConflictsResponse): string {
  return [
    `conflicts: ${conflicts.findings.length}`,
    `indexed_at_unix_ms: ${conflicts.indexedAtUnixMs}`,
  ].join("\n");
}

function formatMaintain(maintain: MaintainResponse): string {
  return [
    `applied: ${maintain.applied}`,
    `actions: ${maintain.actions.length}`,
    ...maintain.actions.map((action) => `${action.kind}: ${action.detail}`),
  ].join("\n");
}

function formatRebuild(rebuild: RebuildResponse): string {
  return [`would_rebuild: ${rebuild.wouldRebuild}`, `reason: ${rebuild.reason}`].join("\n");
}

function formatBaselineDiff(diff: BaselineDiffResponse): string {
  return [
    `baseline: ${diff.baselinePath}`,
    `added: ${diff.added.length}`,
    `removed: ${diff.removed.length}`,
    `unchanged: ${diff.unchanged.length}`,
  ].join("\n");
}

function formatBaselineWrite(write: BaselineWriteResponse): string {
  return [
    `baseline: ${write.baselinePath}`,
    `applied: ${write.applied}`,
    `findings: ${write.baseline.findings.length}`,
  ].join("\n");
}

function formatImpactCone(impactCone: ImpactConeResponse): string {
  return [
    `path: ${impactCone.path}`,
    `depth: ${impactCone.depth}`,
    `files: ${impactCone.files.length}`,
    ...impactCone.files,
  ].join("\n");
}

function formatChangeRisk(changeRisk: ChangeRiskResponse): string {
  return [
    `level: ${changeRisk.level}`,
    `score: ${changeRisk.score}`,
    `paths: ${changeRisk.paths.length}`,
    `impacted_files: ${changeRisk.impactedFiles.length}`,
    `reasons: ${changeRisk.reasons.length}`,
    ...changeRisk.reasons.map((reason) => `${reason.severity} ${reason.kind}: ${reason.detail}`),
  ].join("\n");
}

function formatReviewFocus(changeRisk: ChangeRiskResponse): string {
  return [
    `level: ${changeRisk.level}`,
    `score: ${changeRisk.score}`,
    `focus: ${changeRisk.focus.length}`,
    ...changeRisk.focus.map(
      (item) => `${item.severity} ${item.targetKind} ${item.target}: ${item.reasons.join(",")}`,
    ),
  ].join("\n");
}

function formatApiSurface(apiSurface: ApiSurfaceResponse): string {
  return [
    `exports: ${apiSurface.exports.length}`,
    `total: ${apiSurface.total}`,
    `truncated: ${apiSurface.truncated}`,
    ...apiSurface.exports.map((item) => `${item.sourceFile} ${item.exportName} ${item.signature}`),
  ].join("\n");
}

function formatLayerBoundaries(layerBoundaries: LayerBoundariesResponse): string {
  return [
    `boundaries: ${layerBoundaries.boundaries.length}`,
    `cycles: ${layerBoundaries.cycles.length}`,
  ].join("\n");
}

function formatLockfile(lockfile: LockfileResponse): string {
  return [
    `lockfiles: ${lockfile.lockfiles.length}`,
    ...lockfile.lockfiles.map((item) => `${item.path} ${item.digest} ${item.sizeBytes}`),
  ].join("\n");
}

type ParsedOptions = {
  apply: boolean;
  artifactKind: "audit" | "journal";
  baselinePath?: string;
  compact: boolean;
  depth: number;
  findingId?: string;
  format: "json" | "markdown" | "sarif";
  includeEvidence: boolean;
  json: boolean;
  maxExports: number;
  maxFindings: number;
  maxItems: number;
  paths: string[];
  projectRoot: string;
  pruneLogs: boolean;
  sessionID?: string;
  slug: string;
  stale: boolean;
  waitForFreshIndex: boolean;
};

type OptionsParseResult = { ok: true; options: ParsedOptions } | CliErrorResult;

function parseOptions(argv: string[], cwd: string): OptionsParseResult {
  const options: ParsedOptions = {
    apply: false,
    artifactKind: "audit",
    compact: false,
    depth: 2,
    format: "json",
    includeEvidence: false,
    json: false,
    maxExports: 100,
    maxFindings: DEFAULT_MAX_FINDINGS,
    maxItems: 10,
    paths: [],
    projectRoot: path.resolve(cwd),
    pruneLogs: false,
    slug: "codemem-audit",
    stale: false,
    waitForFreshIndex: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--include-evidence":
        options.includeEvidence = true;
        break;
      case "--no-wait":
        options.waitForFreshIndex = false;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--prune-logs":
        options.pruneLogs = true;
        break;
      case "--compact":
        options.compact = true;
        break;
      case "--stale":
        options.stale = true;
        break;
      case "--baseline": {
        const value = readOptionValue(
          argv,
          index,
          "--baseline",
          "codemem baseline diff --baseline .codemem/findings-baseline.json",
        );
        if (!value.ok) return value;
        options.baselinePath = value.value;
        index += 1;
        break;
      }
      case "--id": {
        const value = readOptionValue(
          argv,
          index,
          "--id",
          "codemem explain --id dead:src/a.ts:unused",
        );
        if (!value.ok) return value;
        options.findingId = value.value;
        index += 1;
        break;
      }
      case "--format": {
        const value = readOptionValue(argv, index, "--format", "codemem report --format sarif");
        if (!value.ok) return value;
        const format = parseReportFormat(value.value);
        if (!format.ok) return format;
        options.format = format.value;
        index += 1;
        break;
      }
      case "--kind": {
        const value = readOptionValue(
          argv,
          index,
          "--kind",
          "codemem artifact --kind audit --apply",
        );
        if (!value.ok) return value;
        const artifactKind = parseArtifactKind(value.value);
        if (!artifactKind.ok) return artifactKind;
        options.artifactKind = artifactKind.value;
        index += 1;
        break;
      }
      case "--slug": {
        const value = readOptionValue(
          argv,
          index,
          "--slug",
          "codemem artifact --kind audit --slug codemem-audit --apply",
        );
        if (!value.ok) return value;
        options.slug = value.value;
        index += 1;
        break;
      }
      case "--project-root": {
        const value = readOptionValue(
          argv,
          index,
          "--project-root",
          "codemem status --project-root <path>",
        );
        if (!value.ok) return value;
        options.projectRoot = path.resolve(cwd, value.value);
        index += 1;
        break;
      }
      case "--path": {
        const value = readOptionValue(argv, index, "--path", "codemem check --path src/index.ts");
        if (!value.ok) return value;
        options.paths.push(value.value);
        index += 1;
        break;
      }
      case "--max-findings": {
        const value = readOptionValue(
          argv,
          index,
          "--max-findings",
          "codemem check --max-findings 25",
        );
        if (!value.ok) return value;
        const parsed = parsePositiveInteger(
          value.value,
          "--max-findings",
          "codemem check --max-findings 25",
        );
        if (!parsed.ok) return parsed;
        options.maxFindings = parsed.value;
        index += 1;
        break;
      }
      case "--max-exports": {
        const value = readOptionValue(
          argv,
          index,
          "--max-exports",
          "codemem api-surface --max-exports 100",
        );
        if (!value.ok) return value;
        const parsed = parsePositiveInteger(
          value.value,
          "--max-exports",
          "codemem api-surface --max-exports 100",
        );
        if (!parsed.ok) return parsed;
        options.maxExports = parsed.value;
        index += 1;
        break;
      }
      case "--max-items": {
        const value = readOptionValue(
          argv,
          index,
          "--max-items",
          "codemem review-focus --max-items 10",
        );
        if (!value.ok) return value;
        const parsed = parsePositiveInteger(
          value.value,
          "--max-items",
          "codemem review-focus --max-items 10",
        );
        if (!parsed.ok) return parsed;
        options.maxItems = parsed.value;
        index += 1;
        break;
      }
      case "--depth": {
        const value = readOptionValue(
          argv,
          index,
          "--depth",
          "codemem impact-cone --path src/index.ts --depth 2",
        );
        if (!value.ok) return value;
        const parsed = parsePositiveInteger(
          value.value,
          "--depth",
          "codemem impact-cone --path src/index.ts --depth 2",
        );
        if (!parsed.ok) return parsed;
        options.depth = parsed.value;
        index += 1;
        break;
      }
      case "--session-id":
      case "--sessionID": {
        const value = readOptionValue(
          argv,
          index,
          arg,
          "codemem conflicts --session-id <session-id>",
        );
        if (!value.ok) return value;
        options.sessionID = value.value;
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        return { ok: false, exitCode: 0, message: rootHelp() };
      default:
        return {
          ok: false,
          exitCode: 2,
          message: `Unknown codemem option: ${arg}\n\n${rootHelp()}`,
        };
    }
  }

  return { ok: true, options };
}

function checkCommandFor(
  command: ExplainCliCommand | ReportCliCommand | ArtifactEmitCliCommand,
): CheckCliCommand {
  return {
    kind: "check",
    includeEvidence: true,
    json: false,
    maxFindings: command.maxFindings,
    paths: [],
    projectRoot: command.projectRoot,
    waitForFreshIndex: true,
  };
}

function parseArtifactKind(
  value: string,
): { ok: true; value: "audit" | "journal" } | CliErrorResult {
  if (value === "audit" || value === "journal") {
    return { ok: true, value };
  }
  return {
    ok: false,
    exitCode: 2,
    message: `Invalid --kind value: ${value}\n\nExample: codemem artifact --kind audit --apply`,
  };
}

function validateArtifactSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(slug)) {
    throw new Error(`invalid artifact slug "${slug}"`);
  }
}

function parseBaselineCommand(argv: string[], cwd: string): CliParseResult {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { ok: false, exitCode: 0, message: rootHelp() };
  }
  const parsedOptions = parseOptions(rest, cwd);
  if (!parsedOptions.ok) {
    return parsedOptions;
  }
  const options = parsedOptions.options;

  switch (subcommand) {
    case "diff":
      return {
        ok: true,
        command: {
          kind: "baseline-diff",
          baselinePath: options.baselinePath,
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    case "write":
      return {
        ok: true,
        command: {
          kind: "baseline-write",
          baselinePath: options.baselinePath,
          dryRun: !options.apply,
          json: options.json,
          maxFindings: options.maxFindings,
          projectRoot: options.projectRoot,
        },
      };
    default:
      return {
        ok: false,
        exitCode: 2,
        message: `Unknown codemem baseline command: ${subcommand}\n\n${rootHelp()}`,
      };
  }
}

function resolveBaselinePath(
  stateDirectory: string,
  projectRoot: string,
  baselinePath: string | undefined,
): string {
  if (!baselinePath) {
    return path.join(stateDirectory, "findings-baseline.json");
  }
  return path.isAbsolute(baselinePath) ? baselinePath : path.resolve(projectRoot, baselinePath);
}

function parsePositiveInteger(
  value: string,
  flag: string,
  example: string,
): { ok: true; value: number } | CliErrorResult {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      exitCode: 2,
      message: `Invalid ${flag} value: ${value}\n\nExample: ${example}`,
    };
  }
  return { ok: true, value: parsed };
}

function readOptionValue(
  argv: string[],
  index: number,
  flag: string,
  example: string,
): { ok: true; value: string } | CliErrorResult {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) return missingValue(flag, example);
  return { ok: true, value };
}

function parseReportFormat(
  value: string,
): { ok: true; value: "json" | "markdown" | "sarif" } | CliErrorResult {
  if (value === "json" || value === "markdown" || value === "sarif") {
    return { ok: true, value };
  }
  return {
    ok: false,
    exitCode: 2,
    message: `Invalid --format value: ${value}\n\nExample: codemem report --format sarif`,
  };
}

function firstPath(options: ParsedOptions): { ok: true; value: string } | CliErrorResult {
  const [path] = options.paths;
  if (!path) {
    return {
      ok: false,
      exitCode: 2,
      message:
        "Missing --path for impact-cone\n\nExample: codemem impact-cone --path src/index.ts --depth 2",
    };
  }
  return { ok: true, value: path };
}

function requiredPaths(
  options: ParsedOptions,
  commandName: string,
): { ok: true; value: string[] } | CliErrorResult {
  if (options.paths.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      message: `Missing --path for ${commandName}\n\nExample: codemem ${commandName} --path src/index.ts --depth 2`,
    };
  }
  return { ok: true, value: options.paths };
}

function missingValue(flag: string, example: string): CliErrorResult {
  return {
    ok: false,
    exitCode: 2,
    message: `Missing value for ${flag}\n\nExample: ${example}`,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
}

function rootHelp(): string {
  return [
    "Usage: codemem <command> [options]",
    "",
    "Commands:",
    "  doctor      Run fleet-standard health check",
    "  status      Show daemon and index status",
    "  check       Run analysis.check",
    "  drift-map   Run analysis.driftMap",
    "  conflicts   Run analysis.conflicts",
    "  maintain    Preview or apply maintenance actions",
    "  rebuild     Preview or apply index rebuild",
    "  baseline    Diff or write finding baselines",
    "  impact-cone Show dependency impact cone for a path",
    "  change-risk Score dependency-graph risk for changed paths",
    "  review-focus Rank paths and symbols that need review attention",
    "  change-delta Diff current findings against a baseline",
    "  api-surface Show indexed public exports",
    "  layer-boundaries Show configured layer boundaries and package cycles",
    "  lockfile    Show known lockfiles and digests",
    "  explain     Explain one finding by stable id",
    "  report      Export findings as JSON, Markdown, or SARIF",
    "  artifact    Emit codemem findings to Conductor/Engram artifacts",
    "",
    "Options:",
    "  --project-root <path>   Project root (default: current directory)",
    "  --json                  Print JSON output",
    "  --path <path>           Limit check to a path; repeatable",
    "  --max-findings <n>      Maximum findings for check/drift-map",
    "  --max-items <n>         Maximum review-focus items",
    "  --include-evidence      Include finding evidence in check output",
    "  --no-wait               Do not force a fresh index before check",
    "  --session-id <id>       Filter conflicts by session",
    "  --dry-run               Preview mutating commands (default)",
    "  --apply                 Apply maintain/rebuild actions",
    "  --prune-logs            Include log pruning in maintain",
    "  --compact               Include SQLite compact in maintain",
    "  --baseline <path>       Finding baseline path",
    "  --depth <n>             Impact cone depth",
    "  --id <finding-id>       Finding id for explain",
    "  --format <format>       Report format: json, markdown, sarif",
    "  --kind <kind>           Artifact kind: audit, journal",
    "  --slug <slug>           Audit artifact slug",
    "",
    "Examples:",
    "  codemem doctor --json",
    "  codemem status --json",
    "  codemem check --path src/index.ts --max-findings 25 --json",
    "  codemem drift-map --max-findings 50 --json",
    "  codemem conflicts --session-id sess_123 --json",
    "  codemem maintain --compact --json",
    "  codemem rebuild --apply --json",
    "  codemem baseline diff --json",
    "  codemem baseline write --apply --json",
    "  codemem impact-cone --path src/index.ts --depth 2 --json",
    "  codemem change-risk --path src/index.ts --depth 2 --json",
    "  codemem review-focus --path src/index.ts --max-items 10 --json",
    "  codemem change-delta --baseline .codemem/findings-baseline.json --json",
    "  codemem api-surface --json",
    "  codemem layer-boundaries --json",
    "  codemem lockfile --json",
    "  codemem explain --id dead:src/a.ts:unused",
    "  codemem report --format sarif --json",
    "  codemem artifact --kind audit --slug codemem-audit --apply --json",
  ].join("\n");
}

if (isCliEntrypoint(process.argv[1])) {
  const exitCode = await runCodeMemCli();
  process.exit(exitCode);
}

function isCliEntrypoint(argvPath: string | undefined): boolean {
  return Boolean(
    argvPath?.endsWith("/cli.ts") ||
    argvPath?.endsWith("\\cli.ts") ||
    argvPath?.endsWith("/cli.js") ||
    argvPath?.endsWith("\\cli.js") ||
    argvPath?.endsWith("/codemem") ||
    argvPath?.endsWith("\\codemem"),
  );
}

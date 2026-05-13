#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { makeHealthReport, type HealthCheck, type HealthReport } from "@mazac-fox/opencode-fleet-contracts";
import {
  createCodememAuditArtifact,
  createCodememJournalEntry,
  type CodememJournalEntry,
} from "@mazac-fox/codemem-shared/artifacts";
import {
  createFindingBaseline,
  diffFindingBaseline,
  parseFindingBaselineJson,
  type FindingBaseline,
  type FindingBaselineDiff,
} from "@mazac-fox/codemem-shared/baseline";
import { loadCodeMemConfig, resolveStateDirectory } from "@mazac-fox/codemem-shared/config";
import { createMarkdownReport, createSarifReport, explainFinding } from "@mazac-fox/codemem-shared/report";
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
} from "@mazac-fox/codemem-shared/protocol";
import { DaemonSupervisor, type DaemonStopResult, type StaleEndpointCleanup } from "./daemon/supervisor";

type CodeMemDoctorReport = HealthReport & { health: StatusResponse["health"] };

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
  pathsFromStdin: boolean;
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
  maxFiles: number;
  path: string;
};

export type ChangeRiskCliCommand = BaseCliCommand & {
  kind: "change-risk";
  depth: number;
  maxFiles: number;
  maxFindings: number;
  paths: string[];
  pathsFromStdin: boolean;
};

export type BeforeEditCliCommand = BaseCliCommand & {
  kind: "before-edit";
  depth: number;
  maxFiles: number;
  maxFindings: number;
  paths: string[];
  pathsFromStdin: boolean;
};

export type ReviewFocusCliCommand = BaseCliCommand & {
  kind: "review-focus";
  depth: number;
  maxFiles: number;
  maxFindings: number;
  maxItems: number;
  paths: string[];
  pathsFromStdin: boolean;
};

export type ChangeDeltaCliCommand = BaseCliCommand & {
  kind: "change-delta";
  baselinePath?: string;
  maxFindings: number;
};

export type ApiSurfaceCliCommand = BaseCliCommand & {
  kind: "api-surface";
  maxExports: number;
  path?: string;
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
  | BeforeEditCliCommand
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
  beforeEdit(command: BeforeEditCliCommand): Promise<ChangeRiskResponse>;
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
  stdin?: () => Promise<string>;
};

const DEFAULT_MAX_FINDINGS = 50;
const DEFAULT_MAX_FILES = 50;

export function parseCliArgs(argv: string[], cwd: string): CliParseResult {
  const [commandName, ...rest] = argv;
  if (!commandName || commandName === "--help" || commandName === "-h") {
    return { ok: false, exitCode: 0, message: rootHelp() };
  }

  if (commandName === "baseline") {
    return parseBaselineCommand(rest, cwd);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    return { ok: false, exitCode: 0, message: commandHelp(commandName) };
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
          pathsFromStdin: options.pathsFromStdin,
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
          maxFiles: options.maxFiles,
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
          maxFiles: options.maxFiles,
          maxFindings: options.maxFindings,
          paths: paths.value,
          pathsFromStdin: options.pathsFromStdin,
          projectRoot: options.projectRoot,
        },
      };
    }
    case "before-edit": {
      const paths = requiredPaths(options, "before-edit");
      if (!paths.ok) return paths;
      return {
        ok: true,
        command: {
          kind: "before-edit",
          depth: options.depth,
          json: options.json,
          maxFiles: options.maxFiles,
          maxFindings: options.maxFindings,
          paths: paths.value,
          pathsFromStdin: options.pathsFromStdin,
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
          maxFiles: options.maxFiles,
          maxFindings: options.maxFindings,
          maxItems: options.maxItems,
          paths: paths.value,
          pathsFromStdin: options.pathsFromStdin,
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
          path: options.paths[0],
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
        message: `Unknown codemem command: ${commandName}\n\nExample: codemem check --path src/index.ts --json`,
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
  const started = Date.now();
  const parsed = parseCliArgs(argv, cwd);

  if (!parsed.ok) {
    const write = parsed.exitCode === 0 ? stdout : stderr;
    write(wantsJson(argv) && parsed.exitCode !== 0 ? formatCliErrorJson(parsed, argv, started) : parsed.message);
    return parsed.exitCode;
  }

  try {
    const command = await hydrateStdinPaths(parsed.command, options.stdin);
    if (!options.runtime && command.kind === "stop") {
      const result = await runStopCommand(command);
      stdout(command.json ? JSON.stringify(result, null, 2) : formatStop(result));
      return 0;
    }
    if (!options.runtime && command.kind === "cleanup") {
      const result = await runCleanupCommand(command);
      stdout(command.json ? JSON.stringify(result, null, 2) : formatCleanup(result));
      return 0;
    }
    const runtime = options.runtime ?? (await createDaemonRuntime(command.projectRoot));
    stdout(await executeAndFormat(command, runtime));
    return 0;
  } catch (error) {
    stderr(wantsJson(argv) ? formatRuntimeErrorJson(error, argv, started) : formatError(error));
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
        maxFiles: command.maxFiles,
      }),
    changeRisk: (command) =>
      client.changeRisk({
        projectRoot: command.projectRoot,
        paths: command.paths,
        depth: command.depth,
        maxFindings: command.maxFindings,
        maxFiles: command.maxFiles,
      }),
    beforeEdit: (command) =>
      client.changeRisk({
        projectRoot: command.projectRoot,
        paths: command.paths,
        depth: command.depth,
        maxFindings: command.maxFindings,
        maxFiles: command.maxFiles,
      }),
    reviewFocus: (command) =>
      client.changeRisk({
        projectRoot: command.projectRoot,
        paths: command.paths,
        depth: command.depth,
        maxFindings: command.maxFindings,
        maxFiles: command.maxFiles,
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
        path: command.path,
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
    case "before-edit": {
      const result = await runtime.beforeEdit(command);
      const advisory = {
        advisory: true,
        safeToEdit: result.level !== "high",
        level: result.level,
        score: result.score,
        focus: result.focus,
        reasons: result.reasons,
        impactedFiles: result.impactedFiles,
        impactedFilesTruncated: result.impactedFilesTruncated,
        omittedImpactedFiles: result.omittedImpactedFiles,
        indexedAtUnixMs: result.indexedAtUnixMs,
      };
      return command.json ? JSON.stringify(advisory, null, 2) : formatBeforeEdit(advisory);
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
    status.health.rssBytes === undefined || status.health.rssBytes === null
      ? undefined
      : `rss_mb: ${bytesToMiB(status.health.rssBytes).toFixed(1)}`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function formatDoctor(report: HealthReport): string {
  return [
    `status: ${report.status}`,
    ...report.checks.map((check: HealthCheck) => {
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

function createDoctorHealthReport(status: StatusResponse): CodeMemDoctorReport {
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
      name: "queue_drops",
      status: (status.health.droppedBatches ?? 0) > 0 ? "warn" : "ok",
      message: `${status.health.droppedBatches ?? 0} dropped index batches`,
    },
    {
      name: "index_failures",
      status: (status.health.failedBatches ?? 0) > 0 ? "warn" : "ok",
      message: `${status.health.failedBatches ?? 0} failed index batches`,
    },
    {
      name: "latency_metrics",
      status: status.health.metrics ? "ok" : "warn",
      message: status.health.metrics
        ? `${Object.keys(status.health.metrics.operations).length} operation histograms`
        : "daemon has not reported operation metrics",
    },
    {
      name: "memory_rss",
      status:
        status.health.rssBytes === undefined || status.health.rssBytes === null ? "warn" : "ok",
      message:
        status.health.rssBytes === undefined || status.health.rssBytes === null
          ? (status.health.rssUnavailableReason ?? "daemon rss unavailable")
          : `${bytesToMiB(status.health.rssBytes).toFixed(1)} MiB resident set`,
      detail: {
        rssBytes: status.health.rssBytes ?? null,
        rssUnavailableReason: status.health.rssUnavailableReason,
      },
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
  const report = makeHealthReport({
    source: "codemem",
    checks,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });
  return {
    ...report,
    health: status.health,
  };
}

function bytesToMiB(bytes: number): number {
  return bytes / 1024 / 1024;
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
    impactCone.omittedCount ? `omitted_files: ${impactCone.omittedCount}` : undefined,
    ...impactCone.files,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function formatChangeRisk(changeRisk: ChangeRiskResponse): string {
  return [
    `level: ${changeRisk.level}`,
    `score: ${changeRisk.score}`,
    `paths: ${changeRisk.paths.length}`,
    `impacted_files: ${changeRisk.impactedFiles.length}`,
    changeRisk.omittedImpactedFiles ? `omitted_impacted_files: ${changeRisk.omittedImpactedFiles}` : undefined,
    `reasons: ${changeRisk.reasons.length}`,
    ...changeRisk.reasons.map((reason) => `${reason.severity} ${reason.kind}: ${reason.detail}`),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function formatBeforeEdit(result: {
  safeToEdit: boolean;
  level: string;
  score: number;
  focus: ChangeRiskResponse["focus"];
  reasons: ChangeRiskResponse["reasons"];
  impactedFiles: string[];
  omittedImpactedFiles?: number;
}): string {
  return [
    "advisory: true",
    `safe_to_edit: ${result.safeToEdit}`,
    `level: ${result.level}`,
    `score: ${result.score}`,
    `impacted_files: ${result.impactedFiles.length}`,
    result.omittedImpactedFiles ? `omitted_impacted_files: ${result.omittedImpactedFiles}` : undefined,
    `focus: ${result.focus.length}`,
    `reasons: ${result.reasons.length}`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
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
  maxFiles: number;
  maxFindings: number;
  maxItems: number;
  paths: string[];
  pathsFromStdin: boolean;
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
    maxFiles: DEFAULT_MAX_FILES,
    maxFindings: DEFAULT_MAX_FINDINGS,
    maxItems: 10,
    paths: [],
    pathsFromStdin: false,
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
      case "--paths-stdin":
      case "--stdin":
        options.pathsFromStdin = true;
        break;
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
      case "--max-files": {
        const value = readOptionValue(
          argv,
          index,
          "--max-files",
          "codemem impact-cone --path src/index.ts --max-files 50 --json",
        );
        if (!value.ok) return value;
        const parsed = parsePositiveInteger(
          value.value,
          "--max-files",
          "codemem impact-cone --path src/index.ts --max-files 50 --json",
        );
        if (!parsed.ok) return parsed;
        options.maxFiles = parsed.value;
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
          message: `Unknown codemem option: ${arg}\n\nExample: codemem check --path src/index.ts --json`,
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
    pathsFromStdin: false,
    projectRoot: command.projectRoot,
    waitForFreshIndex: true,
  };
}

async function hydrateStdinPaths(
  command: CliCommand,
  stdin?: () => Promise<string>,
): Promise<CliCommand> {
  if (!commandAcceptsStdinPaths(command) || !command.pathsFromStdin) {
    return command;
  }
  const raw = stdin ? await stdin() : await readProcessStdin();
  const stdinPaths = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const paths = [...command.paths, ...stdinPaths];
  if (paths.length === 0) {
    throw new Error(
      `Missing --path or stdin paths for ${command.kind}. Example: printf 'src/index.ts\\n' | codemem ${command.kind} --paths-stdin --json`,
    );
  }
  return { ...command, paths };
}

function commandAcceptsStdinPaths(
  command: CliCommand,
): command is CheckCliCommand | ChangeRiskCliCommand | BeforeEditCliCommand | ReviewFocusCliCommand {
  return (
    command.kind === "check" ||
    command.kind === "change-risk" ||
    command.kind === "before-edit" ||
    command.kind === "review-focus"
  );
}

async function readProcessStdin(): Promise<string> {
  return Bun.stdin.text();
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
    return { ok: false, exitCode: 0, message: commandHelp("baseline") };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return { ok: false, exitCode: 0, message: commandHelp(`baseline ${subcommand}`) };
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
        message: `Unknown codemem baseline command: ${subcommand}\n\nExample: codemem baseline diff --json`,
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
  if (options.paths.length === 0 && !options.pathsFromStdin) {
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

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function formatCliErrorJson(error: CliErrorResult, argv: string[], started: number): string {
  return JSON.stringify(
    {
      ok: false,
      error: {
        code: error.exitCode === 2 ? "E_CODEMEM_CLI_USAGE" : "E_CODEMEM_CLI_ERROR",
        message: error.message.split("\n")[0],
        retryable: false,
        example: exampleFromMessage(error.message),
      },
      operation: operationEnvelope(argv, started, 0),
    },
    null,
    2,
  );
}

function formatRuntimeErrorJson(error: unknown, argv: string[], started: number): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify(
    {
      ok: false,
      error: {
        code: "E_CODEMEM_CLI_RUNTIME",
        message,
        retryable: false,
      },
      operation: operationEnvelope(argv, started, 0),
    },
    null,
    2,
  );
}

function operationEnvelope(argv: string[], started: number, bytesOut: number): {
  name: string;
  durationMs: number;
  counts: Record<string, number>;
  truncated: boolean;
  bytesOut: number;
} {
  return {
    name: argv[0] ?? "help",
    durationMs: Date.now() - started,
    counts: {},
    truncated: false,
    bytesOut,
  };
}

function exampleFromMessage(message: string): string | undefined {
  const example = message
    .split("\n")
    .find((line) => line.startsWith("Example: "))
    ?.slice("Example: ".length);
  return example && example.length > 0 ? example : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
}

function rootHelp(): string {
  return [
    "Usage: codemem <command> [options]",
    "",
    "Commands:",
    "  doctor, status, stop, cleanup",
    "  check, drift-map, conflicts",
    "  before-edit, change-risk, review-focus, impact-cone",
    "  api-surface, layer-boundaries, lockfile",
    "  baseline, change-delta, explain, report, artifact",
    "",
    "Examples:",
    "  codemem doctor --json",
    "  codemem check --path src/index.ts --json",
    "  printf 'src/a.ts\\nsrc/b.ts\\n' | codemem before-edit --paths-stdin --json",
    "",
    "Run `codemem <command> --help` for flags and copy-pasteable examples.",
  ].join("\n");
}

function commandHelp(commandName: string): string {
  const common = ["", "Common flags:", "  --project-root <path>   Project root (default: current directory)", "  --json                  Stable JSON output"];
  const pathBulk = [
    "  --path <path>           Path input; repeatable",
    "  --paths-stdin           Read newline-delimited paths from stdin",
  ];
  const examples: Record<string, string[]> = {
    doctor: ["Usage: codemem doctor [--json]", ...common, "", "Examples:", "  codemem doctor --json"],
    status: ["Usage: codemem status [--json]", ...common, "", "Examples:", "  codemem status --json"],
    stop: ["Usage: codemem stop [--json]", ...common, "", "Examples:", "  codemem stop --json"],
    cleanup: [
      "Usage: codemem cleanup --stale [--json]",
      ...common,
      "  --stale                 Remove only proven-stale daemon state",
      "",
      "Examples:",
      "  codemem cleanup --stale --json",
    ],
    check: [
      "Usage: codemem check [--path <path>...] [--paths-stdin] [--json]",
      ...common,
      ...pathBulk,
      "  --max-findings <n>      Maximum findings (default: 50)",
      "  --include-evidence      Include evidence arrays",
      "  --no-wait               Do not force a fresh index first",
      "",
      "Examples:",
      "  codemem check --path src/index.ts --max-findings 25 --json",
      "  printf 'src/a.ts\\nsrc/b.ts\\n' | codemem check --paths-stdin --json",
    ],
    "drift-map": [
      "Usage: codemem drift-map [--max-findings <n>] [--json]",
      ...common,
      "  --max-findings <n>      Maximum findings in map (default: 50)",
      "",
      "Examples:",
      "  codemem drift-map --max-findings 50 --json",
    ],
    conflicts: [
      "Usage: codemem conflicts [--session-id <id>] [--json]",
      ...common,
      "  --session-id <id>       Optional session filter",
      "",
      "Examples:",
      "  codemem conflicts --session-id sess_123 --json",
    ],
    maintain: [
      "Usage: codemem maintain [--prune-logs] [--compact] [--apply] [--json]",
      ...common,
      "  --prune-logs            Include log pruning",
      "  --compact               Include SQLite checkpoint/VACUUM",
      "  --apply                 Apply actions (dry-run by default)",
      "",
      "Examples:",
      "  codemem maintain --compact --json",
      "  codemem maintain --prune-logs --compact --apply --json",
    ],
    rebuild: [
      "Usage: codemem rebuild [--apply] [--json]",
      ...common,
      "  --apply                 Rebuild now (dry-run by default)",
      "",
      "Examples:",
      "  codemem rebuild --json",
      "  codemem rebuild --apply --json",
    ],
    "before-edit": [
      "Usage: codemem before-edit --path <path>... [--paths-stdin] [--json]",
      ...common,
      ...pathBulk,
      "  --depth <n>             Dependency cone depth (default: 2)",
      "  --max-files <n>         Maximum impacted files returned (default: 50)",
      "",
      "Examples:",
      "  codemem before-edit --path src/index.ts --depth 2 --json",
      "  printf 'src/a.ts\\nsrc/b.ts\\n' | codemem before-edit --paths-stdin --max-files 25 --json",
    ],
    "impact-cone": [
      "Usage: codemem impact-cone --path <path> [--depth <n>] [--json]",
      ...common,
      "  --path <path>           Seed file",
      "  --depth <n>             Dependency cone depth (default: 2)",
      "  --max-files <n>         Maximum files returned (default: 50)",
      "",
      "Examples:",
      "  codemem impact-cone --path src/index.ts --depth 2 --max-files 50 --json",
    ],
    "change-risk": [
      "Usage: codemem change-risk --path <path>... [--paths-stdin] [--json]",
      ...common,
      ...pathBulk,
      "  --depth <n>             Dependency cone depth (default: 2)",
      "  --max-files <n>         Maximum impacted files returned (default: 50)",
      "  --max-findings <n>      Maximum nearby findings (default: 50)",
      "",
      "Examples:",
      "  codemem change-risk --path src/index.ts --depth 2 --json",
      "  printf 'src/a.ts\\nsrc/b.ts\\n' | codemem change-risk --paths-stdin --json",
    ],
    "review-focus": [
      "Usage: codemem review-focus --path <path>... [--paths-stdin] [--json]",
      ...common,
      ...pathBulk,
      "  --max-items <n>         Maximum focus items (default: 10)",
      "  --max-files <n>         Maximum impacted files returned (default: 50)",
      "",
      "Examples:",
      "  codemem review-focus --path src/index.ts --max-items 10 --json",
    ],
    "api-surface": [
      "Usage: codemem api-surface [--path <path>] [--max-exports <n>] [--json]",
      ...common,
      "  --path <path>           Optional source file filter",
      "  --max-exports <n>       Maximum exports returned (default: 100)",
      "",
      "Examples:",
      "  codemem api-surface --json",
      "  codemem api-surface --path src/public-api.ts --max-exports 50 --json",
    ],
    "layer-boundaries": [
      "Usage: codemem layer-boundaries [--max-findings <n>] [--json]",
      ...common,
      "  --max-findings <n>      Maximum cycle findings (default: 50)",
      "",
      "Examples:",
      "  codemem layer-boundaries --max-findings 25 --json",
    ],
    lockfile: [
      "Usage: codemem lockfile [--json]",
      ...common,
      "",
      "Examples:",
      "  codemem lockfile --json",
    ],
    baseline: [
      "Usage: codemem baseline <diff|write> [options]",
      ...common,
      "  --baseline <path>       Baseline path",
      "  --apply                 Required to write a baseline",
      "",
      "Examples:",
      "  codemem baseline diff --baseline .codemem/findings-baseline.json --json",
      "  codemem baseline write --apply --json",
    ],
    "baseline diff": [
      "Usage: codemem baseline diff [--baseline <path>] [--json]",
      ...common,
      "  --baseline <path>       Baseline path",
      "",
      "Examples:",
      "  codemem baseline diff --baseline .codemem/findings-baseline.json --json",
    ],
    "baseline write": [
      "Usage: codemem baseline write [--baseline <path>] --apply [--json]",
      ...common,
      "  --baseline <path>       Baseline path",
      "  --apply                 Write the baseline (dry-run by default)",
      "",
      "Examples:",
      "  codemem baseline write --apply --json",
    ],
    explain: [
      "Usage: codemem explain --id <finding-id> [--json]",
      ...common,
      "  --id <finding-id>       Stable finding id",
      "",
      "Examples:",
      "  codemem explain --id dead:src/a.ts:unused --json",
    ],
    "change-delta": [
      "Usage: codemem change-delta [--baseline <path>] [--json]",
      ...common,
      "  --baseline <path>       Baseline path",
      "  --max-findings <n>      Maximum current findings (default: 50)",
      "",
      "Examples:",
      "  codemem change-delta --baseline .codemem/findings-baseline.json --json",
    ],
    report: [
      "Usage: codemem report --format <json|markdown|sarif> [--json]",
      ...common,
      "  --format <format>       json, markdown, or sarif",
      "  --max-findings <n>      Maximum findings (default: 50)",
      "",
      "Examples:",
      "  codemem report --format sarif --json",
      "  codemem report --format markdown",
    ],
    artifact: [
      "Usage: codemem artifact --kind <audit|journal> [--apply] [--json]",
      ...common,
      "  --kind <kind>           audit or journal",
      "  --slug <slug>           Audit artifact slug",
      "  --apply                 Write artifact (dry-run by default)",
      "",
      "Examples:",
      "  codemem artifact --kind audit --slug codemem-audit --apply --json",
      "  codemem artifact --kind journal --json",
    ],
  };
  return (
    examples[commandName] ??
    [
      `Usage: codemem ${commandName} [options]`,
      ...common,
      "",
      "Examples:",
      `  codemem ${commandName} --json`,
    ]
  ).join("\n");
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

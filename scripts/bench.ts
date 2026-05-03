#!/usr/bin/env bun
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

type BenchResult = {
  name: string;
  command: string[];
  duration_ms: number;
  ok: boolean;
  exit_code: number;
  output_bytes: number;
  rss_mb?: number;
};

type BenchReport = {
  schema_version: 1;
  mode: "quick" | "full";
  project_root: string;
  generated_at: string;
  result_path: string;
  results: BenchResult[];
  ok: boolean;
};

const args = process.argv.slice(2);
const repoRoot = process.cwd();
const requestedProjectRoot = path.resolve(repoRoot, valueArg("--project-root") ?? ".");
const json = args.includes("--json");
const quick = args.includes("--quick");
const keepTemp = args.includes("--keep-temp");
const cli = path.resolve(repoRoot, "packages", "codemem-plugin", "src", "cli.ts");

const tempRoot = quick ? undefined : await createSyntheticProject();
const projectRoot = tempRoot ?? requestedProjectRoot;

try {
  const results = quick ? runQuickBenches(projectRoot) : await runFullBenches(projectRoot);
  const report: BenchReport = {
    schema_version: 1,
    mode: quick ? "quick" : "full",
    project_root: projectRoot,
    generated_at: new Date().toISOString(),
    result_path: path.resolve(
      repoRoot,
      "bench",
      "results",
      `codemem-bench-${quick ? "quick" : "full"}.json`,
    ),
    results,
    ok: results.every((result) => result.ok),
  };
  await writeReport(report);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const result of results) {
      const rss = result.rss_mb === undefined ? "" : `\trss=${result.rss_mb.toFixed(1)}MB`;
      console.log(
        `${result.ok ? "pass" : "fail"}\t${result.name}\t${result.duration_ms}ms\t${result.output_bytes} bytes${rss}`,
      );
    }
  }

  process.exit(report.ok ? 0 : 1);
} finally {
  if (tempRoot && !keepTemp) await rm(tempRoot, { recursive: true, force: true });
}

function runQuickBenches(projectRoot: string): BenchResult[] {
  return [
    runBench(
      "status",
      ["bun", cli, "status", "--project-root", projectRoot, "--json"],
      projectRoot,
    ),
    runBench(
      "check",
      ["bun", cli, "check", "--project-root", projectRoot, "--max-findings", "50", "--json"],
      projectRoot,
    ),
  ];
}

async function runFullBenches(projectRoot: string): Promise<BenchResult[]> {
  const srcIndex = path.join(projectRoot, "src", "index.ts");
  const srcFeature = path.join(projectRoot, "src", "feature.ts");
  const results: BenchResult[] = [];
  results.push(
    runBench(
      "status-cold",
      ["bun", cli, "status", "--project-root", projectRoot, "--json"],
      projectRoot,
    ),
  );
  results.push(
    runBench(
      "cold-check",
      [
        "bun",
        cli,
        "check",
        "--project-root",
        projectRoot,
        "--path",
        "src/index.ts",
        "--max-findings",
        "50",
        "--json",
      ],
      projectRoot,
    ),
  );
  await writeFile(
    srcFeature,
    `${await Bun.file(srcFeature).text()}\nexport const hotEdit = feature + 1;\n`,
  );
  results.push(
    runBench(
      "hot-edit-check",
      [
        "bun",
        cli,
        "check",
        "--project-root",
        projectRoot,
        "--path",
        "src/feature.ts",
        "--max-findings",
        "50",
        "--json",
      ],
      projectRoot,
    ),
  );
  results.push(
    runBench(
      "review-focus",
      [
        "bun",
        cli,
        "review-focus",
        "--project-root",
        projectRoot,
        "--path",
        "src/index.ts",
        "--depth",
        "2",
        "--max-findings",
        "50",
        "--max-items",
        "10",
        "--json",
      ],
      projectRoot,
    ),
  );
  results.push(
    runBench(
      "status-warm",
      ["bun", cli, "status", "--project-root", projectRoot, "--json"],
      projectRoot,
    ),
  );
  if (!results.some((result) => result.name === "source-size")) {
    results.push({
      name: "source-size",
      command: ["measure", srcIndex],
      duration_ms: 0,
      ok: true,
      exit_code: 0,
      output_bytes: await Bun.file(srcIndex).size,
    });
  }
  return results;
}

function runBench(name: string, command: string[], projectRoot: string): BenchResult {
  const started = performance.now();
  const result = Bun.spawnSync(command, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const durationMs = Math.round(performance.now() - started);
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0 && stderr) console.error(`[${name}] ${stderr}`);
  return {
    name,
    command,
    duration_ms: durationMs,
    ok: result.exitCode === 0,
    exit_code: result.exitCode,
    output_bytes: result.stdout.byteLength,
    rss_mb: statusRssMb(stdout),
  };
}

async function createSyntheticProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codemem-bench-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "codemem-bench", type: "module" }, null, 2),
  );
  await writeFile(
    path.join(root, "src", "feature.ts"),
    [
      "export type FeatureInput = { id: string; count: number };",
      "export function feature(input: FeatureInput): number {",
      "  return input.count + input.id.length;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      "import { feature } from './feature';",
      "export function run(): number {",
      "  return feature({ id: 'bench', count: 1 });",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function statusRssMb(stdout: string): number | undefined {
  if (!stdout.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(stdout) as { health?: { rssBytes?: unknown }; rssBytes?: unknown };
    const rss =
      typeof parsed.health?.rssBytes === "number" ? parsed.health.rssBytes : parsed.rssBytes;
    return typeof rss === "number" ? Math.round((rss / 1024 / 1024) * 10) / 10 : undefined;
  } catch {
    return undefined;
  }
}

function valueArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function writeReport(report: BenchReport): Promise<void> {
  await mkdir(path.dirname(report.result_path), { recursive: true });
  await writeFile(report.result_path, `${JSON.stringify(report, null, 2)}\n`);
}

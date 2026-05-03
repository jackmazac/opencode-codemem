#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type BenchResult = {
  name: string;
  duration_ms: number;
  ok: boolean;
};

type BenchReport = {
  schema_version: 1;
  mode: "quick" | "full";
  project_root: string;
  generated_at: string;
  results: BenchResult[];
  ok: boolean;
};

type ThresholdCheck = {
  name: string;
  actual_ms: number;
  max_ms: number;
  status: "pass" | "fail";
};

type ThresholdReport = {
  schema_version: 1;
  generated_at: string;
  bench_mode: BenchReport["mode"];
  result_path: string;
  ok: boolean;
  checks: ThresholdCheck[];
};

type ThresholdConfig = {
  schema_version: 1;
  quick: Array<{ name: string; max_ms: number }>;
  full: Array<{ name: string; max_ms: number }>;
};

const args = process.argv.slice(2);
const json = args.includes("--json");
const quick = args.includes("--quick");
const thresholdsPath = path.resolve(
  valueArg("--thresholds") ?? path.join("bench", "thresholds.json"),
);
const bench = runBench(quick);
const thresholds = readThresholds(thresholdsPath);
const checks = thresholdsFor(thresholds, bench.mode).map((threshold) => {
  const result = bench.results.find((item) => item.name === threshold.name);
  if (!result) throw new Error(`benchmark result missing: ${threshold.name}`);
  return {
    name: threshold.name,
    actual_ms: result.duration_ms,
    max_ms: threshold.maxMs,
    status: result.ok && result.duration_ms <= threshold.maxMs ? "pass" : "fail",
  } satisfies ThresholdCheck;
});

const report: ThresholdReport = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  bench_mode: bench.mode,
  result_path: path.resolve("bench", "results", `codemem-bench-threshold-${bench.mode}.json`),
  ok: bench.ok && checks.every((item) => item.status === "pass"),
  checks,
};
await mkdir(path.dirname(report.result_path), { recursive: true });
await writeFile(report.result_path, `${JSON.stringify(report, null, 2)}\n`);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const item of checks) {
    console.log(`${item.status}\t${item.name}\t${item.actual_ms}ms\t<= ${item.max_ms}ms`);
  }
}

process.exit(report.ok ? 0 : 1);

function runBench(useQuick: boolean): BenchReport {
  const command = ["bun", "./scripts/bench.ts", "--json", ...(useQuick ? ["--quick"] : [])];
  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) process.exit(result.exitCode);
  const parsed = JSON.parse(stdout) as BenchReport;
  if (!parsed || !Array.isArray(parsed.results)) throw new Error("bench output is invalid");
  return parsed;
}

function readThresholds(filePath: string): ThresholdConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ThresholdConfig;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.quick) || !Array.isArray(parsed.full)) {
    throw new Error(`threshold config is invalid: ${filePath}`);
  }
  return parsed;
}

function thresholdsFor(
  config: ThresholdConfig,
  mode: BenchReport["mode"],
): Array<{ name: string; maxMs: number }> {
  return (mode === "quick" ? config.quick : config.full).map((item) => ({
    name: item.name,
    maxMs: item.max_ms,
  }));
}

function valueArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

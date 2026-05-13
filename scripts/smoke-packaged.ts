#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateHealthReport } from "@mazac-fox/opencode-fleet-contracts";

type SmokeStep = { name: string; ok: boolean; detail: string };

const json = process.argv.includes("--json");
const keepTemp = process.argv.includes("--keep-temp");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sharedTgz = path.join(root, "artifacts", "mazac-fox-codemem-shared-0.1.0.tgz");
const pluginTgz = path.join(root, "artifacts", "mazac-fox-codemem-plugin-0.1.1.tgz");
const temp = await mkdtemp(path.join(os.tmpdir(), "codemem-packaged-smoke-"));
const configRoot = path.join(temp, "config");
const projectRoot = path.join(temp, "project");
const steps: SmokeStep[] = [];

try {
  assertArtifact(sharedTgz);
  assertArtifact(pluginTgz);
  await mkdir(configRoot, { recursive: true });
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ type: "module", packageManager: "bun@1.3.13" }, null, 2),
  );
  await writeFile(
    path.join(projectRoot, "src", "alpha.ts"),
    "export type Alpha = { id: string; label: string }\nexport const alpha = (input: Alpha) => input.id\n",
  );
  await writeFile(
    path.join(configRoot, "package.json"),
    JSON.stringify(
      {
        dependencies: {
          "@mazac-fox/codemem-shared": `file:${sharedTgz}`,
          "@mazac-fox/codemem-plugin": `file:${pluginTgz}`,
          "@mazac-fox/opencode-fleet-contracts": "file:/Users/jack.mazac/Developer/opencode-fleet-contracts",
          "@mazac-fox/opencode-host-adapter": "file:/Users/jack.mazac/Developer/opencode-host-adapter",
        },
        overrides: { "@mazac-fox/codemem-shared": `file:${sharedTgz}` },
      },
      null,
      2,
    ),
  );

  run("bun", ["install"], configRoot);
  steps.push({ name: "install packaged tgz", ok: true, detail: configRoot });

  const bin = path.join(configRoot, "node_modules", ".bin", "codemem");
  assert(existsSync(bin), `missing codemem bin at ${bin}`);
  steps.push({ name: "codemem bin linked", ok: true, detail: bin });

  const doctor = run(bin, ["doctor", "--project-root", projectRoot, "--json"], configRoot);
  const doctorJson: unknown = JSON.parse(doctor.stdout);
  const doctorValidation = validateHealthReport(doctorJson);
  assert.equal(doctorValidation.ok, true);
  if (!doctorValidation.ok) throw new Error(doctorValidation.errors.join("; "));
  assert.notEqual(doctorValidation.value.status, "fail");
  steps.push({ name: "doctor", ok: true, detail: doctorValidation.value.status });

  const check = run(
    bin,
    ["check", "--project-root", projectRoot, "--max-findings", "10", "--json"],
    configRoot,
  );
  const checkJson: unknown = JSON.parse(check.stdout);
  assertCheckResponse(checkJson);
  steps.push({ name: "check", ok: true, detail: `${checkJson.findings.length} findings` });

  const report = { ok: true, temp, projectRoot, configRoot, steps };
  if (json) console.log(JSON.stringify(report, null, 2));
  else for (const step of steps) console.log(`pass\t${step.name}\t${step.detail}`);
} finally {
  if (!keepTemp) await rm(temp, { recursive: true, force: true });
}

function assertArtifact(file: string): void {
  if (!existsSync(file)) {
    throw new Error(`missing ${file}; run bun run package:local first`);
  }
}

function run(command: string, args: string[], cwd: string): { stdout: string } {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.exitCode}: ${stderr || stdout}`,
    );
  }
  return { stdout };
}

function assertCheckResponse(value: unknown): asserts value is { findings: unknown[] } {
  assert(isRecord(value), "check response must be an object");
  assert(Array.isArray(value.findings), "check response must include findings array");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

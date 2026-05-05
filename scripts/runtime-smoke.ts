#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { plugin } from "bun";

plugin({
  name: "codemem-source-alias",
  setup(build) {
    build.onResolve({ filter: /^@codemem\/shared$/ }, () => ({
      path: path.join(import.meta.dir, "..", "packages/codemem-shared/src/index.ts"),
    }));
    build.onResolve({ filter: /^@codemem\/shared\/.+/ }, (args) => ({
      path: path.join(
        import.meta.dir,
        "..",
        "packages/codemem-shared/src",
        `${args.path.slice("@codemem/shared/".length)}.ts`,
      ),
    }));
  },
});

const expectedTools = [
  "codemem_check",
  "codemem_drift_map",
  "codemem_conflicts",
  "codemem_change_risk",
  "codemem_before_edit",
  "codemem_review_focus",
  "codemem_api_surface",
  "codemem_impact_cone",
  "codemem_layer_boundaries",
  "codemem_artifact",
];

const { default: codememPlugin } = await import("../packages/codemem-plugin/src/index");
const temp = await mkdtemp(path.join(os.tmpdir(), "codemem-runtime-smoke-"));

try {
  await mkdir(path.join(temp, "src"), { recursive: true });
  await writeFile(path.join(temp, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  await writeFile(
    path.join(temp, "src", "alpha.ts"),
    "export type Alpha = { id: string };\nexport const alpha = (input: Alpha) => input.id;\n",
  );

  const hooks = await codememPlugin({
    client: {},
    project: { id: "runtime-smoke", path: temp },
    directory: temp,
    worktree: temp,
    experimental_workspace: {
      async register() {},
    },
    serverUrl: "http://localhost",
  });
  const tools = Object.keys(hooks.tool ?? {}).sort();
  assert.deepEqual(tools, [...expectedTools].sort());
  assert.equal(typeof hooks["tool.execute.after"], "function");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tools,
        hooks: Object.keys(hooks).filter((name) => name !== "tool").sort(),
        projectRoot: temp,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}

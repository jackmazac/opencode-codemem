#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { plugin } from "bun";
import type {
  ApiSurfaceRequest,
  ApiSurfaceResponse,
  CheckRequest,
  CheckResponse,
} from "../packages/codemem-shared/src/protocol";

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

const { defaultCodeMemConfig } = await import("../packages/codemem-shared/src/config");
const { DaemonClient } = await import("../packages/codemem-plugin/src/daemon/client");
const { createCodeMemTools } = await import("../packages/codemem-plugin/src/tools");

class SmokeClient extends DaemonClient {
  constructor() {
    super({
      address: "runtime-smoke",
      connectTimeoutMs: 1,
      maxPayloadBytes: 1024 * 1024,
      requestTimeoutMs: 1,
    });
  }

  override async check(_params: CheckRequest): Promise<CheckResponse> {
    return {
      findings: [],
      indexedAtUnixMs: Date.now(),
      stats: {
        cloneBuckets: 0,
        filesIndexed: 1,
        scanLatencyMs: 0,
        sessionsTracked: 0,
        typeBuckets: 0,
      },
      truncated: false,
    };
  }

  override async apiSurface(_params: ApiSurfaceRequest): Promise<ApiSurfaceResponse> {
    return {
      exports: [
        {
          exportName: "alpha",
          signature: "export const alpha: (input: Alpha) => string",
          sourceFile: "src/alpha.ts",
        },
      ],
      indexedAtUnixMs: Date.now(),
      total: 1,
      truncated: false,
    };
  }
}

const temp = await mkdtemp(path.join(os.tmpdir(), "codemem-runtime-smoke-"));

try {
  await mkdir(path.join(temp, "src"), { recursive: true });
  await writeFile(path.join(temp, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  await writeFile(
    path.join(temp, "src", "alpha.ts"),
    "export type Alpha = { id: string }\nexport const alpha = (input: Alpha) => input.id\n",
  );

  const client = new SmokeClient();
  const tools = createCodeMemTools({
    projectRoot: temp,
    async getConfig() {
      return { path: null, config: defaultCodeMemConfig() };
    },
    async ensureReady() {
      return client;
    },
    async maybeInjectSignals() {},
  });

  const context = {
    sessionID: "runtime-smoke-session",
    messageID: "runtime-smoke-message",
    callID: "runtime-smoke-call",
    metadata() {},
  };

  const check = await tools.codemem_check.execute(
    { maxFindings: 10, includeEvidence: true, waitForFreshIndex: false },
    context,
  );
  const checkJson: unknown = JSON.parse(check.output);
  assertObject(checkJson, "codemem_check output");
  assert(Array.isArray(checkJson.findings), "codemem_check output must include findings array");

  const apiSurface = await tools.codemem_api_surface.execute({ maxExports: 10 }, context);
  const apiSurfaceJson: unknown = JSON.parse(apiSurface.output);
  assertObject(apiSurfaceJson, "codemem_api_surface output");
  assert(
    Array.isArray(apiSurfaceJson.exports),
    "codemem_api_surface output must include exports array",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        tools: ["codemem_check", "codemem_api_surface"],
        projectRoot: temp,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object", `${name} must be an object`);
  assert.notEqual(value, null, `${name} must not be null`);
}

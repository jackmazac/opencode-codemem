import { describe, expect, test } from "bun:test";
import { createCodeMemTools } from "./tools";

const context = {
  sessionID: "session-a",
  messageID: "message-a",
  agent: "agent-a",
  directory: "/repo",
  worktree: "/repo",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
};

describe("codemem tools", () => {
  test("api surface forwards the optional path filter", async () => {
    let seenPath: string | undefined;
    const runtime = runtimeWithClient({
      async apiSurface(params: { path?: string }) {
        seenPath = params.path;
        return {
          exports: [],
          total: 0,
          truncated: false,
          indexedAtUnixMs: 1,
        };
      },
    });
    const tools = createCodeMemTools(runtime);

    const result = await tools.codemem_api_surface.execute(
      { path: "src/public-api.ts", maxExports: 5 },
      context,
    );

    expect(seenPath).toBe("src/public-api.ts");
    expect(JSON.parse(typeof result === "string" ? result : result.output).total).toBe(0);
  });

  test("artifact checks the whole project instead of sending an empty path filter", async () => {
    let seenPaths: string[] | undefined;
    const runtime = runtimeWithClient({
      async check(params: { paths?: string[] }) {
        seenPaths = params.paths;
        return {
          findings: [],
          truncated: false,
          indexedAtUnixMs: 1,
          stats: {
            filesIndexed: 1,
            scanLatencyMs: 1,
            cloneBuckets: 0,
            typeBuckets: 0,
            sessionsTracked: 0,
          },
        };
      },
    });
    const tools = createCodeMemTools(runtime);

    const result = await tools.codemem_artifact.execute(
      { kind: "audit", maxFindings: 5, dryRun: true },
      context,
    );

    expect(seenPaths).toBeUndefined();
    expect(JSON.parse(typeof result === "string" ? result : result.output).findings).toBe(0);
  });
});

function runtimeWithClient(client: Record<string, unknown>) {
  return {
    projectRoot: "/repo",
    async getConfig() {
      return {
        path: null,
        config: {
          maxFindings: 50,
        },
      };
    },
    async ensureReady() {
      return client;
    },
    async maybeInjectSignals() {},
  };
}

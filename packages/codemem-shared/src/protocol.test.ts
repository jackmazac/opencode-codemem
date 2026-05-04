import { describe, expect, test } from "bun:test";
import { createRpcNotification, createRpcRequest, decodeFrames, encodeFrame } from "./protocol";

describe("codemem RPC protocol", () => {
  test("round trips OpenCode session and turn ID casing", () => {
    const notification = createRpcNotification("project.filesChanged", {
      projectRoot: "/tmp/project",
      sessionID: "session-a",
      files: ["src/index.ts"],
      reason: "tool",
      turnID: "turn-7",
      observedAtUnixMs: 1234,
      workspace_id: "workspace-a",
      correlation_id: "corr-a",
      tool_call_id: "tool-call-a",
    });

    const decoded = decodeFrames(encodeFrame(notification));

    expect(decoded.remainder.length).toBe(0);
    expect(decoded.messages).toEqual([notification]);
  });

  test("round trips change risk requests with session ID casing", () => {
    const request = createRpcRequest("analysis.changeRisk", {
      projectRoot: "/tmp/project",
      paths: ["src/index.ts"],
      depth: 2,
      maxFindings: 25,
      sessionID: "session-a",
      plan_id: "plan-a",
      wave_id: "W5",
      agent_run_id: "agent-run-a",
      artifact_ref: "artifact-a",
    });

    const decoded = decodeFrames(encodeFrame(request));

    expect(decoded.remainder.length).toBe(0);
    expect(decoded.messages).toEqual([request]);
  });

  test("round trips fleet correlation on advisory analysis requests", () => {
    const correlation = {
      workspace_id: "workspace-a",
      plan_id: "plan-a",
      wave_id: "W5",
      agent_run_id: "agent-run-a",
      correlation_id: "corr-a",
      tool_call_id: "tool-call-a",
      artifact_ref: "artifact-a",
    };

    const requests = [
      createRpcRequest("analysis.check", {
        projectRoot: "/tmp/project",
        maxFindings: 20,
        includeEvidence: true,
        waitForFreshIndex: false,
        ...correlation,
      }),
      createRpcRequest("analysis.driftMap", {
        projectRoot: "/tmp/project",
        maxFindings: 20,
        ...correlation,
      }),
      createRpcRequest("analysis.conflicts", {
        projectRoot: "/tmp/project",
        ...correlation,
      }),
      createRpcRequest("analysis.impactCone", {
        projectRoot: "/tmp/project",
        path: "src/index.ts",
        depth: 2,
        ...correlation,
      }),
      createRpcRequest("analysis.apiSurface", {
        projectRoot: "/tmp/project",
        maxExports: 10,
        ...correlation,
      }),
      createRpcRequest("analysis.layerBoundaries", {
        projectRoot: "/tmp/project",
        maxFindings: 10,
        ...correlation,
      }),
    ];

    for (const request of requests) {
      const decoded = decodeFrames(encodeFrame(request));

      expect(decoded.remainder.length).toBe(0);
      expect(decoded.messages).toEqual([request]);
    }
  });

  test("round trips fleet correlation on artifact emit requests", () => {
    const request = {
      projectRoot: "/tmp/project",
      kind: "audit",
      slug: "codemem-audit",
      maxFindings: 10,
      dryRun: true,
      workspace_id: "workspace-a",
      plan_id: "plan-a",
      wave_id: "W5",
      agent_run_id: "agent-run-a",
      correlation_id: "corr-a",
      tool_call_id: "tool-call-a",
      artifact_ref: "artifact-a",
    };

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});

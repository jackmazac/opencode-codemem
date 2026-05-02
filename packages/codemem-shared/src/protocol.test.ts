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
    });

    const decoded = decodeFrames(encodeFrame(request));

    expect(decoded.remainder.length).toBe(0);
    expect(decoded.messages).toEqual([request]);
  });
});

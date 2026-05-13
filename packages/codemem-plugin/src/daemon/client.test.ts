import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CODEMEM_PROTOCOL_VERSION,
  decodeFrames,
  encodeFrame,
  type RpcResponseEnvelope,
} from "@mazac-fox/codemem-shared/protocol";
import { DaemonClient } from "./client";

describe("DaemonClient result validation", () => {
  test("rejects malformed daemon result payloads", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codemem-client-"));
    const socketPath = path.join(tempRoot, "codemem.sock");
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeFrames(buffer);
        buffer = decoded.remainder;
        for (const message of decoded.messages) {
          if (!("id" in message)) continue;
          const response: RpcResponseEnvelope = {
            jsonrpc: "2.0",
            protocolVersion: CODEMEM_PROTOCOL_VERSION,
            id: message.id,
            result: { healthy: true },
          };
          socket.write(encodeFrame(response));
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const client = new DaemonClient({
        address: socketPath,
        maxPayloadBytes: 1024 * 1024,
        connectTimeoutMs: 250,
        requestTimeoutMs: 1000,
      });

      await expect(client.health({ projectRoot: tempRoot })).rejects.toThrow(
        "invalid health result",
      );
    } finally {
      server.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

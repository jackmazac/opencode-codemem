import net from "node:net";
import type { Socket } from "node:net";
import { once } from "node:events";
import {
  CODEMEM_PROTOCOL_VERSION,
  createRpcRequest,
  decodeFrames,
  encodeFrame,
  isRpcErrorResponse,
  type CheckRequest,
  type CheckResponse,
  type ChangeRiskRequest,
  type ChangeRiskResponse,
  type ConflictsRequest,
  type ConflictsResponse,
  type DriftMapRequest,
  type DriftMapResponse,
  type FilesChangedNotification,
  type FilesChangedResponse,
  type HealthRequest,
  type HealthResponse,
  type ImpactConeRequest,
  type ImpactConeResponse,
  type ApiSurfaceRequest,
  type ApiSurfaceResponse,
  type LayerBoundariesRequest,
  type LayerBoundariesResponse,
  type LockfileRequest,
  type LockfileResponse,
  type MaintainRequest,
  type MaintainResponse,
  type RebuildRequest,
  type RebuildResponse,
  type RpcMethod,
  type RpcMethodMap,
  type RpcResponseEnvelope,
  type ShutdownRequest,
  type ShutdownResponse,
  type StatusRequest,
  type StatusResponse,
  type TelemetrySnapshot,
} from "@mazac-fox/codemem-shared/protocol";

export type DaemonEndpoint = {
  address: string;
  authToken?: string;
  maxPayloadBytes: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
};

export class DaemonClient {
  readonly endpoint: DaemonEndpoint;

  constructor(endpoint: DaemonEndpoint) {
    this.endpoint = endpoint;
  }

  health(params: HealthRequest): Promise<HealthResponse> {
    return this.request("health", params, { timeoutMs: this.endpoint.connectTimeoutMs });
  }

  filesChanged(params: FilesChangedNotification): Promise<FilesChangedResponse> {
    return this.request("project.filesChanged", params, { timeoutMs: this.endpoint.requestTimeoutMs });
  }

  check(params: CheckRequest): Promise<CheckResponse> {
    return this.request("analysis.check", params);
  }

  driftMap(params: DriftMapRequest): Promise<DriftMapResponse> {
    return this.request("analysis.driftMap", params);
  }

  conflicts(params: ConflictsRequest): Promise<ConflictsResponse> {
    return this.request("analysis.conflicts", params);
  }

  impactCone(params: ImpactConeRequest): Promise<ImpactConeResponse> {
    return this.request("analysis.impactCone", params);
  }

  changeRisk(params: ChangeRiskRequest): Promise<ChangeRiskResponse> {
    return this.request("analysis.changeRisk", params);
  }

  apiSurface(params: ApiSurfaceRequest): Promise<ApiSurfaceResponse> {
    return this.request("analysis.apiSurface", params);
  }

  layerBoundaries(params: LayerBoundariesRequest): Promise<LayerBoundariesResponse> {
    return this.request("analysis.layerBoundaries", params);
  }

  lockfile(params: LockfileRequest): Promise<LockfileResponse> {
    return this.request("analysis.lockfile", params);
  }

  status(params: StatusRequest): Promise<StatusResponse> {
    return this.request("maintenance.status", params);
  }

  maintain(params: MaintainRequest): Promise<MaintainResponse> {
    return this.request("maintenance.maintain", params, { timeoutMs: 30_000 });
  }

  rebuild(params: RebuildRequest): Promise<RebuildResponse> {
    return this.request("maintenance.rebuild", params, { timeoutMs: 30_000 });
  }

  shutdown(params: ShutdownRequest): Promise<ShutdownResponse> {
    return this.request("maintenance.shutdown", params, { timeoutMs: this.endpoint.requestTimeoutMs });
  }

  async request<M extends RpcMethod>(
    method: M,
    params: RpcMethodMap[M]["params"],
    options?: { timeoutMs?: number },
  ): Promise<RpcMethodMap[M]["result"]> {
    const timeoutMs = options?.timeoutMs ?? this.endpoint.requestTimeoutMs;
    const request = createRpcRequest(method, params, this.endpoint.authToken);
    const response = await this.exchange(request, timeoutMs);

    if (response.protocolVersion !== CODEMEM_PROTOCOL_VERSION) {
      throw new Error(
        `codemem protocol mismatch: client=${CODEMEM_PROTOCOL_VERSION} daemon=${response.protocolVersion}`,
      );
    }

    if (isRpcErrorResponse(response)) {
      throw Object.assign(new Error(`codemem ${response.error.code}: ${response.error.message}`), {
        retryable: response.error.retryable,
        details: response.error.details,
      });
    }

    if (!response.result) {
      throw new Error(`codemem daemon returned no result for ${method}`);
    }

    if (method === "health") {
      return validateHealthResult(response.result) as RpcMethodMap[M]["result"];
    }

    return response.result as RpcMethodMap[M]["result"];
  }

  private async exchange(
    request: ReturnType<typeof createRpcRequest>,
    timeoutMs: number,
  ): Promise<RpcResponseEnvelope> {
    const socket = await connectSocket(this.endpoint.address, this.endpoint.connectTimeoutMs);
    socket.setNoDelay(true);

    try {
      const payload = encodeFrame(request);
      if (payload.length > this.endpoint.maxPayloadBytes) {
        throw new Error(
          `codemem payload too large (${payload.length} bytes > ${this.endpoint.maxPayloadBytes} bytes)`,
        );
      }

      const response = await readResponse(socket, payload, request.id, timeoutMs);
      return response;
    } finally {
      socket.destroy();
    }
  }
}

async function connectSocket(address: string, timeoutMs: number): Promise<Socket> {
  const socket = net.createConnection(address);
  socket.setTimeout(0);

  const onError = new Promise<never>((_, reject) => {
    socket.once("error", (error) => reject(error));
  });
  const onConnect = once(socket, "connect");
  const timeout = createTimeout(timeoutMs, () => {
    socket.destroy(new Error(`codemem connect timeout after ${timeoutMs}ms`));
  });

  try {
    await Promise.race([onConnect, onError]);
    return socket;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponse(
  socket: Socket,
  payload: Buffer,
  requestID: string,
  timeoutMs: number,
): Promise<RpcResponseEnvelope> {
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;

  const timeout = createTimeout(timeoutMs, () => {
    socket.destroy(new Error(`codemem request timeout after ${timeoutMs}ms`));
  });

  try {
    const responsePromise = new Promise<RpcResponseEnvelope>((resolve, reject) => {
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        bufferedBytes += chunk.length;
        const buffer = chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks);
        const decoded = decodeFrames(buffer);
        chunks.length = 0;
        bufferedBytes = decoded.remainder.length;
        if (decoded.remainder.length > 0) {
          chunks.push(decoded.remainder);
        }
        for (const message of decoded.messages) {
          if (!("id" in message)) {
            continue;
          }
          if (message.id === requestID) {
            resolve(message);
            return;
          }
        }
      });
      socket.once("error", reject);
      socket.once("close", (hadError: boolean) => {
        if (!hadError) {
          reject(new Error("codemem daemon closed the socket before sending a response"));
        }
      });
    });

    socket.write(payload);
    return await responsePromise;
  } finally {
    clearTimeout(timeout);
  }
}

function createTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
  return setTimeout(onTimeout, Math.max(1, timeoutMs));
}

function validateHealthResult(value: unknown): HealthResponse {
  const result = requireRecord(value, "invalid health result");
  return {
    protocolVersion: requireNumber(result.protocolVersion, "invalid health result: protocolVersion"),
    schemaVersion: requireNumber(result.schemaVersion, "invalid health result: schemaVersion"),
    daemonVersion: requireString(result.daemonVersion, "invalid health result: daemonVersion"),
    projectRoot: requireString(result.projectRoot, "invalid health result: projectRoot"),
    startedAtUnixMs: requireNumber(result.startedAtUnixMs, "invalid health result: startedAtUnixMs"),
    healthy: requireBoolean(result.healthy, "invalid health result: healthy"),
    queueDepth: requireNumber(result.queueDepth, "invalid health result: queueDepth"),
    droppedBatches: optionalNumber(result.droppedBatches, "invalid health result: droppedBatches"),
    failedBatches: optionalNumber(result.failedBatches, "invalid health result: failedBatches"),
    indexedFiles: requireNumber(result.indexedFiles, "invalid health result: indexedFiles"),
    findingsCacheEntries: requireNumber(
      result.findingsCacheEntries,
      "invalid health result: findingsCacheEntries",
    ),
    rssBytes: optionalNullableNumber(result.rssBytes, "invalid health result: rssBytes"),
    rssUnavailableReason: optionalString(
      result.rssUnavailableReason,
      "invalid health result: rssUnavailableReason",
    ),
    metrics: optionalTelemetrySnapshot(result.metrics),
  };
}

function optionalTelemetrySnapshot(value: unknown): TelemetrySnapshot | undefined {
  if (value === undefined) return undefined;
  const snapshot = requireRecord(value, "invalid health result: metrics");
  const operations = requireRecord(snapshot.operations, "invalid health result: metrics.operations");
  const counters = requireRecord(snapshot.counters, "invalid health result: metrics.counters");
  const parsedOperations: TelemetrySnapshot["operations"] = {};
  for (const [name, rawMetric] of Object.entries(operations)) {
    const metric = requireRecord(rawMetric, `invalid health result: metrics.operations.${name}`);
    parsedOperations[name] = {
      count: requireNumber(metric.count, `invalid health result: metrics.operations.${name}.count`),
      p50Ms: requireNumber(metric.p50Ms, `invalid health result: metrics.operations.${name}.p50Ms`),
      p95Ms: requireNumber(metric.p95Ms, `invalid health result: metrics.operations.${name}.p95Ms`),
      maxMs: requireNumber(metric.maxMs, `invalid health result: metrics.operations.${name}.maxMs`),
    };
  }
  const parsedCounters: Record<string, number> = {};
  for (const [name, rawCounter] of Object.entries(counters)) {
    parsedCounters[name] = requireNumber(rawCounter, `invalid health result: metrics.counters.${name}`);
  }
  return {
    operations: parsedOperations,
    counters: parsedCounters,
    capturedAtUnixMs: requireNumber(
      snapshot.capturedAtUnixMs,
      "invalid health result: metrics.capturedAtUnixMs",
    ),
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  assertRecord(value, message);
  return value;
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function optionalNumber(value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value, message);
}

function optionalNullableNumber(value: unknown, message: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  return requireNumber(value, message);
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, message);
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new Error(message);
  return value;
}

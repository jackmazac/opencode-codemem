import type { ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { CodeMemConfig } from "@codemem/shared/config";

const z = tool.schema;

const MIN_DESCRIPTION_CHARS = 80;
const TRUNCATION_MARKER = " …[truncated codemem tools]";

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars);
  const head = maxChars - TRUNCATION_MARKER.length;
  return `${text.slice(0, head)}${TRUNCATION_MARKER}`;
}

function jsonSchemaCharLength(def: ToolDefinition): number {
  const schema = z.object(def.args);
  return JSON.stringify(z.toJSONSchema(schema)).length;
}

function measureTool(def: ToolDefinition): number {
  return def.description.length + jsonSchemaCharLength(def);
}

/** Env `CODEMEM_TOOL_SURFACE_MAX_CHARS` overrides config when set and valid. */
export function resolveCodememPluginToolSurfaceMaxChars(cfg: CodeMemConfig): number {
  const raw = process.env.CODEMEM_TOOL_SURFACE_MAX_CHARS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 10_000_000);
  }
  return cfg.pluginToolSurfaceMaxChars;
}

export function applyToolSurfaceBudget(
  tools: Record<string, ToolDefinition>,
  maxChars: number,
): Record<string, ToolDefinition> {
  const work: Record<string, ToolDefinition> = {};
  for (const [k, v] of Object.entries(tools)) {
    work[k] = { ...v, description: v.description };
  }

  const totalSize = (): number => {
    let n = 0;
    for (const def of Object.values(work)) {
      if (def === undefined) continue;
      n += measureTool(def);
    }
    return n;
  };

  for (let i = 0; i < 100_000; i++) {
    const t = totalSize();
    if (t <= maxChars) break;
    let pick: string | undefined;
    let bestLen = -1;
    for (const [name, def] of Object.entries(work)) {
      if (def === undefined) continue;
      if (def.description.length > bestLen && def.description.length > MIN_DESCRIPTION_CHARS) {
        pick = name;
        bestLen = def.description.length;
      }
    }
    if (pick === undefined) break;
    const picked = work[pick];
    if (picked === undefined) break;
    const over = t - maxChars;
    const step = Math.max(1, Math.min(2000, Math.ceil(over * 0.25)));
    const nextCap = Math.max(MIN_DESCRIPTION_CHARS, picked.description.length - step);
    const updated: ToolDefinition = {
      description: truncateWithMarker(picked.description, nextCap),
      args: picked.args,
      execute: picked.execute,
    };
    work[pick] = updated;
  }

  if (totalSize() > maxChars) {
    console.warn("[codemem] plugin tool surface exceeds budget after description truncation", {
      measured: totalSize(),
      maxChars,
    });
  }

  return work;
}

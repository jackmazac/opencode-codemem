import { runPluginContractTests } from "@jackmazac/opencode-host-adapter/contract-test";
import { fileURLToPath } from "node:url";

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

runPluginContractTests({
  pluginPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
  pluginName: "codemem",
  stubInput: () => ({
    directory: process.cwd(),
    worktree: process.cwd(),
    client: {
      session: {
        prompt: async () => undefined,
      },
    },
  }),
  exactTools: expectedTools,
});

import { rm } from "node:fs/promises";

const targets = [
  "packages/codemem-shared/dist",
  "packages/codemem-plugin/dist",
  "packages/codemem-shared/tsconfig.tsbuildinfo",
  "packages/codemem-plugin/tsconfig.tsbuildinfo",
  "packages/codemem-daemon/target",
];

await Promise.all(
  targets.map((target) => rm(new URL(`../${target}`, import.meta.url), { recursive: true, force: true })),
);

import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformArch = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "codemem-daemon.exe" : "codemem-daemon";
const daemonSource = path.join(root, "packages", "codemem-daemon", "target", "release", binaryName);
const daemonTarget = path.join(root, "packages", "codemem-plugin", "bin", platformArch, binaryName);

try {
  const fileStat = await stat(daemonSource);
  if (!fileStat.isFile()) {
    throw new Error(`not a file: ${daemonSource}`);
  }
} catch {
  throw new Error(`Missing ${daemonSource}. Run \`bun run build:daemon\` from repo root.`);
}

await mkdir(path.dirname(daemonTarget), { recursive: true });
await copyFile(daemonSource, daemonTarget);
if (process.platform !== "win32") {
  await chmod(daemonTarget, 0o755);
}

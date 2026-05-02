import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(root, "artifacts");
const platformArch = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "codemem-daemon.exe" : "codemem-daemon";
const daemonSource = path.join(root, "packages", "codemem-daemon", "target", "release", binaryName);
const daemonTarget = path.join(root, "packages", "codemem-plugin", "bin", platformArch, binaryName);

await assertFile(daemonSource, "Run `bun run build:daemon` before packaging.");
await rm(artifactsDir, { recursive: true, force: true });
await mkdir(path.dirname(daemonTarget), { recursive: true });
await mkdir(artifactsDir, { recursive: true });
await copyFile(daemonSource, daemonTarget);

if (process.platform !== "win32") {
  await chmod(daemonTarget, 0o755);
}

await packWorkspace("packages/codemem-shared");
await packWorkspace("packages/codemem-plugin");

async function packWorkspace(workspacePath) {
  await run("bun", ["pm", "pack", "--destination", artifactsDir], {
    cwd: path.join(root, workspacePath),
  });
}

async function assertFile(filePath, advice) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return;
    }
  } catch {
    // fall through to actionable error
  }
  throw new Error(`Missing required file: ${filePath}. ${advice}`);
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

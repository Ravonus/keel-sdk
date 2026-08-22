import { spawnSync } from "node:child_process";
import path from "node:path";

export const root = path.resolve(new URL("..", import.meta.url).pathname);

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function tsc(project) {
  const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const result = spawnSync(local, ["--version"], { cwd: root, stdio: "ignore" });
  run(result.status === 0 ? local : "tsc", ["-p", project]);
}

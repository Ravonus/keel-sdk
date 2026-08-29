import { spawnSync } from "node:child_process";
import path from "node:path";

export const root = path.resolve(new URL("..", import.meta.url).pathname);
/** Canonical contracts live beside the SDK; an explicit checkout may override this for CI. */
export const contractsRoot = path.resolve(
  process.env.KEEL_CONTRACTS_ROOT ?? path.join(root, "..", "keel-contracts"),
);
/** Canonical Studio lives in the sibling site repository; CI may pin another checkout. */
export const siteRoot = path.resolve(
  process.env.KEEL_SITE_ROOT ?? path.join(root, "..", "keel-site"),
);

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

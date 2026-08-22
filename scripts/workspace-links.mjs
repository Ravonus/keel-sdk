import { mkdir, lstat, rm, symlink } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const scope = path.join(root, "node_modules", "@oca");
await mkdir(scope, { recursive: true });
for (const name of ["protocol", "viewer", "sdk", "builder", "studio-core", "sandbox-sdk", "mcp", "ethereum-adapter"]) {
  const target = path.join(root, "packages", name);
  const link = path.join(scope, name);
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) continue;
    await rm(link, { force: true });
  } catch {}
  await symlink(path.relative(scope, target), link, "dir");
}

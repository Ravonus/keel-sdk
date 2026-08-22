import { rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
for (const directory of [
  "packages/protocol/dist",
  "packages/viewer/dist",
  "packages/sdk/dist",
  "packages/builder/dist",
  "packages/ethereum-adapter/dist",
  "packages/studio-core/dist",
  ".verification",
  "packages/contracts/artifacts",
]) {
  await rm(path.join(root, directory), { recursive: true, force: true });
}

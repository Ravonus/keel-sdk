import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const entryPoint = path.join(root, "examples/plugins/keel-market/wallet-runtime-wagmi-v1.ts");
const outputs = [
  path.join(root, "examples/plugins/keel-market/wallet-runtime-v1.js"),
  path.join(root, "apps/studio/public/keel/plugins/keel-market/wallet-runtime-v1.js"),
];

const buildOptions = {
  entryPoints: [entryPoint],
  bundle: true,
  charset: "utf8",
  format: "esm",
  legalComments: "eof",
  logLevel: "silent",
  minify: true,
  platform: "browser",
  sourcemap: false,
  target: "es2022",
  treeShaking: true,
  write: false,
};

async function bundle() {
  const result = await build(buildOptions);
  const output = result.outputFiles?.[0]?.contents;
  if (output === undefined) throw new Error("Wagmi wallet bundle produced no JavaScript output.");
  return output;
}

const [first, second] = await Promise.all([bundle(), bundle()]);
if (!Buffer.from(first).equals(Buffer.from(second))) {
  throw new Error("Wagmi wallet bundle is not deterministic.");
}
if (first.byteLength === 0 || first.byteLength > 4 * 1024 * 1024) {
  throw new RangeError("Wagmi wallet bundle must contain between 1 byte and 4 MiB.");
}
const text = new TextDecoder().decode(first);
for (const marker of ["keel-host-wallet-runtime@1", "keel-wagmi-wallet@1", "@wagmi/core", "@wagmi/connectors"]) {
  if (!text.includes(marker)) throw new Error(`Wagmi wallet bundle is missing ${marker}.`);
}
for (const output of outputs) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, first);
}
const digest = createHash("sha256").update(first).digest("hex");
console.log(`Built immutable Wagmi wallet runtime: ${first.byteLength} bytes, sha256 0x${digest}`);

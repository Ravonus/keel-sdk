import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_ROOT = path.join(ROOT, "packages", "sdk");
const SDK_MANIFEST = path.join(SDK_ROOT, "package.json");
const ABI_DIST = path.join(SDK_ROOT, "dist", "abi.js");
const demoRequire = createRequire(new URL("../apps/demo/package.json", import.meta.url));
const coolSManifest = fileURLToPath(new URL("../../cool-s-onchain/package.json", import.meta.url));
const viteRequire = existsSync(coolSManifest) ? createRequire(coolSManifest) : demoRequire;
const viteBin = path.join(path.dirname(viteRequire.resolve("vite/package.json")), "bin", "vite.js");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(fullPath) : [fullPath];
  }));
  return files.flat();
}

function viteBuild(fixtureRoot, configPath) {
  const result = spawnSync(process.execPath, [viteBin, "build", "--config", configPath, "--logLevel", "warn"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

nodeTest("@keel/sdk publishes the ABI facade as a direct subpath", async () => {
  const manifest = JSON.parse(await readFile(SDK_MANIFEST, "utf8"));
  assert.deepEqual(manifest.exports["./abi"], {
    types: "./dist/abi.d.ts",
    import: "./dist/abi.js",
  });

  await stat(ABI_DIST);
  const abi = await import(pathToFileURL(ABI_DIST).href);
  assert.equal(typeof abi.coolSLine721Abi, "object");
  assert.equal(typeof abi.oneMintControllerAbi, "object");
  assert.ok(
    abi.keelFactoryAbi.includes(
      "function predictDieAddress((string name,string symbol,address admin,address royaltyReceiver,uint96 royaltyBps,uint256 maxSupply,address mintManager,address keelIndex) config,address creator,uint256 nonce) view returns (address predicted)",
    ),
    "the browser factory ABI must support deterministic collection batching",
  );
});

nodeTest("a Vite browser consumer of @keel/sdk/abi stays clear of Node-only externalization", {
  timeout: 30_000,
}, async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "keel-sdk-browser-abi-"));
  try {
    const linkedSdk = path.join(fixtureRoot, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(
      path.join(fixtureRoot, "entry.js"),
      [
        'import { coolSLine721Abi, oneMintControllerAbi } from "@keel/sdk/abi";',
        "globalThis.__keelAbiCount = coolSLine721Abi.length + oneMintControllerAbi.length;",
      ].join("\n"),
    );
    const configPath = path.join(fixtureRoot, "vite.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        "  logLevel: 'warn',",
        "  build: {",
        "    lib: { entry: './entry.js', formats: ['es'], fileName: 'abi-consumer' },",
        "    outDir: './dist',",
        "    emptyOutDir: true,",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = viteBuild(fixtureRoot, configPath);
    const transcript = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `Vite ABI-consumer build failed:\n${transcript}`);

    const externalizationWarnings = transcript
      .split(/\r?\n/u)
      .filter((line) => /externalized for browser compatibility/iu.test(line))
      .filter((line) => /node:|esbuild|\b(?:fs|path|worker_threads|os|child_process|crypto|tty|util|zlib)\b/iu.test(line));
    assert.deepEqual(
      externalizationWarnings,
      [],
      `@keel/sdk/abi must not pull Node-only code into a browser bundle:\n${transcript}`,
    );

    const output = await Promise.all((await filesUnder(path.join(fixtureRoot, "dist")))
      .filter((file) => /\.[cm]?js$/u.test(file))
      .map((file) => readFile(file, "utf8")));
    assert.ok(output.length > 0, "Vite did not emit an ABI consumer bundle");
    assert.doesNotMatch(output.join("\n"), /verification-shell|node:(?:util|zlib|fs|path)/iu);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(
  repositoryRoot,
  "examples/demos/vault-arcade/generated-attribute-proxy/assets/weapons/generated-v1/generation-manifest.json",
);
const manifestDirectory = path.dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

async function digest(relativePath) {
  const bytes = await readFile(path.resolve(manifestDirectory, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

manifest.attributeCatalog.sha256 = await digest(manifest.attributeCatalog.file);
manifest.regionLayouts.sha256 = await digest(manifest.regionLayouts.file);
manifest.regionLayouts.editorSha256 = await digest(manifest.regionLayouts.editor);
manifest.regionLayouts.editorRuntimeSha256 = await digest(manifest.regionLayouts.editorRuntime);
manifest.regionLayouts.overrideDefaultsSha256 = await digest(manifest.regionLayouts.overrideDefaults);
manifest.regionLayouts.resolverSha256 = await digest(manifest.regionLayouts.resolver);
for (const definition of Object.values(manifest.weapons)) {
  definition.sourceSha256 = await digest(definition.source);
}
for (const definition of Object.values(manifest.retiredCandidates)) {
  definition.sourceSha256 = await digest(definition.source);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${manifestPath} ${await digest(path.basename(manifestPath))}`);

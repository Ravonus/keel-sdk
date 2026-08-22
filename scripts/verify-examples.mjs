import { readFile } from "node:fs/promises";
import path from "node:path";
import { manifestIntegrity, parseArtifactManifest } from "../packages/protocol/dist/index.js";
import { root } from "./run.mjs";

const examples = [
  ["examples/basic-manifest/manifest.json", "examples/basic-manifest/manifest.integrity.json"],
  ["examples/image-wrapper/release/manifest.json", "examples/image-wrapper/release/manifest.integrity.json"],
];

for (const [manifestName, sidecarName] of examples) {
  const raw = JSON.parse(await readFile(path.join(root, manifestName), "utf8"));
  const manifest = parseArtifactManifest(raw);
  const sidecar = JSON.parse(await readFile(path.join(root, sidecarName), "utf8"));
  const integrity = await manifestIntegrity(manifest);
  if (sidecar.schema !== "oca-manifest-integrity@2") throw new Error(`${sidecarName}: wrong sidecar schema.`);
  if (sidecar.canonicalization !== "RFC8785") throw new Error(`${sidecarName}: wrong canonicalization.`);
  if (sidecar.integrity?.algorithm !== integrity.algorithm) throw new Error(`${sidecarName}: wrong algorithm.`);
  if (sidecar.integrity?.digest !== integrity.digest) throw new Error(`${sidecarName}: digest mismatch.`);
  if (sidecar.integrity?.byteLength !== integrity.byteLength) throw new Error(`${sidecarName}: canonical length mismatch.`);
  console.log(`Verified example ${manifestName}: ${integrity.digest}`);
}

const metadata = JSON.parse(await readFile(path.join(root, "examples/basic-manifest/metadata.example.json"), "utf8"));
if (metadata.oca_schema !== "oca-manifest@2") throw new Error("metadata.example.json uses the wrong Keel schema.");
console.log("Example manifests and sidecars verified.");

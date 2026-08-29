import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stageKeelStudioProject } from "../../packages/sdk/dist/studio-upload.js";
import { defaultKeelStudioPublicationIntent } from "../../packages/sdk/dist/studio-publication.js";
import { p5ProjectBindings } from "./deployments.mjs";
import { createProjectFromStudio } from "./project.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioUrl = process.env.KEEL_STUDIO_URL ?? "https://keel-test.149-28-255-65.sslip.io";
const chainId = Number(process.env.KEEL_CHAIN_ID ?? "11155111");
const projectTitle = process.env.KEEL_PROJECT_TITLE?.trim() || "Seed Current";
const project = await createProjectFromStudio(await p5ProjectBindings(chainId), studioUrl);
const demo = path.resolve(here, "../demos/p5-flowfield");
const sketchBytes = new Uint8Array(await readFile(path.join(demo, "sketch.js")));
const releaseIntent = {
  ...JSON.parse(await readFile(path.join(here, "release-intent.json"), "utf8")),
  chainId,
};
const releaseIntentBytes = new TextEncoder().encode(`${JSON.stringify(releaseIntent, null, 2)}\n`);
const resources = [
  { path: "sketch.js", bytes: sketchBytes, mediaType: "text/javascript", role: "script", format: "es-module", label: "Creator p5 sketch" },
  { path: "release-intent.json", bytes: releaseIntentBytes, mediaType: "application/json", role: "data", format: "asset", label: "Editable 1 of 1 release intent" },
];

const loaded = resources.map((resource) => ({ ...resource, updateMode: "locked" }));
const identities = Object.fromEntries(loaded.map((resource) => [resource.path, {
  sha256: `0x${createHash("sha256").update(resource.bytes).digest("hex")}`,
  byteLength: resource.bytes.byteLength,
}]));
const declaration = new TextEncoder().encode(`${JSON.stringify({
  schema: "keel-agent-project-declaration@1",
  module: project.manifest,
  resources: identities,
  storageStrategy: "onchain",
  immutable: true,
}, null, 2)}\n`);

const token = process.env.KEEL_STUDIO_AGENT_TOKEN ?? process.env.FRAY_STUDIO_AGENT_TOKEN ?? process.env.STUDIO_WRITE_TOKEN;
if (token === undefined) throw new Error("Set KEEL_STUDIO_AGENT_TOKEN to the server-to-server Studio token.");
const result = await stageKeelStudioProject({
  studioUrl,
  agentToken: token,
  title: projectTitle,
  description: "A deterministic p5.js flow field whose p5 runtime and KEEL seeded-random module are declared, digest-locked, and verified before the strict sandbox mounts them.",
  storageStrategy: "onchain",
  // `recursive` is only the native KEEL object graph. release-intent.json
  // initially selects Inline; Studio still measures exact size and read gas.
  marketplaceExportMode: "recursive",
  releaseIntent,
  publicationIntent: defaultKeelStudioPublicationIntent({ mode: "drop-proceeds", maximumUsdCents: 2_000 }),
  files: [
    ...loaded.map(({ path: resourcePath, bytes, mediaType, role, format, updateMode, label }) => ({ path: resourcePath, bytes, mediaType, role, format, updateMode, label })),
    { path: "keel.module.json", bytes: declaration, mediaType: "application/json", role: "data", format: "asset", updateMode: "locked", label: "Exact KEEL module declaration" },
  ],
});

process.stdout.write(`${JSON.stringify({ ...result, modules: project.manifest.modules, resources: identities }, null, 2)}\n`);

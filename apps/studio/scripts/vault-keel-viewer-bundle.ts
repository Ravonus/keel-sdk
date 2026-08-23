import { readFile } from "node:fs/promises";
import path from "node:path";

import { utf8ToBytes } from "@keel/protocol";

const VIEWER_DEMO_PREFIX = "examples/demos/vault-arcade/generated-attribute-proxy";
export const VAULT_VIEWER_BUNDLE_INPUTS: readonly string[] = Object.freeze([
  `${VIEWER_DEMO_PREFIX}/vault-keel-viewer.html`,
  `${VIEWER_DEMO_PREFIX}/vault-keel-viewer.js`,
  `${VIEWER_DEMO_PREFIX}/vault-combat-shared.mjs`,
  `${VIEWER_DEMO_PREFIX}/vault-input-shared.mjs`,
  `${VIEWER_DEMO_PREFIX}/vault-verification.js`,
  `${VIEWER_DEMO_PREFIX}/orb-materials.mjs`,
  `${VIEWER_DEMO_PREFIX}/weapon-region-resolver.js`,
  `${VIEWER_DEMO_PREFIX}/weapon-material-runtime.mjs`,
  `${VIEWER_DEMO_PREFIX}/orb-core-v1-attribute-targets.json`,
  `${VIEWER_DEMO_PREFIX}/weapon-attributes-v1.json`,
  `${VIEWER_DEMO_PREFIX}/vault-game-atlas-v1.json`,
  `${VIEWER_DEMO_PREFIX}/weapon-region-layouts-v2.json`,
  `${VIEWER_DEMO_PREFIX}/weapon-region-overrides-v1.json`,
  `${VIEWER_DEMO_PREFIX}/weapon-sounds-v1.json`,
  `${VIEWER_DEMO_PREFIX}/keel-readers.js`,
  ...["gyro-saw-attack.ocas", "rift-fork-attack.ocas", "aegis-star-attack.ocas", "needle-array-attack.ocas"]
    .map((name) => `${VIEWER_DEMO_PREFIX}/audio/${name}`),
  `${VIEWER_DEMO_PREFIX}/orb-core-v1-turnaround.png`,
  `${VIEWER_DEMO_PREFIX}/orb-core-v1-material-mask.png`,
  `${VIEWER_DEMO_PREFIX}/orb-core-v1-panel-mask.png`,
  ...[
    "gyro-saw-96.png",
    "rift-fork-96.png",
    "aegis-star-96.png",
    "needle-array-96.png",
  ].map((name) => `${VIEWER_DEMO_PREFIX}/assets/weapons/generated-v1/${name}`),
  ...[
    "gyro-saw-spin",
    "rift-fork-fire-grayscale",
    "aegis-star-pulse",
    "needle-array-fire",
  ].flatMap((directory) => Array.from(
    { length: 9 },
    (_, index) => `${VIEWER_DEMO_PREFIX}/assets/weapons/generated-v1/${directory}/frame-${index}.png`,
  )),
]);

function dataUri(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

interface OverrideV1 {
  readonly schema: "vault-weapon-region-overrides@1";
  readonly size: readonly [number, number];
  readonly overrides: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
}

function inlineJsonFetch(source: string, endpoint: string, json: string): string {
  const escapedEndpoint = endpoint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `fetch\\("${escapedEndpoint}"\\)\\.then\\(\\(response\\) => (?:response\\.json\\(\\)|\\{[\\s\\S]*?return response\\.json\\(\\);?\\s*\\})\\)`,
    "u",
  );
  const output = source.replace(pattern, `Promise.resolve(${json})`);
  if (output === source) throw new Error(`Vault viewer bundle could not inline ${endpoint}`);
  return output;
}

export function compactWeaponOverrides(bytes: Uint8Array): Uint8Array {
  const source = JSON.parse(Buffer.from(bytes).toString("utf8")) as OverrideV1;
  const regions = [...new Set(Object.values(source.overrides).flatMap((frames) =>
    Object.values(frames).flatMap((pixels) => Object.values(pixels))))].sort();
  const regionIndex = new Map(regions.map((region, index) => [region, index + 1]));
  const overrides: Record<string, Record<string, string>> = {};
  for (const [weapon, frames] of Object.entries(source.overrides)) {
    overrides[weapon] = {};
    for (const [frame, pixels] of Object.entries(frames)) {
      const output: number[] = [];
      let previous = 0;
      for (const [pixelText, region] of Object.entries(pixels).sort(([left], [right]) => Number(left) - Number(right))) {
        const pixel = Number(pixelText);
        let delta = pixel - previous;
        previous = pixel;
        do {
          let byte = delta & 0x7f;
          delta >>>= 7;
          if (delta !== 0) byte |= 0x80;
          output.push(byte);
        } while (delta !== 0);
        output.push(regionIndex.get(region) ?? 0);
      }
      overrides[weapon][frame] = Buffer.from(output).toString("base64");
    }
  }
  return utf8ToBytes(JSON.stringify({ schema: "vault-weapon-region-overrides@2", size: source.size, regions, overrides }));
}

export async function buildVaultKeelViewer(demoRoot: string): Promise<Uint8Array> {
  const repositoryRoot = path.resolve(demoRoot, "../../../..");
  const [html, combatSource, inputSource, materialsSource, regionResolverSource, weaponMaterialSource, verificationSource, collectionVerificationSource, audioReaderSource, viewerSource, targetBytes, weaponAttributes, vaultGameAtlas, weaponLayouts, weaponOverrides, weaponSounds] = await Promise.all([
    readFile(path.join(demoRoot, "vault-keel-viewer.html"), "utf8"),
    readFile(path.join(demoRoot, "vault-combat-shared.mjs"), "utf8"),
    readFile(path.join(demoRoot, "vault-input-shared.mjs"), "utf8"),
    readFile(path.join(demoRoot, "orb-materials.mjs"), "utf8"),
    readFile(path.join(demoRoot, "weapon-region-resolver.js"), "utf8"),
    readFile(path.join(demoRoot, "weapon-material-runtime.mjs"), "utf8"),
    readFile(path.join(demoRoot, "vault-verification.js"), "utf8"),
    readFile(path.join(repositoryRoot, "packages/viewer/dist/collection-verification.js"), "utf8"),
    readFile(path.join(demoRoot, "keel-readers.js"), "utf8"),
    readFile(path.join(demoRoot, "vault-keel-viewer.js"), "utf8"),
    readFile(path.join(demoRoot, "orb-core-v1-attribute-targets.json")),
    readFile(path.join(demoRoot, "weapon-attributes-v1.json")),
    readFile(path.join(demoRoot, "vault-game-atlas-v1.json")),
    readFile(path.join(demoRoot, "weapon-region-layouts-v2.json")),
    readFile(path.join(demoRoot, "weapon-region-overrides-v1.json")),
    readFile(path.join(demoRoot, "weapon-sounds-v1.json")),
  ]);
  const asset = async (relativePath: string) => dataUri("image/png", new Uint8Array(await readFile(path.join(demoRoot, relativePath))));
  const compactOverrides = compactWeaponOverrides(new Uint8Array(weaponOverrides));
  const replacements: Readonly<Record<string, string>> = {
    "/content/orb-core.png": await asset("orb-core-v1-turnaround.png"),
    "/content/orb-material-mask.png": await asset("orb-core-v1-material-mask.png"),
    "/content/orb-panel-mask.png": await asset("orb-core-v1-panel-mask.png"),
    "/content/gyro-saw.png": await asset("assets/weapons/generated-v1/gyro-saw-96.png"),
    "/content/rift-fork.png": await asset("assets/weapons/generated-v1/rift-fork-96.png"),
    "/content/aegis-star.png": await asset("assets/weapons/generated-v1/aegis-star-96.png"),
    "/content/needle-array.png": await asset("assets/weapons/generated-v1/needle-array-96.png"),
    "/content/sound-gyro.ocas": dataUri("application/octet-stream", new Uint8Array(await readFile(path.join(demoRoot, "audio/gyro-saw-attack.ocas")))),
    "/content/sound-rift.ocas": dataUri("application/octet-stream", new Uint8Array(await readFile(path.join(demoRoot, "audio/rift-fork-attack.ocas")))),
    "/content/sound-bloom.ocas": dataUri("application/octet-stream", new Uint8Array(await readFile(path.join(demoRoot, "audio/aegis-star-attack.ocas")))),
    "/content/sound-needle.ocas": dataUri("application/octet-stream", new Uint8Array(await readFile(path.join(demoRoot, "audio/needle-array-attack.ocas")))),
    ...Object.fromEntries(await Promise.all([
      ["gyro", "gyro-saw-spin"],
      ["rift", "rift-fork-fire-grayscale"],
      ["bloom", "aegis-star-pulse"],
      ["needle", "needle-array-fire"],
    ].flatMap(([type, directory]) => Array.from({ length: 9 }, async (_, index) => [
      `/content/${type}-frame-${index}.png`,
      await asset(`assets/weapons/generated-v1/${directory}/frame-${index}.png`),
    ])))),
  };
  let viewer = viewerSource.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\/content\/orb-materials\.mjs";\s*/u, "");
  viewer = viewer.replace(/^import\s*\{\s*resolveWeaponRegion\s*\}\s*from\s*"\/content\/weapon-region-resolver\.js";\s*/mu, "");
  viewer = viewer.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\/content\/weapon-material-runtime\.mjs";\s*/mu, "");
  viewer = viewer.replace(/^import\s*\{\s*evaluateVaultVerification\s*\}\s*from\s*"\/content\/vault-verification\.js";\s*/mu, "");
  viewer = viewer.replace(/^import\s*\{\s*allowCollectionVerificationFixtureQuery,\s*evaluateCollectionVerification\s*\}\s*from\s*"\/content\/collection-verification\.js";\s*/mu, "");
  viewer = viewer.replace(/^import\s*\{\s*KEEL_SOUND_BITS_CODEC,\s*createAudioReader\s*\}\s*from\s*"\/content\/keel-readers\.js";\s*/mu, "");
  viewer = viewer.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\/content\/vault-combat-shared\.mjs";\s*/mu, "");
  viewer = viewer.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\/content\/vault-input-shared\.mjs";\s*/mu, "");
  viewer = viewer.replace(
    'fetch("/content/orb-targets.json").then((response) => response.json())',
    `Promise.resolve(${targetBytes.toString("utf8")})`,
  );
  viewer = inlineJsonFetch(viewer, "/content/weapon-attributes.json", weaponAttributes.toString("utf8"));
  viewer = inlineJsonFetch(viewer, "/content/vault-game-atlas.json", vaultGameAtlas.toString("utf8"));
  viewer = inlineJsonFetch(viewer, "/content/weapon-region-layouts.json", weaponLayouts.toString("utf8"));
  viewer = inlineJsonFetch(viewer, "/content/weapon-region-overrides.json", Buffer.from(compactOverrides).toString("utf8"));
  viewer = inlineJsonFetch(viewer, "/content/weapon-sounds.json", weaponSounds.toString("utf8"));
  for (const [source, uri] of Object.entries(replacements)) viewer = viewer.replaceAll(source, uri);
  const materials = materialsSource.replaceAll("export const ", "const ").replaceAll("export function ", "function ");
  const regionResolver = regionResolverSource.replaceAll("export const ", "const ").replaceAll("export function ", "function ");
  const weaponMaterial = weaponMaterialSource
    .replace(/^import\s*\{\s*resolveWeaponRegion\s*\}\s*from\s*"\.\/weapon-region-resolver\.js";\s*/mu, "")
    .replaceAll("export const ", "const ")
    .replaceAll("export function ", "function ");
  const verification = verificationSource.replaceAll("export const ", "const ").replaceAll("export function ", "function ");
  const collectionVerification = collectionVerificationSource.replaceAll("export function ", "function ");
  const audioReader = audioReaderSource.replaceAll("export const ", "const ").replaceAll("export function ", "function ");
  const combat = combatSource.replaceAll("export const ", "const ").replaceAll("export function ", "function ");
  const input = inputSource.replaceAll("export const ", "const ").replaceAll("export function ", "function ");
  const script = `<script type="module">${combat}\n${input}\n${materials}\n${regionResolver}\n${weaponMaterial}\n${verification}\n${collectionVerification}\n${audioReader}\n${viewer}</script>`;
  return utf8ToBytes(html.replace('<script type="module" src="/content/vault-viewer.js"></script>', script));
}

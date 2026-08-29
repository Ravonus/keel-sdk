import {
  createExternalModuleIndex,
  customExternalBrowserModule,
  defineModule,
  externalModuleIndexEntry,
  moduleApi,
  verifyExternalBrowserModuleOnchain,
  verifyExternalBrowserModuleFromStudio,
} from "../../packages/sdk/dist/module/index.js";

export const P5_DIGEST = "sha256:af51e6211e061b5ae463fbc5c3c1c272e5ca67fa560ed3513fde17325d837506";
export const SEED_DIGEST = "sha256:10726813a9a8f2f225ba172758df2c9afa8846aa40e594e243be836f1fe7ba5e";

function entry(id, version, digest, byteLength, objectId, store, chain) {
  return externalModuleIndexEntry(
    id, version, "keel.system", digest, byteLength, "text/javascript",
    objectId, store, chain, `${id}@${version}`, digest,
    undefined, undefined, "shared-library", "publisher-attested",
  );
}

/** Builds a publishable project only from exact Sepolia carrier bindings. */
function declarations(bindings) {
  const index = createExternalModuleIndex(
    entry("p5.js", "1.11.3", P5_DIGEST, 1_056_654, bindings.p5.objectId, bindings.p5.store, bindings.chain),
    entry("keel.seeded-random", "1.0.0", SEED_DIGEST, 1_198, bindings.seededRandom.objectId, bindings.seededRandom.store, bindings.chain),
  );
  const p5 = customExternalBrowserModule(index, "p5.js", "1.11.3", moduleApi(), "p5Runtime");
  const seededRandom = customExternalBrowserModule(index, "keel.seeded-random", "1.0.0", moduleApi(), "seed");
  return { p5, seededRandom };
}

function project(p5, seededRandom, chain) {
  return defineModule("Seed Current", {
    kind: "app",
    target: `@keel/eth/${chain}/browser`,
    extends: [p5.descriptor, seededRandom.descriptor],
    npm: { p5: "1.11.3" },
    verification: { shell: true },
  });
}

export async function createProject(bindings, endpoint, ...fallbackEndpoints) {
  const { p5, seededRandom } = declarations(bindings);
  await Promise.all([
    verifyExternalBrowserModuleOnchain(p5, endpoint, ...fallbackEndpoints),
    verifyExternalBrowserModuleOnchain(seededRandom, endpoint, ...fallbackEndpoints),
  ]);
  return project(p5, seededRandom, bindings.chain);
}

/** Verifies compressed carrier roots through Studio's exact object gateway. */
export async function createProjectFromStudio(bindings, studioUrl) {
  const { p5, seededRandom } = declarations(bindings);
  await Promise.all([
    verifyExternalBrowserModuleFromStudio(p5, studioUrl),
    verifyExternalBrowserModuleFromStudio(seededRandom, studioUrl),
  ]);
  return project(p5, seededRandom, bindings.chain);
}

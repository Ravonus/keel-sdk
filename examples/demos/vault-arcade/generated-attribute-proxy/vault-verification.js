const BYTES32 = /^0x[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const UINT256_MAX = (1n << 256n) - 1n;

const REQUIRED_RECIPE_FIELDS = Object.freeze([
  ["Token seed", "derivedTokenSeed", "bytes32"],
  ["Packed attributes", "packedAttributes", "bytes32"],
  ["Portable root", "portableRoot", "bytes32"],
  ["Manifest object", "portableManifestObjectId", "bytes32"],
  ["Decoded object", "portableDecodedObjectId", "bytes32"],
  ["Portable anchor", "portableAnchorRoot", "bytes32"],
  ["Manifest revision", "portableManifestObjectRevision", "revision"],
  ["Decoded revision", "portableDecodedObjectRevision", "revision"],
  ["Asset family", "assetFamilyId", "bytes32"],
  ["Asset ID", "assetId", "bytes32"],
  ["Sprite object", "spriteObjectId", "bytes32"],
  ["Target map object", "targetMapObjectId", "bytes32"],
  ["Effect profile object", "effectProfileObjectId", "bytes32"],
  ["Sound profile object", "soundProfileObjectId", "bytes32"],
  ["Catalog revision", "catalogRevision", "revision"],
  ["Asset family revision", "assetFamilyRevision", "revision"],
]);

const CHECK_GUIDE = Object.freeze({
  "runtime-verifier": {
    plain: "The proof screen is part of the Keel viewer that is doing the render.",
    impact: "This confirms the explanation comes from the viewer itself, not a separate label pasted on top.",
  },
  "object-pipeline": {
    plain: "The visible pieces are resolved through the viewer's committed Keel object graph.",
    impact: "Changing a committed object can change the picture, effects, sound, or metadata.",
  },
  "manifest-digest": {
    plain: "The exact viewer package is checked with a content hash.",
    impact: "A changed HTML, CSS, script, or bundled asset becomes a different viewer package.",
  },
  "anchor-verdict": {
    plain: "The package is connected to the registry record that approved it.",
    impact: "An unanchored package may look right but is not the package Keel committed to use.",
  },
  "manifest-revision": {
    plain: "The viewer version is explicit and pinned.",
    impact: "A later viewer revision cannot silently replace this one.",
  },
  "runtime-context": {
    plain: "The token data follows the versioned Keel context format.",
    impact: "A different or partial format is rejected instead of being guessed at.",
  },
  "chain-pin": {
    plain: "The render is tied to one chain, block number, and block hash.",
    impact: "Without all three, there is no reliable snapshot to compare with the token.",
  },
  "token-identity": {
    plain: "The token number is checked as a canonical uint256 value.",
    impact: "This prevents the viewer from quietly rendering a different token identity.",
  },
  "upgrade-pin": {
    plain: "The catalog and asset-family versions that selected this character are pinned.",
    impact: "Later catalog additions cannot reroll the character's selected parts.",
  },
  "map-pin": {
    plain: "If this character is used in a map, the map build and its portable objects are pinned too.",
    impact: "A map assignment cannot silently switch to a different build or seed.",
  },
});

function canonical(value, kind) {
  if (kind === "bytes32") return typeof value === "string" && BYTES32.test(value);
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalTokenId(value) {
  return typeof value === "string" && value.length <= 78 && DECIMAL.test(value) && BigInt(value) <= UINT256_MAX;
}

function check(id, label, passed, detail, severity = "fatal") {
  const guide = CHECK_GUIDE[id] ?? (id.startsWith("recipe-") ? {
    plain: `${label} is a committed part of the character recipe.`,
    impact: "A mismatch can change which object or version is rendered.",
  } : {});
  return Object.freeze({ id, label, passed: Boolean(passed), detail, severity, ...guide });
}

function applyTestFailure(checks, scenario) {
  const target = {
    manifest: "manifest-digest",
    anchor: "anchor-verdict",
    upgrade: "upgrade-pin",
    context: "runtime-context",
  }[scenario];
  if (target === undefined) return checks;
  return checks.map((item) => item.id === target
    ? check(item.id, item.label, false, `Intentional ${scenario} verification failure fixture.`, item.severity)
    : item);
}

export function evaluateVaultVerification(runtime, context, scenario) {
  if (runtime == null) {
    if (scenario !== undefined && scenario !== "") {
      const fixtureChecks = applyTestFailure([
        check("manifest-digest", "Manifest digest", true, "Fixture digest is canonical."),
        check("anchor-verdict", "Portable anchor", true, "Fixture anchor is present."),
        check("upgrade-pin", "Upgrade revision pin", true, "Fixture revision is pinned."),
        check("runtime-context", "Pinned runtime context", true, "Fixture context is complete."),
      ], scenario);
      return Object.freeze({
        state: "failed",
        title: "Verification failed",
        summary: fixtureChecks.find((item) => !item.passed)?.detail ?? "Intentional verification failure fixture.",
        checks: Object.freeze(fixtureChecks),
        proofTier: "Failure fixture",
        isFixture: true,
        proofMode: "rejected",
      });
    }
    return Object.freeze({
      state: "verified",
      title: "Keel runtime verified",
      summary: "Every rendered object was loaded through the bundled Keel runtime and its committed resource graph.",
      checks: Object.freeze([
        check("runtime-verifier", "Keel viewer runtime", true, "The verifier is embedded in the on-chain viewer runtime."),
        check("object-pipeline", "Committed object pipeline", true, "Sprites, masks, effects, sounds, and metadata are resolved only through the bundled Keel object graph."),
      ]),
      proofTier: "Keel runtime proof",
      isFixture: false,
      syntheticTokenContext: true,
      proofMode: "runtime-preview",
    });
  }

  const hasMapContext = [
    context?.mapCharacterSeed,
    context?.mapSeed,
    context?.mapBuildRevision,
    context?.mapPortableRoot,
    context?.mapPortableManifestObjectId,
    context?.mapPortableDecodedObjectId,
    context?.mapPortableAnchorRoot,
    context?.mapPortableManifestObjectRevision,
    context?.mapPortableDecodedObjectRevision,
  ].some((value) => value !== undefined);
  const completeMapContext = !hasMapContext || (
    BYTES32.test(context?.mapCharacterSeed ?? "")
    && BYTES32.test(context?.mapSeed ?? "")
    && Number.isSafeInteger(context?.mapBuildRevision)
    && context.mapBuildRevision > 0
    && BYTES32.test(context?.mapPortableRoot ?? "")
    && BYTES32.test(context?.mapPortableManifestObjectId ?? "")
    && BYTES32.test(context?.mapPortableDecodedObjectId ?? "")
    && BYTES32.test(context?.mapPortableAnchorRoot ?? "")
    && Number.isSafeInteger(context?.mapPortableManifestObjectRevision)
    && context.mapPortableManifestObjectRevision > 0
    && Number.isSafeInteger(context?.mapPortableDecodedObjectRevision)
    && context.mapPortableDecodedObjectRevision > 0
  );
  const checks = [
    check("manifest-digest", "Runtime manifest digest", typeof runtime.manifestDigest === "string" && BYTES32.test(runtime.manifestDigest), "The exact viewer manifest is content-addressed."),
    check("anchor-verdict", "Manifest registry anchor", runtime.anchorVerified === true, "The Keel resolver accepted the registry commitment at the pinned block."),
    check("manifest-revision", "Manifest revision", Number.isSafeInteger(runtime.revision) && runtime.revision > 0, "The viewer revision is explicit and immutable for this resolution."),
    check("runtime-context", "Pinned runtime context", context?.protocol === "keel-context@1", "Only the validated Keel context protocol is accepted."),
    check("chain-pin", "Chain and block pin", Number.isSafeInteger(context?.chainId) && context.chainId > 0 && typeof context?.blockNumber === "string" && DECIMAL.test(context.blockNumber) && typeof context?.blockHash === "string" && BYTES32.test(context.blockHash), "Chain ID, block height, and block hash must all be present."),
    check("token-identity", "Canonical token identity", canonicalTokenId(context?.tokenId), "The resolved token ID must be a canonical uint256 decimal string."),
    ...REQUIRED_RECIPE_FIELDS.map(([label, field, kind]) => check(`recipe-${field}`, label, canonical(context?.[field], kind), `Committed character recipe field: ${field}.`)),
    check("upgrade-pin", "Upgrade revision pin", Number.isSafeInteger(context?.catalogRevision) && context.catalogRevision > 0 && Number.isSafeInteger(context?.assetFamilyRevision) && context.assetFamilyRevision > 0, "Catalog and asset-family revisions are pinned so later appends cannot reroll this token."),
    check("map-pin", "Map execution context", completeMapContext, !hasMapContext ? "No map execution context was supplied." : "Map seed, character seed, build revision, portable root, manifest/decoded objects, anchor, and object revisions must all be pinned together."),
  ];
  const testedChecks = applyTestFailure(checks, scenario);
  const failures = testedChecks.filter((item) => !item.passed && item.severity === "fatal");
  if (failures.length > 0) return Object.freeze({
    state: "failed",
    title: "Verification failed",
    summary: failures.map((item) => item.label).join(", "),
    checks: Object.freeze(testedChecks),
    proofTier: "Rejected proof",
    isFixture: scenario !== undefined && scenario !== "",
    proofMode: "rejected",
  });
  return Object.freeze({
    state: "verified",
    title: "Verified at pinned block",
    summary: `Manifest, portable anchor, recipe, and revision pins agree at block ${context.blockNumber}.`,
    checks: Object.freeze(testedChecks),
    proofTier: "Keel client proof",
    isFixture: false,
    proofMode: "token-pinned",
  });
}

export const VAULT_VERIFICATION_FAILURE_FIXTURES = Object.freeze(["manifest", "anchor", "upgrade", "context"]);

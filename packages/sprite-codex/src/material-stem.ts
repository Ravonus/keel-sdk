import { canonicalJson, sha256 } from "./hash.js";

export const MATERIAL_STEM_SCHEMA = "oca-material-stem@1" as const;
export const MATERIAL_COMPOSITION_SCHEMA = "oca-material-composition@1" as const;
export const MATERIAL_TICKS_PER_SECOND = 60;
export const MATERIAL_STEM_LIMITS = Object.freeze({
  maxStems: 32,
  maxAutonomousStems: 2,
  maxFrames: 64,
  maxTicks: 3_600,
  maxSemanticTargets: 64,
  maxContributionsPerStem: 8,
  maxAssignments: 64,
  maxAdjacencies: 128,
  maxTransitions: 128,
});

const Q16 = 65_536;
const IDENTIFIER = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const LOWERCASE_DIGEST = /^[0-9a-f]{64}$/u;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length")?.get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

export type MaterialAlphaMode = "opaque-data" | "opaque-color" | "straight-alpha" | "premultiplied-alpha";
export type MaterialComponent = "r" | "g" | "b" | "a";
export type MaterialContributionDomain = "physical-surface" | "physical-film" | "optical-post";
export type MaterialBlendMode = "source-over" | "lighter" | "screen" | "multiply" | "overlay" | "soft-light";

export interface MaterialChannel {
  component: MaterialComponent;
  semantic: string;
  encoding: "unorm8";
  transfer: "linear" | "srgb";
}

export interface MaterialSpriteBinding {
  bundleId: number;
  bundleRevision: number;
  assetId: number;
  selectionRevision: number;
  frameIndices: number[];
  frameSha256: string[];
}

export interface MaterialProceduralBinding {
  kernelId: string;
  kernelRevision: number;
  parametersDigest: string;
}

export type MaterialStemSource =
  | { kind: "sprite"; sprite: MaterialSpriteBinding }
  | { kind: "procedural"; procedural: MaterialProceduralBinding }
  | { kind: "hybrid"; sprite: MaterialSpriteBinding; procedural: MaterialProceduralBinding };

export interface MaterialContribution {
  id: string;
  domain: MaterialContributionDomain;
  targetMode: "listed" | "inverse-listed";
  targets: string[];
  excludes: string[];
  polarity: "primary" | "counter";
  counterOf?: string;
  blendMode: MaterialBlendMode;
  opacityQ16: number;
}

export interface MaterialStemRecipe {
  schema: typeof MATERIAL_STEM_SCHEMA;
  stemId: string;
  revision: number;
  catalogRevision: number;
  seedDomainVersion: 1;
  source: MaterialStemSource;
  alphaMode: MaterialAlphaMode;
  alphaPolicy: {
    requireTransparentPixels: boolean;
    requirePartialPixels: boolean;
  };
  channels: MaterialChannel[];
  clock: {
    id: string;
    mode: "static" | "external" | "autonomous";
    controllerId?: string;
    ticksPerSecond: typeof MATERIAL_TICKS_PER_SECOND;
    durationTicks: number;
    playback: "once" | "loop" | "ping-pong";
    phaseOrigin: "start-tick" | "first-visible-tick";
    phaseJitterTicks: number;
    startTick: number;
    firstVisibleTick: number;
    frameTicks: number[];
    posterFrameIndex?: number;
  };
  contributions: MaterialContribution[];
}

export interface MaterialContributionRef {
  stemId: string;
  contributionId: string;
}

export interface MaterialRegionAssignment {
  id: string;
  regions: string[];
  contribution: MaterialContributionRef;
}

export interface MaterialAdjacency {
  id: string;
  leftAssignmentId: string;
  leftRegion: string;
  rightAssignmentId: string;
  rightRegion: string;
}

export interface MaterialTransitionEndpoint extends MaterialContributionRef {
  assignmentId: string;
}

export interface MaterialTransition {
  id: string;
  adjacencyId: string;
  left: MaterialTransitionEndpoint;
  right: MaterialTransitionEndpoint;
  methodId: string;
  methodRevision: number;
  parametersDigest: string;
  implementationDigest: string;
}

export interface MaterialComposition {
  schema: typeof MATERIAL_COMPOSITION_SCHEMA;
  revision: number;
  semanticTargets: string[];
  maximumAutonomousStems: 1 | 2;
  diagnosticPolicy: "preserve-selected-contributions";
  stems: MaterialStemRecipe[];
  materialRegions: string[];
  assignments: MaterialRegionAssignment[];
  adjacencies: MaterialAdjacency[];
  transitions: MaterialTransition[];
}

export interface MaterialStemSeedContext {
  tokenSeed: string;
  collectionId: string;
  tokenId: string | bigint;
}

export interface MaterialStemSample {
  stemId: string;
  revision: number;
  tick: number;
  localTick: number;
  phaseTicks: number;
  visible: boolean;
  frameIndex?: number;
  proceduralSeed?: string;
  routes: Array<MaterialContribution & { resolvedTargets: string[] }>;
}

export type MaterialStemSampleTime =
  | { mode: "poster" }
  | { mode: "live"; globalTick: number; externalTicks?: Readonly<Record<string, number>> };

function integer(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
}

function assertCanonicalJsonValue(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} contains a non-canonical JSON number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} contains a non-JSON value`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must use the current-realm Array prototype`);
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} contains a symbol property`);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
        throw new Error(`${label} contains a non-canonical array property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label} contains a hidden or accessor array property`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} contains a sparse array`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw new Error(`${label} contains an accessor array property`);
      assertCanonicalJsonValue(descriptor.value, `${label}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error(`${label} must contain only current-realm plain JSON objects`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label} contains a hidden or accessor property`);
    assertCanonicalJsonValue(descriptor.value, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function canonicalJsonSnapshot<T>(value: T, label: string): T {
  // The initial descriptor walk rejects ordinary accessors, inherited fields,
  // hidden properties, and non-JSON values. structuredClone additionally
  // rejects Proxy-backed graphs, then gives every later stage one concrete
  // value to validate and commit without re-reading caller-controlled state.
  assertCanonicalJsonValue(value, label);
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch (error) {
    throw new Error(`${label} must be concrete structured-cloneable JSON data`, { cause: error });
  }
  assertCanonicalJsonValue(snapshot, `${label} snapshot`);
  return snapshot as T;
}

function exactKeys(value: unknown, allowed: readonly string[], label: string, optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`${label} contains unknown property ${key}`);
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing own property ${key}`);
  }
}

function identifier(value: string, label: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is not a canonical identifier`);
}

function digest(value: string, label: string): void {
  if (!LOWERCASE_DIGEST.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest without a prefix`);
}

function uniqueIdentifiers(values: string[], label: string, minimum = 0, maximum = MATERIAL_STEM_LIMITS.maxSemanticTargets): void {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) throw new Error(`${label} has an invalid count`);
  const seen = new Set<string>();
  for (const value of values) {
    identifier(value, label);
    if (seen.has(value)) throw new Error(`${label} repeats ${value}`);
    seen.add(value);
  }
}

function validateSpriteBinding(sprite: MaterialSpriteBinding): void {
  exactKeys(sprite, ["bundleId", "bundleRevision", "assetId", "selectionRevision", "frameIndices", "frameSha256"], "material sprite binding");
  for (const [label, value] of [
    ["bundleId", sprite.bundleId],
    ["bundleRevision", sprite.bundleRevision],
    ["assetId", sprite.assetId],
    ["selectionRevision", sprite.selectionRevision],
  ] as const) integer(value, label, 1, 0xffff_ffff);
  if (
    !Array.isArray(sprite.frameIndices)
    || sprite.frameIndices.length === 0
    || sprite.frameIndices.length > MATERIAL_STEM_LIMITS.maxFrames
    || sprite.frameIndices.length !== sprite.frameSha256.length
  ) throw new Error("material sprite frame list is invalid");
  const indices = new Set<number>();
  sprite.frameIndices.forEach((frame, index) => {
    integer(frame, `frameIndices[${index}]`, 0, 0xffff);
    if (indices.has(frame)) throw new Error("material sprite frame indices must be unique");
    indices.add(frame);
    digest(sprite.frameSha256[index]!, `frameSha256[${index}]`);
  });
}

function validateProceduralBinding(procedural: MaterialProceduralBinding): void {
  exactKeys(procedural, ["kernelId", "kernelRevision", "parametersDigest"], "material procedural binding");
  identifier(procedural.kernelId, "kernelId");
  integer(procedural.kernelRevision, "kernelRevision", 1, 0xffff_ffff);
  digest(procedural.parametersDigest, "parametersDigest");
}

function validateChannels(recipe: MaterialStemRecipe): void {
  if (!Array.isArray(recipe.channels) || recipe.channels.length !== 4) throw new Error("material stems require exactly four RGBA channels");
  const components = new Set<MaterialComponent>();
  for (const channel of recipe.channels) {
    exactKeys(channel, ["component", "semantic", "encoding", "transfer"], "material channel");
    if (!["r", "g", "b", "a"].includes(channel.component)) throw new Error("material channel component is invalid");
    if (components.has(channel.component)) throw new Error(`material channel repeats component ${channel.component}`);
    components.add(channel.component);
    identifier(channel.semantic, "channel semantic");
    if (channel.encoding !== "unorm8" || !["linear", "srgb"].includes(channel.transfer)) throw new Error("material channel encoding is invalid");
  }
  const alpha = recipe.channels.find((channel) => channel.component === "a")!;
  if (recipe.alphaMode.startsWith("opaque-") && (alpha.semantic !== "opaque" || alpha.transfer !== "linear")) {
    throw new Error("opaque material sources require a linear opaque alpha channel");
  }
  if (recipe.alphaMode.endsWith("-alpha") && (alpha.semantic !== "alpha" || alpha.transfer !== "linear")) {
    throw new Error("transparent material sources require a linear alpha channel");
  }
  if (recipe.alphaMode === "opaque-data" && recipe.channels.some((channel) => channel.transfer !== "linear")) {
    throw new Error("opaque data channels must all use linear transfer");
  }
  if (recipe.alphaMode === "premultiplied-alpha" && recipe.channels.some((channel) => channel.transfer !== "linear")) {
    throw new Error("premultiplied material channels must all use linear transfer");
  }
  const alphaPolicy = recipe.alphaPolicy;
  if (alphaPolicy === undefined || typeof alphaPolicy.requireTransparentPixels !== "boolean" || typeof alphaPolicy.requirePartialPixels !== "boolean") {
    throw new Error("material alpha policy is invalid");
  }
  exactKeys(alphaPolicy, ["requireTransparentPixels", "requirePartialPixels"], "material alpha policy");
  if (recipe.alphaMode.startsWith("opaque-") && (alphaPolicy.requireTransparentPixels || alphaPolicy.requirePartialPixels)) {
    throw new Error("opaque material sources cannot require transparent alpha coverage");
  }
  if (recipe.alphaMode.endsWith("-alpha") && !alphaPolicy.requireTransparentPixels) {
    throw new Error("transparent material sources must require real transparent pixels");
  }
}

function validateMaterialStemRecipeData(recipe: MaterialStemRecipe): void {
  exactKeys(recipe, ["schema", "stemId", "revision", "catalogRevision", "seedDomainVersion", "source", "alphaMode", "alphaPolicy", "channels", "clock", "contributions"], "material stem recipe");
  if (recipe.schema !== MATERIAL_STEM_SCHEMA) throw new Error(`expected schema ${MATERIAL_STEM_SCHEMA}`);
  identifier(recipe.stemId, "stemId");
  integer(recipe.revision, "revision", 1, 0xffff_ffff);
  integer(recipe.catalogRevision, "catalogRevision", 1, 0xffff_ffff);
  if (recipe.seedDomainVersion !== 1) throw new Error("unsupported material stem seed domain");
  if (recipe.source === undefined || !["sprite", "procedural", "hybrid"].includes(recipe.source.kind)) throw new Error("material stem source is invalid");
  if (recipe.source.kind === "sprite") {
    exactKeys(recipe.source, ["kind", "sprite"], "sprite material source");
    validateSpriteBinding(recipe.source.sprite);
  } else if (recipe.source.kind === "procedural") {
    exactKeys(recipe.source, ["kind", "procedural"], "procedural material source");
    validateProceduralBinding(recipe.source.procedural);
  }
  else {
    exactKeys(recipe.source, ["kind", "sprite", "procedural"], "hybrid material source");
    validateSpriteBinding(recipe.source.sprite);
    validateProceduralBinding(recipe.source.procedural);
  }
  if (!["opaque-data", "opaque-color", "straight-alpha", "premultiplied-alpha"].includes(recipe.alphaMode)) throw new Error("material alpha mode is invalid");
  validateChannels(recipe);

  const clock = recipe.clock;
  if (clock === undefined) throw new Error("material stem clock is required");
  exactKeys(clock, ["id", "mode", "controllerId", "ticksPerSecond", "durationTicks", "playback", "phaseOrigin", "phaseJitterTicks", "startTick", "firstVisibleTick", "frameTicks", "posterFrameIndex"], "material stem clock", ["controllerId", "posterFrameIndex"]);
  identifier(clock.id, "clock.id");
  if (!["static", "external", "autonomous"].includes(clock.mode)) throw new Error("material clock mode is invalid");
  if (clock.mode === "external") {
    if (clock.controllerId === undefined) throw new Error("external material clocks require controllerId");
    identifier(clock.controllerId, "clock.controllerId");
  } else if (clock.controllerId !== undefined) throw new Error("only external material clocks may declare controllerId");
  if (clock.ticksPerSecond !== MATERIAL_TICKS_PER_SECOND) throw new Error(`material clocks must run at ${MATERIAL_TICKS_PER_SECOND} ticks per second`);
  integer(clock.durationTicks, "durationTicks", 1, MATERIAL_STEM_LIMITS.maxTicks);
  if (!["once", "loop", "ping-pong"].includes(clock.playback)) throw new Error("material clock playback is invalid");
  if (!["start-tick", "first-visible-tick"].includes(clock.phaseOrigin)) throw new Error("material clock phaseOrigin is invalid");
  integer(clock.phaseJitterTicks, "phaseJitterTicks", 0, clock.durationTicks - 1);
  if (clock.mode === "static" && clock.phaseJitterTicks !== 0) throw new Error("static material clocks cannot jitter phase");
  if (clock.phaseOrigin === "first-visible-tick" && clock.phaseJitterTicks !== 0) throw new Error("first-visible material clocks must begin at phase zero without jitter");
  integer(clock.startTick, "startTick", 0, MATERIAL_STEM_LIMITS.maxTicks);
  integer(clock.firstVisibleTick, "firstVisibleTick", clock.startTick, MATERIAL_STEM_LIMITS.maxTicks);
  if (!Array.isArray(clock.frameTicks)) throw new Error("material clock frameTicks must be an array");
  const sprite = recipe.source.kind === "procedural" ? undefined : recipe.source.sprite;
  if (sprite === undefined) {
    if (clock.frameTicks.length !== 0 || clock.posterFrameIndex !== undefined) throw new Error("procedural-only stems cannot declare sprite frames");
  } else {
    if (clock.frameTicks.length !== sprite.frameIndices.length) throw new Error("material frameTicks must match pinned sprite frames");
    clock.frameTicks.forEach((ticks, index) => integer(ticks, `frameTicks[${index}]`, 1, MATERIAL_STEM_LIMITS.maxTicks));
    if (clock.frameTicks.reduce((sum, ticks) => sum + ticks, 0) !== clock.durationTicks) throw new Error("material frameTicks must exactly fill durationTicks");
    if (clock.posterFrameIndex === undefined || !sprite.frameIndices.includes(clock.posterFrameIndex)) throw new Error("sprite material stems require a pinned poster frame");
  }

  if (!Array.isArray(recipe.contributions) || recipe.contributions.length === 0 || recipe.contributions.length > MATERIAL_STEM_LIMITS.maxContributionsPerStem) {
    throw new Error("material stem contribution count is invalid");
  }
  const contributions = new Map<string, MaterialContribution>();
  for (const contribution of recipe.contributions) {
    exactKeys(contribution, ["id", "domain", "targetMode", "targets", "excludes", "polarity", "counterOf", "blendMode", "opacityQ16"], "material contribution", ["counterOf"]);
    identifier(contribution.id, "contribution.id");
    if (contributions.has(contribution.id)) throw new Error(`material stem repeats contribution ${contribution.id}`);
    contributions.set(contribution.id, contribution);
    if (!["physical-surface", "physical-film", "optical-post"].includes(contribution.domain)) throw new Error("material contribution domain is invalid");
    if (!["listed", "inverse-listed"].includes(contribution.targetMode)) throw new Error("material contribution target mode is invalid");
    uniqueIdentifiers(contribution.targets, "contribution.targets", 1);
    uniqueIdentifiers(contribution.excludes, "contribution.excludes");
    if (contribution.targets.some((target) => contribution.excludes.includes(target))) throw new Error("material contribution cannot target and exclude the same semantic layer");
    if (!["primary", "counter"].includes(contribution.polarity)) throw new Error("material contribution polarity is invalid");
    if (!["source-over", "lighter", "screen", "multiply", "overlay", "soft-light"].includes(contribution.blendMode)) throw new Error("material contribution blend mode is invalid");
    integer(contribution.opacityQ16, "opacityQ16", 1, Q16);
    if (contribution.polarity === "primary" && contribution.counterOf !== undefined) throw new Error("primary material contributions cannot counter another contribution");
    if (contribution.polarity === "counter" && contribution.counterOf === undefined) throw new Error("counter material contributions must name their primary contribution");
  }
  for (const contribution of recipe.contributions) {
    if (contribution.polarity !== "counter") continue;
    const primary = contributions.get(contribution.counterOf!);
    if (primary === undefined || primary.polarity !== "primary") throw new Error(`counter contribution ${contribution.id} references a missing primary`);
  }
}

function materialStemRecipeSnapshot(value: unknown): MaterialStemRecipe {
  if (value === null || typeof value !== "object") throw new Error("material stem recipe must be an object");
  const recipe = canonicalJsonSnapshot(value, "material stem recipe") as MaterialStemRecipe;
  validateMaterialStemRecipeData(recipe);
  return recipe;
}

export function validateMaterialStemRecipe(value: unknown): asserts value is MaterialStemRecipe {
  materialStemRecipeSnapshot(value);
}

function resolveMaterialContributionData(contribution: MaterialContribution, semanticTargets: readonly string[]): string[] {
  uniqueIdentifiers([...semanticTargets], "semanticTargets", 1);
  const available = new Set(semanticTargets);
  for (const target of [...contribution.targets, ...contribution.excludes]) {
    if (!available.has(target)) throw new Error(`material contribution references unavailable semantic target ${target}`);
  }
  const selected = contribution.targetMode === "listed"
    ? semanticTargets.filter((target) => contribution.targets.includes(target))
    : semanticTargets.filter((target) => !contribution.targets.includes(target));
  const resolved = selected.filter((target) => !contribution.excludes.includes(target));
  if (resolved.length === 0) throw new Error(`material contribution ${contribution.id} resolves to no semantic targets`);
  return resolved;
}

export function resolveMaterialContribution(contribution: MaterialContribution, semanticTargets: readonly string[]): string[] {
  const stableContribution = canonicalJsonSnapshot(contribution, "material contribution");
  const stableSemanticTargets = canonicalJsonSnapshot(semanticTargets, "semantic targets");
  return resolveMaterialContributionData(stableContribution, stableSemanticTargets);
}

function validateMaterialCompositionData(composition: MaterialComposition): void {
  exactKeys(composition, ["schema", "revision", "semanticTargets", "maximumAutonomousStems", "diagnosticPolicy", "stems", "materialRegions", "assignments", "adjacencies", "transitions"], "material composition");
  if (composition.schema !== MATERIAL_COMPOSITION_SCHEMA) throw new Error(`expected schema ${MATERIAL_COMPOSITION_SCHEMA}`);
  integer(composition.revision, "composition.revision", 1, 0xffff_ffff);
  uniqueIdentifiers(composition.semanticTargets, "semanticTargets", 1);
  uniqueIdentifiers(composition.materialRegions, "materialRegions", 1);
  const semanticTargetSet = new Set(composition.semanticTargets);
  for (const region of composition.materialRegions) if (!semanticTargetSet.has(region)) throw new Error(`material region ${region} is not a semantic target`);
  if (![1, 2].includes(composition.maximumAutonomousStems)) throw new Error("maximumAutonomousStems must be 1 or 2");
  if (composition.diagnosticPolicy !== "preserve-selected-contributions") throw new Error("diagnostics may not disable selected material contributions");
  if (!Array.isArray(composition.stems) || composition.stems.length === 0 || composition.stems.length > MATERIAL_STEM_LIMITS.maxStems) throw new Error("material composition stem count is invalid");
  const stems = new Map<string, MaterialStemRecipe>();
  const contribution = (reference: MaterialContributionRef, label: string): MaterialContribution => {
    exactKeys(reference, ["stemId", "contributionId"], label);
    identifier(reference.stemId, `${label}.stemId`);
    identifier(reference.contributionId, `${label}.contributionId`);
    const stem = stems.get(reference.stemId);
    const selected = stem?.contributions.find((entry) => entry.id === reference.contributionId);
    if (selected === undefined) throw new Error(`${label} references missing contribution ${reference.stemId}/${reference.contributionId}`);
    return selected;
  };
  let autonomous = 0;
  for (const stem of composition.stems) {
    validateMaterialStemRecipeData(stem);
    if (stems.has(stem.stemId)) throw new Error(`material composition repeats stem ${stem.stemId}`);
    stems.set(stem.stemId, stem);
    if (stem.clock.mode === "autonomous") autonomous += 1;
    const resolved = new Map(stem.contributions.map((contribution) => [
      contribution.id,
      resolveMaterialContributionData(contribution, composition.semanticTargets),
    ]));
    for (const contribution of stem.contributions) {
      if (contribution.polarity !== "counter") continue;
      const primary = resolved.get(contribution.counterOf!)!;
      const counter = resolved.get(contribution.id)!;
      const overlap = counter.filter((target) => primary.includes(target));
      if (overlap.length !== 0) throw new Error(`counter contribution ${contribution.id} overlaps ${contribution.counterOf} on ${overlap.join(",")}`);
    }
  }
  if (autonomous > composition.maximumAutonomousStems || autonomous > MATERIAL_STEM_LIMITS.maxAutonomousStems) {
    throw new Error(`material composition has ${autonomous} autonomous stems; maximum is ${composition.maximumAutonomousStems}`);
  }

  if (!Array.isArray(composition.assignments) || composition.assignments.length === 0 || composition.assignments.length > MATERIAL_STEM_LIMITS.maxAssignments) {
    throw new Error("material assignment count is invalid");
  }
  const materialRegionSet = new Set(composition.materialRegions);
  const assignedRegions = new Set<string>();
  const regionsByContribution = new Map<string, Set<string>>();
  const contributionKey = (reference: MaterialContributionRef): string => `${reference.stemId}\0${reference.contributionId}`;
  const assignments = new Map<string, MaterialRegionAssignment>();
  for (const assignment of composition.assignments) {
    exactKeys(assignment, ["id", "regions", "contribution"], "material assignment");
    identifier(assignment.id, "material assignment id");
    if (assignments.has(assignment.id)) throw new Error(`material composition repeats assignment ${assignment.id}`);
    uniqueIdentifiers(assignment.regions, `assignment ${assignment.id} regions`, 1);
    const selected = contribution(assignment.contribution, `assignment ${assignment.id} contribution`);
    if (selected.polarity !== "primary" || selected.domain === "optical-post") {
      throw new Error(`assignment ${assignment.id} must reference a primary physical contribution`);
    }
    const resolved = resolveMaterialContributionData(selected, composition.semanticTargets);
    for (const region of assignment.regions) {
      if (!materialRegionSet.has(region)) throw new Error(`assignment ${assignment.id} references undeclared material region ${region}`);
      if (!resolved.includes(region)) throw new Error(`assignment ${assignment.id} contribution does not route to ${region}`);
      if (assignedRegions.has(region)) throw new Error(`material region ${region} is assigned more than once`);
      assignedRegions.add(region);
      const key = contributionKey(assignment.contribution);
      const regions = regionsByContribution.get(key) ?? new Set<string>();
      regions.add(region);
      regionsByContribution.set(key, regions);
    }
    assignments.set(assignment.id, assignment);
  }
  for (const region of composition.materialRegions) if (!assignedRegions.has(region)) throw new Error(`material region ${region} has no assignment`);
  for (const stem of composition.stems) {
    for (const selected of stem.contributions) {
      if (selected.polarity !== "primary" || selected.domain === "optical-post") continue;
      const resolvedMaterialRegions = resolveMaterialContributionData(selected, composition.semanticTargets).filter((target) => materialRegionSet.has(target));
      const declaredRegions = regionsByContribution.get(contributionKey({ stemId: stem.stemId, contributionId: selected.id })) ?? new Set<string>();
      if (
        resolvedMaterialRegions.length !== declaredRegions.size
        || resolvedMaterialRegions.some((region) => !declaredRegions.has(region))
      ) {
        throw new Error(`physical contribution ${stem.stemId}/${selected.id} material-region route differs from its assignments`);
      }
    }
  }

  if (!Array.isArray(composition.adjacencies) || composition.adjacencies.length > MATERIAL_STEM_LIMITS.maxAdjacencies) throw new Error("material adjacency count is invalid");
  const adjacencies = new Map<string, MaterialAdjacency>();
  const adjacencyRegionPairs = new Set<string>();
  for (const adjacency of composition.adjacencies) {
    exactKeys(adjacency, ["id", "leftAssignmentId", "leftRegion", "rightAssignmentId", "rightRegion"], "material adjacency");
    identifier(adjacency.id, "material adjacency id");
    identifier(adjacency.leftAssignmentId, "material adjacency leftAssignmentId");
    identifier(adjacency.rightAssignmentId, "material adjacency rightAssignmentId");
    identifier(adjacency.leftRegion, "material adjacency leftRegion");
    identifier(adjacency.rightRegion, "material adjacency rightRegion");
    if (adjacencies.has(adjacency.id)) throw new Error(`material composition repeats adjacency ${adjacency.id}`);
    if (adjacency.leftAssignmentId === adjacency.rightAssignmentId) throw new Error(`adjacency ${adjacency.id} must join distinct assignments`);
    const left = assignments.get(adjacency.leftAssignmentId);
    const right = assignments.get(adjacency.rightAssignmentId);
    if (left === undefined || !left.regions.includes(adjacency.leftRegion)) throw new Error(`adjacency ${adjacency.id} has an invalid left assignment region`);
    if (right === undefined || !right.regions.includes(adjacency.rightRegion)) throw new Error(`adjacency ${adjacency.id} has an invalid right assignment region`);
    if (adjacency.leftRegion === adjacency.rightRegion) throw new Error(`adjacency ${adjacency.id} must join distinct regions`);
    const regionPair = [adjacency.leftRegion, adjacency.rightRegion].sort().join("\0");
    if (adjacencyRegionPairs.has(regionPair)) throw new Error(`material adjacency repeats region boundary ${adjacency.leftRegion}/${adjacency.rightRegion}`);
    adjacencyRegionPairs.add(regionPair);
    adjacencies.set(adjacency.id, adjacency);
  }

  if (!Array.isArray(composition.transitions) || composition.transitions.length !== composition.adjacencies.length || composition.transitions.length > MATERIAL_STEM_LIMITS.maxTransitions) {
    throw new Error("every material adjacency requires exactly one transition");
  }
  const transitions = new Set<string>();
  const transitionIds = new Set<string>();
  const sameReference = (left: MaterialContributionRef, right: MaterialContributionRef): boolean => left.stemId === right.stemId && left.contributionId === right.contributionId;
  for (const transition of composition.transitions) {
    exactKeys(transition, ["id", "adjacencyId", "left", "right", "methodId", "methodRevision", "parametersDigest", "implementationDigest"], "material transition");
    identifier(transition.id, "material transition id");
    identifier(transition.adjacencyId, "material transition adjacencyId");
    if (transitionIds.has(transition.id)) throw new Error(`material composition repeats transition ${transition.id}`);
    if (transitions.has(transition.adjacencyId)) throw new Error(`material adjacency ${transition.adjacencyId} has more than one transition`);
    const adjacency = adjacencies.get(transition.adjacencyId);
    if (adjacency === undefined) throw new Error(`transition ${transition.id} references missing adjacency ${transition.adjacencyId}`);
    exactKeys(transition.left, ["assignmentId", "stemId", "contributionId"], `transition ${transition.id} left endpoint`);
    exactKeys(transition.right, ["assignmentId", "stemId", "contributionId"], `transition ${transition.id} right endpoint`);
    if (transition.left.assignmentId !== adjacency.leftAssignmentId || transition.right.assignmentId !== adjacency.rightAssignmentId) {
      throw new Error(`transition ${transition.id} endpoints do not match adjacency orientation`);
    }
    const leftAssignment = assignments.get(transition.left.assignmentId)!;
    const rightAssignment = assignments.get(transition.right.assignmentId)!;
    contribution({ stemId: transition.left.stemId, contributionId: transition.left.contributionId }, `transition ${transition.id} left endpoint`);
    contribution({ stemId: transition.right.stemId, contributionId: transition.right.contributionId }, `transition ${transition.id} right endpoint`);
    if (!sameReference(transition.left, leftAssignment.contribution) || !sameReference(transition.right, rightAssignment.contribution)) {
      throw new Error(`transition ${transition.id} endpoints do not match their assignments`);
    }
    if (sameReference(transition.left, transition.right)) throw new Error(`transition ${transition.id} must join distinct contribution endpoints`);
    identifier(transition.methodId, "material transition methodId");
    integer(transition.methodRevision, "material transition methodRevision", 1, 0xffff_ffff);
    digest(transition.parametersDigest, "material transition parametersDigest");
    digest(transition.implementationDigest, "material transition implementationDigest");
    transitionIds.add(transition.id);
    transitions.add(transition.adjacencyId);
  }
  for (const adjacency of composition.adjacencies) if (!transitions.has(adjacency.id)) throw new Error(`material adjacency ${adjacency.id} has no transition`);
}

function materialCompositionSnapshot(value: unknown): MaterialComposition {
  if (value === null || typeof value !== "object") throw new Error("material composition must be an object");
  const composition = canonicalJsonSnapshot(value, "material composition") as MaterialComposition;
  validateMaterialCompositionData(composition);
  return composition;
}

export function validateMaterialComposition(value: unknown): asserts value is MaterialComposition {
  materialCompositionSnapshot(value);
}

function bytes32(value: string, label: string): Uint8Array {
  const clean = value.replace(/^0x/u, "");
  if (!LOWERCASE_DIGEST.test(clean)) throw new Error(`${label} must be lowercase bytes32`);
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
}

function u32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function u256be(value: string | bigint): Uint8Array {
  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new Error("tokenId must be a uint256");
  }
  if (parsed < 0n || parsed >= (1n << 256n)) throw new Error("tokenId must be a uint256");
  const output = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(parsed & 0xffn);
    parsed >>= 8n;
  }
  return output;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function materialStemDigest(recipe: MaterialStemRecipe): Promise<string> {
  const stableRecipe = materialStemRecipeSnapshot(recipe);
  return sha256(new TextEncoder().encode(canonicalJson(stableRecipe)));
}

export async function materialCompositionDigest(composition: MaterialComposition): Promise<string> {
  const stableComposition = materialCompositionSnapshot(composition);
  return sha256(new TextEncoder().encode(canonicalJson(stableComposition)));
}

export async function deriveMaterialStemSeed(recipe: MaterialStemRecipe, context: MaterialStemSeedContext): Promise<Uint8Array> {
  const stableRecipe = materialStemRecipeSnapshot(recipe);
  const stemId = stableRecipe.stemId;
  const revision = stableRecipe.revision;
  const catalogRevision = stableRecipe.catalogRevision;
  if (context === null || typeof context !== "object" || Array.isArray(context)) throw new Error("material stem seed context must be an object");
  const contextPrototype = Object.getPrototypeOf(context);
  if (contextPrototype !== null && contextPrototype !== Object.prototype) throw new Error("material stem seed context must be a current-realm plain object");
  exactKeys(context, ["tokenSeed", "collectionId", "tokenId"], "material stem seed context");
  for (const key of ["tokenSeed", "collectionId", "tokenId"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`material stem seed context ${key} must be an own enumerable data property`);
  }
  let stableContext: MaterialStemSeedContext;
  try {
    stableContext = structuredClone(context);
  } catch (error) {
    throw new Error("material stem seed context must be concrete structured-cloneable data", { cause: error });
  }
  exactKeys(stableContext, ["tokenSeed", "collectionId", "tokenId"], "material stem seed context snapshot");
  const tokenSeed = bytes32(stableContext.tokenSeed, "tokenSeed");
  const collectionId = bytes32(stableContext.collectionId, "collectionId");
  const tokenId = u256be(stableContext.tokenId);
  const revisionBytes = u32be(revision);
  const catalogRevisionBytes = u32be(catalogRevision);
  const stemIdDigest = await sha256(new TextEncoder().encode(stemId));
  return bytes32(await sha256(join([
    new TextEncoder().encode("oca.material-stem.v1"),
    tokenSeed,
    collectionId,
    tokenId,
    bytes32(stemIdDigest, "stemIdDigest"),
    revisionBytes,
    catalogRevisionBytes,
  ])), "materialStemSeed");
}

export interface MaterialPixelInspection {
  pixelCount: number;
  transparentPixelCount: number;
  partialPixelCount: number;
  opaquePixelCount: number;
  premultiplicationViolationCount: number;
}

function byteArrayLength(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || TYPED_ARRAY_TAG === undefined || TYPED_ARRAY_LENGTH === undefined || TYPED_ARRAY_BYTE_LENGTH === undefined) return undefined;
  try {
    const tag = Reflect.apply(TYPED_ARRAY_TAG, value, []) as unknown;
    const length = Reflect.apply(TYPED_ARRAY_LENGTH, value, []) as unknown;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as unknown;
    if ((tag !== "Uint8Array" && tag !== "Uint8ClampedArray") || typeof length !== "number" || byteLength !== length) return undefined;
    return length;
  } catch {
    return undefined;
  }
}

function stableBytes(value: unknown, expectedLength?: number): Uint8Array | undefined {
  const length = byteArrayLength(value);
  if (length === undefined || (expectedLength !== undefined && length !== expectedLength)) return undefined;
  const source = value as Uint8Array | Uint8ClampedArray;
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const byte = source[index];
    if (!Number.isInteger(byte) || byte! < 0 || byte! > 255) return undefined;
    output[index] = byte!;
  }
  return output;
}

export function inspectMaterialPixels(recipe: MaterialStemRecipe, pixels: unknown): MaterialPixelInspection {
  const stableRecipe = materialStemRecipeSnapshot(recipe);
  const bytes = stableBytes(pixels);
  if (bytes === undefined) throw new Error("material pixels must be byte-backed Uint8Array or Uint8ClampedArray values");
  if (bytes.length === 0 || bytes.length % 4 !== 0) throw new Error("material pixels must be non-empty RGBA bytes");
  let transparentPixelCount = 0;
  let partialPixelCount = 0;
  let opaquePixelCount = 0;
  let premultiplicationViolationCount = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const alpha = bytes[offset + 3]!;
    if (alpha === 0) transparentPixelCount += 1;
    else if (alpha === 255) opaquePixelCount += 1;
    else partialPixelCount += 1;
    if (stableRecipe.alphaMode === "premultiplied-alpha" && (bytes[offset]! > alpha || bytes[offset + 1]! > alpha || bytes[offset + 2]! > alpha)) {
      premultiplicationViolationCount += 1;
    }
  }
  if (stableRecipe.alphaMode.startsWith("opaque-") && opaquePixelCount * 4 !== bytes.length) throw new Error("opaque material source contains non-opaque pixels");
  if (stableRecipe.alphaPolicy.requireTransparentPixels && transparentPixelCount === 0) throw new Error("material source has no real transparent pixels");
  if (stableRecipe.alphaPolicy.requirePartialPixels && partialPixelCount === 0) throw new Error("material source has no partially transparent pixels");
  if (premultiplicationViolationCount !== 0) throw new Error(`material source has ${premultiplicationViolationCount} premultiplied-alpha violations`);
  return { pixelCount: bytes.length / 4, transparentPixelCount, partialPixelCount, opaquePixelCount, premultiplicationViolationCount };
}

function animationFrame(recipe: MaterialStemRecipe, tick: number, phaseTicks: number): number | undefined {
  const sprite = recipe.source.kind === "procedural" ? undefined : recipe.source.sprite;
  if (sprite === undefined) return undefined;
  let local = tick + phaseTicks;
  const durations = recipe.clock.frameTicks;
  const total = recipe.clock.durationTicks;
  if (recipe.clock.playback === "loop") local %= total;
  else if (recipe.clock.playback === "ping-pong") {
    const reverseIndices = Array.from({ length: Math.max(0, durations.length - 2) }, (_, offset) => durations.length - 2 - offset);
    const span = total + reverseIndices.reduce((sum, index) => sum + durations[index]!, 0);
    local %= Math.max(1, span);
    if (local >= total) {
      local -= total;
      for (const index of reverseIndices) {
        const duration = durations[index]!;
        if (local < duration) return sprite.frameIndices[index]!;
        local -= duration;
      }
      return sprite.frameIndices[0]!;
    }
  } else local = Math.min(local, total - 1);
  let boundary = 0;
  for (let index = 0; index < durations.length; index += 1) {
    boundary += durations[index]!;
    if (local < boundary) return sprite.frameIndices[index]!;
  }
  return sprite.frameIndices.at(-1)!;
}

export function sampleMaterialStem(
  recipe: MaterialStemRecipe,
  eventSeed: Uint8Array,
  semanticTargets: readonly string[],
  time: MaterialStemSampleTime,
): MaterialStemSample {
  const stableRecipe = materialStemRecipeSnapshot(recipe);
  const stableEventSeed = stableBytes(eventSeed, 32);
  if (stableEventSeed === undefined) throw new Error("material stem seed must be 32 bytes");
  const stableSemanticTargets = canonicalJsonSnapshot(semanticTargets, "semantic targets");
  const stableTime = canonicalJsonSnapshot(time, "material stem sample time");
  exactKeys(stableTime, stableTime.mode === "poster" ? ["mode"] : ["mode", "globalTick", "externalTicks"], "material stem sample time", stableTime.mode === "poster" ? [] : ["externalTicks"]);
  if (stableTime.mode !== "poster" && stableTime.mode !== "live") throw new Error("material stem sample time mode is invalid");
  const poster = stableTime.mode === "poster";
  let tick = 0;
  if (!poster) {
    integer(stableTime.globalTick, "material stem global tick", 0, 0xffff_ffff);
    if (stableRecipe.clock.mode === "external") {
      const controllerId = stableRecipe.clock.controllerId!;
      const externalTick = stableTime.externalTicks?.[controllerId];
      if (externalTick === undefined) throw new Error(`external material clock ${controllerId} requires an explicit tick`);
      integer(externalTick, `external material clock ${controllerId} tick`, 0, 0xffff_ffff);
      tick = externalTick;
    } else tick = stableTime.globalTick;
  }
  integer(tick, "material stem tick", 0, 0xffff_ffff);
  const phaseWord = stableEventSeed[0]! * 0x100 + stableEventSeed[1]!;
  const phaseTicks = poster || stableRecipe.clock.mode === "static" || stableRecipe.clock.phaseJitterTicks === 0 ? 0 : phaseWord % (stableRecipe.clock.phaseJitterTicks + 1);
  const phaseOrigin = stableRecipe.clock.phaseOrigin === "first-visible-tick" ? stableRecipe.clock.firstVisibleTick : stableRecipe.clock.startTick;
  const localTick = poster || stableRecipe.clock.mode === "static" ? 0 : Math.max(0, tick - phaseOrigin);
  const visible = poster || tick >= stableRecipe.clock.firstVisibleTick;
  const frameIndex = poster || stableRecipe.clock.mode === "static" ? stableRecipe.clock.posterFrameIndex : animationFrame(stableRecipe, localTick, phaseTicks);
  const proceduralSeed = stableRecipe.source.kind === "sprite" ? undefined : hex(stableEventSeed);
  return {
    stemId: stableRecipe.stemId,
    revision: stableRecipe.revision,
    tick,
    localTick,
    phaseTicks,
    visible,
    ...(frameIndex === undefined ? {} : { frameIndex }),
    ...(proceduralSeed === undefined ? {} : { proceduralSeed }),
    routes: stableRecipe.contributions.map((contribution) => ({
      ...contribution,
      resolvedTargets: resolveMaterialContributionData(contribution, stableSemanticTargets),
    })),
  };
}

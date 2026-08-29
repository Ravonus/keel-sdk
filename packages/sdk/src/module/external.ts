import { createKeelRpcClient, type KeelRpcClient } from "@keel/protocol";
import { bindBrowserModuleDescriptor, browserModule, markBrowserModuleDescriptorVerified, moduleApi, type BrowserModuleDescriptor, type ModuleApiShape } from "./descriptor.js";

/** A local module index records provenance. It is never an endorsement. */
export type ExternalModuleProvenance = "publisher-attested" | "unverified";

/**
 * `review-registry-observed` means this SDK performed the four required
 * read-only calls against the named registry at one canonical block. It is
 * intentionally not named `keel-verified`: this package has no pinned public
 * deployment authority yet, so a caller-selected registry address cannot
 * self-brand as the canonical Keel authority.
 */
export type ExternalModuleVerification = ExternalModuleProvenance | "review-registry-observed";
export type ExternalModuleIsolation = "shared-library" | "sandbox" | "side-effect";

export interface ExternalModuleOutput {
  readonly moduleId: string;
  readonly version: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface KeelCarrierBinding {
  readonly moduleId: string;
  readonly version: string;
  readonly digest: string;
  readonly objectId: string;
  readonly store: string;
  readonly chain: string;
}

/** Reproducible-build provenance, distinct from an on-chain review. */
export interface ExternalModuleSourceReceipt {
  readonly id: string;
  readonly digest: string;
}

/** The exact immutable review record an index entry expects, if any. */
export interface ExternalModuleReviewReference {
  readonly specDigest: string;
  readonly reviewDigest: string;
}

export interface ExternalModuleIndexEntry {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly output: ExternalModuleOutput;
  readonly carrier: KeelCarrierBinding;
  readonly sourceReceipt: ExternalModuleSourceReceipt;
  readonly review?: ExternalModuleReviewReference;
  readonly dependencies: readonly string[];
  readonly isolation: ExternalModuleIsolation;
  readonly provenance: ExternalModuleProvenance;
}

export interface LocalProvenanceOnly {
  readonly kind: "provenance-only";
}

/**
 * The precise observation boundary behind a reviewed module. A registry read
 * is evidence from this named chain/contract/block; it is not a package-root
 * endorsement or a substitute for byte verification at execution time.
 */
export interface ReviewRegistryObservationBoundary {
  readonly kind: "keel-module-review-registry";
  readonly trustBoundary: "governed-rpc-read-at-canonical-block";
  readonly chain: string;
  readonly registry: string;
  readonly blockHash: string;
  readonly specDigest: string;
  readonly reviewDigest: string;
}

export type ExternalModuleReviewState = LocalProvenanceOnly | ReviewRegistryObservationBoundary;

export interface ExternalModuleSearchResult {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly objectId: string;
  readonly digest: string;
  readonly carrier: KeelCarrierBinding;
  readonly sourceReceipt: ExternalModuleSourceReceipt;
  readonly dependencies: readonly string[];
  readonly isolation: ExternalModuleIsolation;
  readonly verification: ExternalModuleVerification;
  readonly review: ExternalModuleReviewState;
}

/**
 * Opaque, immutable filter. Build it with `externalModuleQuery`; plain objects
 * and Proxies are rejected without property inspection.
 */
export interface ExternalModuleQuery {
  readonly id?: string;
  readonly version?: string;
  readonly publisher?: string;
  readonly isolation?: ExternalModuleIsolation;
  readonly verification?: ExternalModuleVerification;
  readonly text?: string;
}

export interface ExternalModuleIndex {
  readonly entries: readonly ExternalModuleIndexEntry[];
  readonly results: readonly ExternalModuleSearchResult[];
}

/** Opaque reader whose transport is built by this SDK, not supplied as a callback. */
export interface KeelModuleReviewRegistryReader {
  readonly chain: string;
  readonly registry: string;
}

/** Opaque result of a four-call pinned-block registry observation. */
export interface KeelModuleReviewRegistryObservation {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly objectId: string;
  readonly review: ReviewRegistryObservationBoundary;
}

export interface ExternalBrowserModuleDeclaration<Api, Verification extends ExternalModuleVerification> {
  /** Pass this descriptor to `defineModule({ extends: [...] })`. */
  readonly descriptor: BrowserModuleDescriptor<string, string, Api>;
  /** Immutable resolution/binding record to retain with the declaration. */
  readonly module: ExternalModuleSearchResult & { readonly verification: Verification };
}

interface ExternalModuleIndexState {
  readonly entries: readonly ExternalModuleIndexEntry[];
  readonly observations: ReadonlyMap<string, ReviewRegistryObservationBoundary>;
}

interface ReviewRegistryReaderState {
  readonly chainId: number;
  readonly registry: string;
  readonly client: KeelRpcClient;
}

interface ReviewRegistryObservationState {
  readonly entryKey: string;
  readonly boundary: ReviewRegistryObservationBoundary;
}

const ENTRY = new WeakSet<object>();
const INDEX = new WeakMap<object, ExternalModuleIndexState>();
const QUERY = new WeakMap<object, ExternalModuleQuery>();
const READER = new WeakMap<object, ReviewRegistryReaderState>();
const OBSERVATION = new WeakMap<object, ReviewRegistryObservationState>();
const RESULT_OUTPUT = new WeakMap<object, ExternalModuleOutput>();
const DECLARATION = new WeakMap<object, { readonly descriptor: BrowserModuleDescriptor; readonly result: ExternalModuleSearchResult; readonly output: ExternalModuleOutput }>();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BYTES32 = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ISOLATIONS = new Set<ExternalModuleIsolation>(["shared-library", "sandbox", "side-effect"]);
const PROVENANCE = new Set<ExternalModuleProvenance>(["publisher-attested", "unverified"]);
const REVIEW_REGISTRY_SELECTORS = Object.freeze({
  moduleAuthorized: "0xedb960c2",
  bindingsMatch: "0x76e89920",
  submission: "0x24ce1c3f",
  review: "0x9028d8b0",
});

/** ECMAScript relational string order: deterministic UTF-16 code-unit order. */
function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || CONTROL.test(value)) {
    throw new TypeError(`${label} must be a nonempty trimmed string without control characters.`);
  }
  return value;
}

function semver(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SEMVER.test(result)) throw new TypeError(`${label} must be an exact semver version.`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new TypeError(`${label} must be a sha256:<64 lowercase hex> digest.`);
  return result;
}

function bytes32(value: unknown, label: string): string {
  const result = text(value, label);
  if (!BYTES32.test(result)) throw new TypeError(`${label} must be a canonical lowercase 0x bytes32 value.`);
  return result;
}

function address(value: unknown, label: string): string {
  const result = text(value, label).toLowerCase();
  if (!ADDRESS.test(result)) throw new TypeError(`${label} must be a canonical 20-byte 0x address.`);
  return result;
}

function safeLength(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireIsolation(value: unknown, label: string): ExternalModuleIsolation {
  if (typeof value !== "string" || !ISOLATIONS.has(value as ExternalModuleIsolation)) throw new TypeError(`${label} is invalid.`);
  return value as ExternalModuleIsolation;
}

function requireProvenance(value: unknown, label: string): ExternalModuleProvenance {
  if (typeof value !== "string" || !PROVENANCE.has(value as ExternalModuleProvenance)) throw new TypeError(`${label} is invalid.`);
  return value as ExternalModuleProvenance;
}

function entryOf(value: unknown, label = "external module index entry"): ExternalModuleIndexEntry {
  if (typeof value !== "object" || value === null || !ENTRY.has(value)) {
    throw new TypeError(`${label} must be created with externalModuleIndexEntry().`);
  }
  return value as ExternalModuleIndexEntry;
}

function indexState(value: unknown): ExternalModuleIndexState {
  if (typeof value !== "object" || value === null) throw new TypeError("external module index must be created with createExternalModuleIndex().");
  const state = INDEX.get(value);
  if (state === undefined) throw new TypeError("external module index must be created with createExternalModuleIndex().");
  return state;
}

function queryOf(value: unknown): ExternalModuleQuery {
  if (typeof value !== "object" || value === null) throw new TypeError("external module query must be created with externalModuleQuery().");
  const query = QUERY.get(value);
  if (query === undefined) throw new TypeError("external module query must be created with externalModuleQuery().");
  return query;
}

function observationState(value: unknown): ReviewRegistryObservationState {
  if (typeof value !== "object" || value === null) throw new TypeError("review observation must be returned by observeKeelModuleReviewRegistry().");
  const state = OBSERVATION.get(value);
  if (state === undefined) throw new TypeError("review observation must be returned by observeKeelModuleReviewRegistry().");
  return state;
}

function readerState(value: unknown): ReviewRegistryReaderState {
  if (typeof value !== "object" || value === null) throw new TypeError("review registry reader must be created with createKeelModuleReviewRegistryReader().");
  const state = READER.get(value);
  if (state === undefined) throw new TypeError("review registry reader must be created with createKeelModuleReviewRegistryReader().");
  return state;
}

function entrySortKey(entry: ExternalModuleIndexEntry): string {
  return `${entry.id}\u0000${entry.version}`;
}

function bindingKey(entry: ExternalModuleIndexEntry): string {
  return [
    entry.id, entry.version, entry.publisher,
    entry.output.moduleId, entry.output.version, entry.output.digest, String(entry.output.byteLength), entry.output.mediaType,
    entry.carrier.moduleId, entry.carrier.version, entry.carrier.digest, entry.carrier.objectId, entry.carrier.store, entry.carrier.chain,
    entry.sourceReceipt.id, entry.sourceReceipt.digest,
    entry.review?.specDigest ?? "", entry.review?.reviewDigest ?? "",
    ...entry.dependencies, entry.isolation, entry.provenance,
  ].join("\u0000");
}

function resultFor(entry: ExternalModuleIndexEntry, observed: ReviewRegistryObservationBoundary | undefined): ExternalModuleSearchResult {
  const review: ExternalModuleReviewState = observed === undefined
    ? Object.freeze({ kind: "provenance-only" as const })
    : observed;
  const result = Object.freeze({
    id: entry.id,
    version: entry.version,
    publisher: entry.publisher,
    objectId: entry.carrier.objectId,
    digest: entry.output.digest,
    carrier: entry.carrier,
    sourceReceipt: entry.sourceReceipt,
    dependencies: entry.dependencies,
    isolation: entry.isolation,
    verification: observed === undefined ? entry.provenance : "review-registry-observed" as const,
    review,
  });
  RESULT_OUTPUT.set(result, entry.output);
  return result;
}

function buildIndex(entries: readonly ExternalModuleIndexEntry[], observations: ReadonlyMap<string, ReviewRegistryObservationBoundary>): Readonly<ExternalModuleIndex> {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entrySortKey(entry);
    if (seen.has(key)) throw new TypeError(`duplicate external module index entry: ${entry.id}@${entry.version}.`);
    seen.add(key);
  }
  const ordered = Object.freeze([...entries].sort((left, right) => compareCodeUnits(entrySortKey(left), entrySortKey(right))));
  const results = Object.freeze(ordered.map((entry) => resultFor(entry, observations.get(bindingKey(entry)))));
  const index = Object.freeze({ entries: ordered, results });
  INDEX.set(index, Object.freeze({ entries: ordered, observations: new Map(observations) }));
  return index;
}

/**
 * Creates one local index record from primitives only. The optional review
 * digest pair is a claimed lookup key; it gains no trust until an opaque live
 * registry observation is attached later.
 */
export function externalModuleIndexEntry(
  id: string,
  selectedVersion: string,
  publisher: string,
  outputDigest: string,
  outputByteLength: number,
  outputMediaType: string,
  carrierObjectId: string,
  carrierStore: string,
  carrierChain: string,
  sourceReceiptId: string,
  sourceReceiptDigest: string,
  reviewSpecDigest: string | undefined,
  reviewDigest: string | undefined,
  isolation: ExternalModuleIsolation,
  provenance: ExternalModuleProvenance,
  ...dependencies: string[]
): ExternalModuleIndexEntry {
  const safeId = text(id, "external module id");
  const safeVersion = semver(selectedVersion, "external module version");
  const safePublisher = text(publisher, "external module publisher");
  const safeDigest = digest(outputDigest, "external module output digest");
  const safeByteLength = safeLength(outputByteLength, "external module output byteLength");
  const safeMediaType = text(outputMediaType, "external module output mediaType");
  const safeObjectId = bytes32(carrierObjectId, "external module carrier objectId");
  const safeStore = text(carrierStore, "external module carrier store");
  const safeChain = text(carrierChain, "external module carrier chain");
  const safeReceiptId = text(sourceReceiptId, "external module source receipt id");
  const safeReceiptDigest = digest(sourceReceiptDigest, "external module source receipt digest");
  const safeIsolation = requireIsolation(isolation, "external module isolation");
  const safeProvenance = requireProvenance(provenance, "external module provenance");
  const safeDependencies = dependencies.map((dependency, position) => text(dependency, `external module dependency ${position}`));
  if (new Set(safeDependencies).size !== safeDependencies.length) throw new TypeError("external module dependencies must not contain duplicates.");
  if (safeDependencies.some((dependency, position) => position > 0 && compareCodeUnits(safeDependencies[position - 1]!, dependency) >= 0)) {
    throw new TypeError("external module dependencies must be in strict UTF-16 code-unit order.");
  }
  if ((reviewSpecDigest === undefined) !== (reviewDigest === undefined)) {
    throw new TypeError("external module review spec and review digest must either both be supplied or both be omitted.");
  }
  const review = reviewSpecDigest === undefined
    ? undefined
    : Object.freeze({ specDigest: bytes32(reviewSpecDigest, "external module review spec digest"), reviewDigest: bytes32(reviewDigest, "external module review digest") });
  const output = Object.freeze({ moduleId: safeId, version: safeVersion, digest: safeDigest, byteLength: safeByteLength, mediaType: safeMediaType });
  const carrier = Object.freeze({ moduleId: safeId, version: safeVersion, digest: safeDigest, objectId: safeObjectId, store: safeStore, chain: safeChain });
  const sourceReceipt = Object.freeze({ id: safeReceiptId, digest: safeReceiptDigest });
  const entry = Object.freeze({
    id: safeId,
    version: safeVersion,
    publisher: safePublisher,
    output,
    carrier,
    sourceReceipt,
    ...(review === undefined ? {} : { review }),
    dependencies: Object.freeze([...safeDependencies]),
    isolation: safeIsolation,
    provenance: safeProvenance,
  });
  ENTRY.add(entry);
  return entry;
}

/** Builds a deterministic, provenance-only local index from opaque entries. */
export function createExternalModuleIndex(...entries: ExternalModuleIndexEntry[]): Readonly<ExternalModuleIndex> {
  const records = entries.map((entry, position) => entryOf(entry, `external module index entry ${position}`));
  return buildIndex(records, new Map());
}

/**
 * Creates an opaque search filter from primitives. There is deliberately no
 * raw-object filter API, so a getter or Proxy has no validation path to run.
 */
export function externalModuleQuery(
  id?: string,
  selectedVersion?: string,
  publisher?: string,
  isolation?: ExternalModuleIsolation,
  verification?: ExternalModuleVerification,
  query?: string,
): Readonly<ExternalModuleQuery> {
  if (verification !== undefined && (typeof verification !== "string" || !(["publisher-attested", "unverified", "review-registry-observed"] as const).includes(verification))) {
    throw new TypeError("external module query verification is invalid.");
  }
  const result = Object.freeze({
    ...(id === undefined ? {} : { id: text(id, "external module query id") }),
    ...(selectedVersion === undefined ? {} : { version: semver(selectedVersion, "external module query version") }),
    ...(publisher === undefined ? {} : { publisher: text(publisher, "external module query publisher") }),
    ...(isolation === undefined ? {} : { isolation: requireIsolation(isolation, "external module query isolation") }),
    ...(verification === undefined ? {} : { verification }),
    ...(query === undefined ? {} : { text: text(query, "external module query text") }),
  }) as ExternalModuleQuery;
  QUERY.set(result, result);
  return result;
}

export function searchExternalModules(index: Readonly<ExternalModuleIndex>, query?: Readonly<ExternalModuleQuery>): readonly ExternalModuleSearchResult[] {
  const state = indexState(index);
  const filter = query === undefined ? undefined : queryOf(query);
  const textQuery = filter?.text?.toLowerCase();
  return Object.freeze(state.entries
    .map((entry) => resultFor(entry, state.observations.get(bindingKey(entry))))
    .filter((entry) =>
      (filter?.id === undefined || entry.id === filter.id) &&
      (filter?.version === undefined || entry.version === filter.version) &&
      (filter?.publisher === undefined || entry.publisher === filter.publisher) &&
      (filter?.isolation === undefined || entry.isolation === filter.isolation) &&
      (filter?.verification === undefined || entry.verification === filter.verification) &&
      (textQuery === undefined || entry.id.toLowerCase().includes(textQuery) || entry.publisher.toLowerCase().includes(textQuery)),
    ));
}

/**
 * Builds the only supported review reader. It accepts no resolver/callback and
 * does not expose a custom fetch implementation: endpoint policy comes from
 * `createKeelRpcClient`'s governed default host list.
 */
export function createKeelModuleReviewRegistryReader(
  chainId: number,
  registry: string,
  endpoint: string,
  ...fallbackEndpoints: string[]
): Readonly<KeelModuleReviewRegistryReader> {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError("review registry chainId must be a positive safe integer.");
  }
  const safeRegistry = address(registry, "review registry address");
  const endpoints = [text(endpoint, "review registry endpoint"), ...fallbackEndpoints.map((value, position) => text(value, `review registry fallback endpoint ${position}`))];
  const client = createKeelRpcClient({ family: "ethereum", chainId, endpoints });
  const reader = Object.freeze({ chain: `eip155:${chainId}`, registry: safeRegistry });
  READER.set(reader, Object.freeze({ chainId, registry: safeRegistry, client }));
  return reader;
}

async function registryRead(
  state: ReviewRegistryReaderState,
  functionName: "moduleAuthorized" | "bindingsMatch" | "submission" | "review",
  specDigest: string,
  blockHash: string,
): Promise<string> {
  const data = `${REVIEW_REGISTRY_SELECTORS[functionName]}${specDigest.slice(2)}`;
  return state.client.call({
    to: state.registry,
    data,
    block: { blockHash: blockHash as `0x${string}`, requireCanonical: true },
  });
}

function responseWords(value: unknown, label: string, wordCount: number): readonly string[] {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/u.test(value)) {
    throw new TypeError(`${label} returned malformed ABI hex.`);
  }
  const body = value.slice(2).toLowerCase();
  if (body.length !== wordCount * 64) {
    throw new TypeError(`${label} returned ${body.length / 2} bytes; expected exactly ${wordCount * 32}.`);
  }
  const words: string[] = [];
  for (let offset = 0; offset < body.length; offset += 64) words.push(body.slice(offset, offset + 64));
  return Object.freeze(words);
}

function booleanResult(value: unknown, label: string): boolean {
  const [word] = responseWords(value, label, 1);
  if (word === "0".repeat(64)) return false;
  if (word === `${"0".repeat(63)}1`) return true;
  throw new TypeError(`${label} returned a non-canonical ABI boolean.`);
}

function submissionExists(value: unknown): boolean {
  // Submission is a wholly static 11-word tuple. `exists` is its final word;
  // because this call is keyed by specDigest, a true value binds that exact
  // submitted spec rather than an arbitrary receipt object.
  const words = responseWords(value, "KeelModuleReviewRegistry.submission", 11);
  const exists = words[10]!;
  if (exists === "0".repeat(64)) return false;
  if (exists === `${"0".repeat(63)}1`) return true;
  throw new TypeError("KeelModuleReviewRegistry.submission returned a non-canonical exists flag.");
}

function reviewDigestResult(value: unknown): string {
  // Review is a wholly static 7-word tuple; reviewDigest is word one.
  const words = responseWords(value, "KeelModuleReviewRegistry.review", 7);
  return bytes32(`0x${words[1]!}`, "KeelModuleReviewRegistry review digest");
}

/**
 * Reads the authoritative contract at one caller-pinned canonical block. It
 * refuses anything short of exact submission existence, review-digest match,
 * `moduleAuthorized(specDigest)`, and `bindingsMatch(specDigest)`.
 */
export async function observeKeelModuleReviewRegistry(
  reader: Readonly<KeelModuleReviewRegistryReader>,
  entry: ExternalModuleIndexEntry,
  canonicalBlockHash: string,
): Promise<Readonly<KeelModuleReviewRegistryObservation>> {
  const state = readerState(reader);
  const indexed = entryOf(entry);
  if (indexed.review === undefined) throw new TypeError("external module has no immutable review spec/review digest binding to observe.");
  const blockHash = bytes32(canonicalBlockHash, "review registry canonical block hash");
  const specDigest = indexed.review.specDigest;
  const [authorized, bindings, submission, review] = await Promise.all([
    registryRead(state, "moduleAuthorized", specDigest, blockHash),
    registryRead(state, "bindingsMatch", specDigest, blockHash),
    registryRead(state, "submission", specDigest, blockHash),
    registryRead(state, "review", specDigest, blockHash),
  ]);
  if (!booleanResult(authorized, "KeelModuleReviewRegistry.moduleAuthorized") ||
      !booleanResult(bindings, "KeelModuleReviewRegistry.bindingsMatch")) {
    throw new TypeError("KeelModuleReviewRegistry did not report both current authorization and matching live bindings.");
  }
  if (!submissionExists(submission)) throw new TypeError("KeelModuleReviewRegistry submission is missing at the requested canonical block.");
  const observedReviewDigest = reviewDigestResult(review);
  if (observedReviewDigest !== indexed.review.reviewDigest) {
    throw new TypeError("KeelModuleReviewRegistry review digest does not match the immutable local review binding.");
  }
  const boundary = Object.freeze({
    kind: "keel-module-review-registry" as const,
    trustBoundary: "governed-rpc-read-at-canonical-block" as const,
    chain: `eip155:${state.chainId}`,
    registry: state.registry,
    blockHash,
    specDigest,
    reviewDigest: observedReviewDigest,
  });
  const observed = Object.freeze({
    id: indexed.id,
    version: indexed.version,
    digest: indexed.output.digest,
    objectId: indexed.carrier.objectId,
    review: boundary,
  });
  OBSERVATION.set(observed, Object.freeze({ entryKey: bindingKey(indexed), boundary }));
  return observed;
}

/**
 * Produces a new immutable index with only opaque, pinned-block observations
 * attached. Raw local data and publisher provenance cannot enter this path.
 */
export function withKeelModuleReviewRegistryObservations(
  index: Readonly<ExternalModuleIndex>,
  ...observations: KeelModuleReviewRegistryObservation[]
): Readonly<ExternalModuleIndex> {
  const state = indexState(index);
  const validKeys = new Set(state.entries.map(bindingKey));
  const next = new Map(state.observations);
  for (const observation of observations) {
    const observed = observationState(observation);
    if (!validKeys.has(observed.entryKey)) throw new TypeError("review observation does not bind an entry in this local index.");
    if (next.has(observed.entryKey)) throw new TypeError("a local index entry already has a review-registry observation.");
    next.set(observed.entryKey, observed.boundary);
  }
  return buildIndex(state.entries, next);
}

function exactResult(index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string): ExternalModuleSearchResult {
  const matches = searchExternalModules(index, externalModuleQuery(id, selectedVersion));
  if (matches.length !== 1) throw new TypeError(`external module ${id}@${selectedVersion} is missing or ambiguous in the local index.`);
  return matches[0]!;
}

function declaration<Api, Verification extends ExternalModuleVerification>(
  result: ExternalModuleSearchResult & { readonly verification: Verification },
  api: ModuleApiShape<Api>,
  alias: string,
): ExternalBrowserModuleDeclaration<Api, Verification> {
  // `browserModule` checks the opaque moduleApi marker with its own WeakSet;
  // passing a forged object or Proxy cannot trigger a property read here.
  const descriptor = browserModule(result.id, { as: alias, api });
  bindBrowserModuleDescriptor(descriptor, result.carrier);
  const declared = Object.freeze({ descriptor, module: result });
  const output = RESULT_OUTPUT.get(result);
  if (output === undefined) throw new TypeError("external module result must come from this SDK index.");
  DECLARATION.set(declared, { descriptor, result, output });
  return declared;
}

/**
 * Reads the exact carrier through the governed KEEL RPC client and hashes the
 * returned bytes before the descriptor may enter a publishable browser target.
 */
export async function verifyExternalBrowserModuleOnchain<Api, Verification extends ExternalModuleVerification>(
  declared: ExternalBrowserModuleDeclaration<Api, Verification>,
  endpoint: string,
  ...fallbackEndpoints: string[]
): Promise<ExternalBrowserModuleDeclaration<Api, Verification>> {
  if (typeof declared !== "object" || declared === null) throw new TypeError("external browser module must be created by this SDK.");
  const state = DECLARATION.get(declared);
  if (state === undefined) throw new TypeError("external browser module must be created by this SDK.");
  const chainMatch = /^eip155:([1-9][0-9]*)$/u.exec(state.result.carrier.chain);
  if (chainMatch === null) throw new TypeError("browser module carrier must use an Ethereum CAIP-2 chain.");
  const chainId = Number(chainMatch[1]);
  if (!Number.isSafeInteger(chainId)) throw new TypeError("browser module carrier chain ID is too large.");
  const expectedDigest = `0x${state.result.carrier.digest.slice("sha256:".length)}` as `0x${string}`;
  const client = createKeelRpcClient({ family: "ethereum", chainId, endpoints: [endpoint, ...fallbackEndpoints] });
  await client.haulObjectVerified(state.result.carrier.store, state.result.carrier.objectId, {
    algorithm: "sha256",
    digest: expectedDigest,
  });
  markBrowserModuleDescriptorVerified(state.descriptor);
  return declared;
}

/**
 * Verifies an exact module through a configured KEEL Studio object gateway.
 * This is the compressed-object path: deployed KeelHold contracts deliberately
 * reject `haulObject` for compressed roots, while Studio reconstructs their
 * immutable carriers, decompresses them, and serves the committed plaintext.
 * The SDK still hashes and length-checks the returned bytes before the module
 * descriptor may enter a publishable browser target.
 */
export async function verifyExternalBrowserModuleFromStudio<Api, Verification extends ExternalModuleVerification>(
  declared: ExternalBrowserModuleDeclaration<Api, Verification>,
  studioUrl: string,
): Promise<ExternalBrowserModuleDeclaration<Api, Verification>> {
  if (typeof declared !== "object" || declared === null) throw new TypeError("external browser module must be created by this SDK.");
  const state = DECLARATION.get(declared);
  if (state === undefined) throw new TypeError("external browser module must be created by this SDK.");
  const origin = new URL(studioUrl);
  const loopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) {
    throw new TypeError("KEEL Studio module verification requires HTTPS or an explicit loopback HTTP origin.");
  }
  if (origin.username !== "" || origin.password !== "" || origin.search !== "" || origin.hash !== "") {
    throw new TypeError("KEEL Studio module verification requires a credential-free origin URL.");
  }
  const chainMatch = /^eip155:([1-9][0-9]*)$/u.exec(state.result.carrier.chain);
  if (chainMatch === null) throw new TypeError("browser module carrier must use an Ethereum CAIP-2 chain.");
  const endpoint = new URL(
    `/api/onchain/${chainMatch[1]}/${encodeURIComponent(state.result.carrier.store)}/${encodeURIComponent(state.result.carrier.objectId)}`,
    origin.origin,
  );
  const response = await fetch(endpoint, { cache: "no-store", credentials: "omit", redirect: "error" });
  if (!response.ok) throw new Error(`KEEL Studio could not verify module ${state.result.id} (${response.status}).`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && BigInt(declaredLength) !== BigInt(state.output.byteLength)) {
    throw new Error(`KEEL Studio returned the wrong byte length for module ${state.result.id}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== state.output.byteLength) {
    throw new Error(`KEEL Studio returned the wrong byte length for module ${state.result.id}.`);
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (`sha256:${digest}` !== state.output.digest) {
    throw new Error(`KEEL Studio returned bytes that do not match module ${state.result.id}.`);
  }
  markBrowserModuleDescriptorVerified(state.descriptor);
  return declared;
}

/**
 * A legacy structural overload remains type-compatible for existing authored
 * files, but is rejected at runtime without inspecting it. New code passes
 * `moduleApi<T>()` and an optional alias as positional values.
 */
interface LegacyDeclarationOptions<Key extends string, Api> {
  readonly as?: Key;
  readonly api: ModuleApiShape<Api>;
}

/** Declares a typed API only after an opaque live review-registry observation. */
export function reviewedBrowserModule<const Key extends string = string, Api = unknown>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, api: ModuleApiShape<Api>, alias?: Key,
): ExternalBrowserModuleDeclaration<Api, "review-registry-observed">;
/** @deprecated Use `reviewedBrowserModule(index, id, version, moduleApi<T>(), alias)` instead. */
export function reviewedBrowserModule<const Key extends string = string, Api = unknown>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, options: LegacyDeclarationOptions<Key, Api>,
): ExternalBrowserModuleDeclaration<Api, "review-registry-observed">;
export function reviewedBrowserModule<const Key extends string = string, Api = unknown>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, api: ModuleApiShape<Api> | LegacyDeclarationOptions<Key, Api>, alias?: Key,
): ExternalBrowserModuleDeclaration<Api, "review-registry-observed"> {
  const result = exactResult(index, text(id, "module id"), semver(selectedVersion, "module version"));
  if (result.isolation === "side-effect") throw new TypeError("side-effect modules must be declared with rawBrowserModule().");
  if (result.verification !== "review-registry-observed") throw new TypeError("reviewed browser modules require an opaque current review-registry observation.");
  const key = alias === undefined ? result.id : text(alias, "module API alias");
  return declaration(result as ExternalModuleSearchResult & { readonly verification: "review-registry-observed" }, api as ModuleApiShape<Api>, key);
}

/** Declares a developer-mapped browser API without upgrading local provenance. */
export function customExternalBrowserModule<const Key extends string = string, Api = unknown>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, api: ModuleApiShape<Api>, alias?: Key,
): ExternalBrowserModuleDeclaration<Api, ExternalModuleProvenance>;
/** @deprecated Use `customExternalBrowserModule(index, id, version, moduleApi<T>(), alias)` instead. */
export function customExternalBrowserModule<const Key extends string = string, Api = unknown>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, options: LegacyDeclarationOptions<Key, Api>,
): ExternalBrowserModuleDeclaration<Api, ExternalModuleProvenance>;
export function customExternalBrowserModule<const Key extends string = string, Api = unknown>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, api: ModuleApiShape<Api> | LegacyDeclarationOptions<Key, Api>, alias?: Key,
): ExternalBrowserModuleDeclaration<Api, ExternalModuleProvenance> {
  const result = exactResult(index, text(id, "module id"), semver(selectedVersion, "module version"));
  if (result.verification === "review-registry-observed") throw new TypeError("use reviewedBrowserModule() for observed review-registry evidence.");
  if (result.isolation === "side-effect") throw new TypeError("side-effect modules must be declared with rawBrowserModule().");
  const key = alias === undefined ? result.id : text(alias, "module API alias");
  return declaration(result as ExternalModuleSearchResult & { readonly verification: ExternalModuleProvenance }, api as ModuleApiShape<Api>, key);
}

/** Includes a side-effect module but always exposes `unknown`, even if reviewed. */
export function rawBrowserModule<const Key extends string = string>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, alias?: Key,
): ExternalBrowserModuleDeclaration<unknown, ExternalModuleVerification>;
/** @deprecated Use `rawBrowserModule(index, id, version, alias)` instead. */
export function rawBrowserModule<const Key extends string = string>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, options: { readonly as?: Key },
): ExternalBrowserModuleDeclaration<unknown, ExternalModuleVerification>;
export function rawBrowserModule<const Key extends string = string>(
  index: Readonly<ExternalModuleIndex>, id: string, selectedVersion: string, alias?: Key | { readonly as?: Key },
): ExternalBrowserModuleDeclaration<unknown, ExternalModuleVerification> {
  const result = exactResult(index, text(id, "module id"), semver(selectedVersion, "module version"));
  if (result.isolation !== "side-effect") throw new TypeError("raw browser modules must be indexed as side-effect modules.");
  if (alias !== undefined && typeof alias !== "string") {
    throw new TypeError("raw browser module aliases must be a positional string; options objects are not inspected.");
  }
  return declaration(result, moduleApi<unknown>(), alias ?? result.id);
}

/**
 * Verify a Keel-wrapped token from anywhere — a build script, a CI job, an
 * agent — without a browser and without trusting a marketplace's rendering.
 *
 * Everything here is derived from `eth_call`. There is no server in the path
 * and no API key: the same facts the on-chain viewer shows are readable by
 * anyone who can reach a node.
 *
 *   const report = await verifyOnchaininatorToken({ rpcUrl, backpack, tokenId });
 *   if (report.grade !== "EXCELLENT") process.exitCode = 1;
 *
 * The node is not "a node of the caller's choosing" any more. It goes through
 * the shared RPC module, so the endpoint is held to the governed host list and
 * the report says which host answered — a verification report produced through
 * an undisclosed host is worth less than one that admits its own dependency.
 */

import {
  createKeelRpcClient,
  type KeelRpcDisclosure,
  type KeelRpcHostList,
} from "@keel/protocol";

export type OnchaininatorCustody = "None" | "Sealed" | "Frozen" | "Hollow" | "Compromised";
export type OnchaininatorLane = "Unproven" | "Attested" | "Committed" | "Native";

/**
 * How the viewer document bound to this token gets the artwork it renders, as
 * the proof ledger reports it. Not a claim anybody makes: the ledger reads the
 * viewer composite's own part list and looks for the asset the ladder proved.
 *
 *   `Unknown`  no viewer bound, or its parts cannot be read.
 *   `Linked`   the document does not carry the artwork. It reads it at render
 *              time — smaller on chain, and a host in the path.
 *   `Inline`   the artwork is one of the document's own parts. Nothing fetched.
 *   `Hybrid`   carries some of what it renders and fetches the rest.
 */
export type OnchaininatorCarriage = "Unknown" | "Linked" | "Inline" | "Hybrid";

export interface OnchaininatorCheck {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly points: number;
  readonly why: string;
}

export interface OnchaininatorReport {
  /** The wrapper collection address. The property keeps its pre-rename name so
   * the deprecated `backpack-verify` re-exports stay call-compatible. */
  readonly backpack: `0x${string}`;
  readonly tokenId: bigint;
  readonly custody: OnchaininatorCustody;
  readonly transferable: boolean;
  /** Held by the wrapper right now, read from `ownerOf`, never cached. */
  readonly held: boolean;
  readonly lane: OnchaininatorLane;
  readonly underlying: `0x${string}` | null;
  /** The route the original collection returns today. */
  readonly route: string | null;
  /** The CID the preserved artwork is named by, when it is content-addressed. */
  readonly assetCid: string | null;
  readonly artwork: { readonly bytes: number; readonly kind: string; readonly onChain: boolean };
  /** How the bound viewer document obtains the artwork, read from the ledger. */
  readonly carriage: OnchaininatorCarriage;
  /** Which host answered, and under which governed list. */
  readonly transport: KeelRpcDisclosure;
  readonly checks: readonly OnchaininatorCheck[];
  readonly score: number;
  readonly total: number;
  /**
   * `UNDETERMINED` when the token could not be read at all.
   *
   * Without it, an unreachable node and a genuinely unpreserved token produce
   * the same output: every check false, score zero, grade WEAK. That reads as a
   * verdict on somebody's token when it is a statement about the network, and
   * it is the more dangerous of the two because it looks considered.
   */
  readonly grade: "EXCELLENT" | "STRONG" | "PARTIAL" | "WEAK" | "UNDETERMINED";
  /** How many chain reads returned nothing. Non-zero means the score is partial. */
  readonly unreadable: number;
}

export interface VerifyOnchaininatorOptions {
  readonly rpcUrl: string;
  /** The wrapper collection address. The property keeps its pre-rename name so
   * the deprecated `backpack-verify` re-exports stay call-compatible. */
  readonly backpack: `0x${string}`;
  readonly tokenId: bigint | number | string;
  /** Supply your own transport when you already have one. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The deployment's governed RPC host list, read from
   * `KeelManager.rpcHostList`. Defaults to the built-in genesis list.
   */
  readonly hostList?: KeelRpcHostList | readonly string[];
  /** Local chains only. */
  readonly allowPrivateNetworkHosts?: boolean;
  readonly chainId?: number;
}

// Verified against the deployed contract rather than assumed — a wrong
// selector returns null, every check fails, and the report quietly lies.
const SELECTOR = {
  custodyOf: "0x65269e47",
  tokenJSON: "0x8f7bb179",
  UNDERLYING: "0xc5d664c6",
  FACTORY: "0x2dd31000",
  LEDGER: "0x4b660419",
  viewerCarriage: "0x4fab25f4",
} as const;

const CARRIAGE: readonly OnchaininatorCarriage[] = ["Unknown", "Linked", "Inline", "Hybrid"];

const CUSTODY: readonly OnchaininatorCustody[] = ["None", "Sealed", "Frozen", "Hollow", "Compromised"];

function pad(value: string): string {
  return value.replace(/^0x/u, "").padStart(64, "0");
}

function decodeString(hex: string): string | null {
  if (!hex || hex.length < 130) return null;
  const length = Number.parseInt(hex.slice(66, 130), 16);
  if (!Number.isFinite(length) || length === 0) return null;
  const body = hex.slice(130, 130 + length * 2);
  const bytes = Uint8Array.from(body.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the wrapper's own metadata rather than a cached copy, so a stale
 * marketplace record cannot make a report look better than the chain does.
 */
export async function verifyOnchaininatorToken(options: VerifyOnchaininatorOptions): Promise<OnchaininatorReport> {
  const tokenId = BigInt(options.tokenId);
  const chain = createKeelRpcClient({
    family: "ethereum",
    endpoints: [options.rpcUrl],
    ...(options.chainId === undefined ? {} : { chainId: options.chainId }),
    ...(options.hostList === undefined ? {} : { hostList: options.hostList }),
    ...(options.allowPrivateNetworkHosts === undefined
      ? {}
      : { allowPrivateNetworkHosts: options.allowPrivateNetworkHosts }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  // A read that fails is a fact about the network, not about the token. The
  // checks below still treat null as a failed check — but the count is kept, and
  // a token whose custody could not be read is graded UNDETERMINED rather than
  // WEAK, so an outage cannot be mistaken for a verdict.
  // Counted rather than silently absorbed. A report has to be able to say "I
  // could not read this" in a way that is distinguishable from "this failed".
  let unreadable = 0;
  const call = async (to: string, data: string): Promise<string | null> => {
    try {
      return await chain.call({ to, data });
    } catch {
      unreadable += 1;
      return null;
    }
  };

  const [custodyRaw, jsonRaw] = await Promise.all([
    call(options.backpack, SELECTOR.custodyOf + pad(tokenId.toString(16))),
    call(options.backpack, SELECTOR.tokenJSON + pad(tokenId.toString(16))),
  ]);

  // The ledger is not a constructor argument on the wrapper; it is resolved
  // through the factory, the same way the wrapper resolves it on chain.
  const carriage = await (async (): Promise<OnchaininatorCarriage> => {
    const factoryRaw = await call(options.backpack, SELECTOR.FACTORY);
    const factory = factoryRaw && factoryRaw.length >= 66 ? `0x${factoryRaw.slice(26, 66)}` : null;
    if (factory === null || /^0x0+$/u.test(factory)) return "Unknown";
    const ledgerRaw = await call(factory, SELECTOR.LEDGER);
    const ledger = ledgerRaw && ledgerRaw.length >= 66 ? `0x${ledgerRaw.slice(26, 66)}` : null;
    if (ledger === null || /^0x0+$/u.test(ledger)) return "Unknown";
    const raw = await call(
      ledger,
      SELECTOR.viewerCarriage + pad(options.backpack) + pad(tokenId.toString(16)),
    );
    if (raw === null) return "Unknown";
    return CARRIAGE[Number(BigInt(raw))] ?? "Unknown";
  })();

  const custody = CUSTODY[custodyRaw ? Number(BigInt(custodyRaw)) : 0] ?? "None";
  const held = custody === "Sealed" || custody === "Frozen";
  const json = decodeString(jsonRaw ?? "");
  const metadata = json ? (JSON.parse(json) as Record<string, unknown>) : {};

  // The wrapper's own context is the authority on what it claims; the checks
  // below decide whether those claims are worth anything.
  const attributes = (metadata.attributes as { trait_type?: string; value?: unknown }[] | undefined) ?? [];
  const trait = (name: string): string | null => {
    const found = attributes.find((entry) => entry.trait_type === name);
    return found ? String(found.value) : null;
  };
  const lane = ((): OnchaininatorLane => {
    const value = trait("Preservation");
    if (value === "native") return "Native";
    if (value === "creator-committed") return "Committed";
    if (value === "attested") return "Attested";
    return "Unproven";
  })();

  const image = typeof metadata.image === "string" ? metadata.image : "";
  const onChainArt = image.startsWith("data:");
  const inner = /data:image\/png;base64,([^"']+)/u.exec(image);
  const innerBase64 = inner?.[1];
  const artBytes = innerBase64 ? Math.floor((innerBase64.length * 3) / 4) : 0;

  const checks: OnchaininatorCheck[] = [
    { id: "art-on-chain", label: "Artwork stored on chain", points: 3, passed: onChainArt,
      why: "image is a data URI built by the contract, not a gateway pointer." },
    { id: "metadata-on-chain", label: "Metadata served on chain", points: 2, passed: Boolean(json),
      why: "tokenURI returns inline JSON assembled by the contract." },
    { id: "proven", label: "Art proven against its source", points: 2, passed: lane === "Native",
      why: "the CID the original committed to was recomputed on chain from these bytes." },
    // Deliberately about content hosts, not about the node. Reading the chain
    // through an RPC is a dependency too, and pretending otherwise is what the
    // `carriage` field and `transport` disclosure exist to stop; it is just not
    // the dependency this point is scoring.
    { id: "no-http", label: "No content host in the path", points: 1, passed: !/https?:\/\//u.test(image),
      why: "the metadata names no gateway; the bytes come off the chain." },
    { id: "held", label: "Original held by the wrapper", points: 1, passed: held,
      why: "custody is read from ownerOf on every transfer." },
    { id: "immutable", label: "Artwork is immutable", points: 1, passed: lane === "Native",
      why: "content-addressed, so it cannot be swapped in place." },
  ];

  const score = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.points, 0);
  const total = checks.reduce((sum, check) => sum + check.points, 0);

  return {
    backpack: options.backpack,
    tokenId,
    custody,
    transferable: trait("Transferable") === "true",
    held,
    lane,
    underlying: (metadata.keel_underlying as `0x${string}` | undefined) ?? null,
    route: (metadata.keel_route as string | undefined) ?? null,
    assetCid: (metadata.keel_asset_cid as string | undefined) ?? null,
    artwork: { bytes: artBytes, kind: onChainArt ? (image.slice(5, image.indexOf(";"))) : "unknown", onChain: onChainArt },
    carriage,
    transport: chain.disclosure(),
    checks,
    score,
    total,
    unreadable,
    // The wrapper's own custody is the read everything else hangs off. If that
    // did not come back, nothing below it was evaluated against reality, and
    // grading the result would be grading a guess.
    grade:
      custodyRaw === null
        ? "UNDETERMINED"
        : score >= 9
          ? "EXCELLENT"
          : score >= 7
            ? "STRONG"
            : score >= 5
              ? "PARTIAL"
              : "WEAK",
  };
}

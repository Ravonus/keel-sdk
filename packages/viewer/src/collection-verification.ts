export type CollectionFacetVerdict = "unknown" | "green" | "amber" | "red";

export interface CollectionFacetInput {
  readonly verdict: CollectionFacetVerdict;
  readonly authority?: string;
  readonly timelock?: string;
  readonly reason: string;
}

export interface CollectionVerificationInput {
  readonly proofClass: "native-proof" | "adapter-proof" | "content-only" | "attested-proof";
  readonly receiptId: string;
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly observationBlockNumber: string;
  readonly observationBlockHash: string;
  readonly collection: string;
  readonly tokenId: string;
  readonly policyVersion: string;
  readonly evidenceRoot: string;
  readonly presentationRevision: string;
  readonly portableRoot: string;
  readonly portableAnchorRoot: string;
  readonly presentationContentDigest: string;
  readonly revoked: boolean;
  readonly expired: boolean;
  readonly facets: Readonly<Record<"route" | "content" | "governance" | "mint" | "supply" | "upgrade", CollectionFacetInput>>;
}

export interface CollectionVerificationRow extends CollectionFacetInput {
  readonly id: "route" | "content" | "governance" | "mint" | "supply" | "upgrade";
  readonly label: string;
}

export interface CollectionVerificationView {
  readonly state: "verified" | "conditional" | "failed";
  readonly seal: string;
  readonly summary: string;
  readonly rows: readonly CollectionVerificationRow[];
}

const COLLECTION_ADDRESS = /^0x[0-9a-f]{40}$/u;
const COLLECTION_BYTES32 = /^0x[0-9a-f]{64}$/u;
const COLLECTION_UINT = /^(0|[1-9][0-9]*)$/u;
const COLLECTION_LABELS = Object.freeze({
  route: "Keel route",
  content: "Active presentation",
  governance: "Revision policy",
  mint: "Minting",
  supply: "Supply",
  upgrade: "Upgrades",
});
const COLLECTION_CONTROL_FACETS = ["route", "governance", "mint", "supply", "upgrade"] as const;

function validFacet(input: CollectionFacetInput, label: string): void {
  if (!["unknown", "green", "amber", "red"].includes(input.verdict)) throw new TypeError(`${label} verdict is invalid.`);
  if (input.reason.trim().length === 0) throw new TypeError(`${label} reason is required.`);
  if (input.authority !== undefined && !COLLECTION_ADDRESS.test(input.authority)) throw new TypeError(`${label} authority is invalid.`);
  if (input.timelock !== undefined && !COLLECTION_ADDRESS.test(input.timelock)) throw new TypeError(`${label} timelock is invalid.`);
  if (input.verdict === "amber" && input.authority === undefined && input.timelock === undefined) {
    throw new TypeError(`${label} amber must name its authority or timelock.`);
  }
}

export function evaluateCollectionVerification(input: CollectionVerificationInput): CollectionVerificationView {
  if (!["native-proof", "adapter-proof", "content-only", "attested-proof"].includes(input.proofClass)) {
    throw new TypeError("Collection proof class is unsupported.");
  }
  if (!COLLECTION_UINT.test(input.chainId) || !COLLECTION_UINT.test(input.blockNumber)
      || !COLLECTION_UINT.test(input.observationBlockNumber) || !COLLECTION_UINT.test(input.tokenId)
      || !COLLECTION_UINT.test(input.policyVersion) || !COLLECTION_UINT.test(input.presentationRevision)) {
    throw new TypeError("Collection proof integer identity is malformed.");
  }
  if (!COLLECTION_ADDRESS.test(input.collection) || !COLLECTION_BYTES32.test(input.receiptId)
      || !COLLECTION_BYTES32.test(input.blockHash) || !COLLECTION_BYTES32.test(input.observationBlockHash)
      || !COLLECTION_BYTES32.test(input.evidenceRoot)
      || !COLLECTION_BYTES32.test(input.portableRoot) || !COLLECTION_BYTES32.test(input.portableAnchorRoot)
      || !COLLECTION_BYTES32.test(input.presentationContentDigest)) {
    throw new TypeError("Collection proof address/root identity is malformed.");
  }
  const rows = (Object.keys(COLLECTION_LABELS) as Array<keyof typeof COLLECTION_LABELS>).map((id) => {
    const facet = input.facets[id];
    validFacet(facet, id);
    return Object.freeze({ id, label: COLLECTION_LABELS[id], ...facet });
  });
  if (input.proofClass === "content-only") {
    for (const id of COLLECTION_CONTROL_FACETS) {
      if (input.facets[id].verdict !== "unknown") {
        throw new TypeError("Content-only proof cannot manufacture contract-control verdicts.");
      }
    }
  }
  const route = input.facets.route.verdict;
  const content = input.facets.content.verdict;
  const verdicts = rows.map((row) => row.verdict);
  const state = input.revoked || input.expired || verdicts.includes("red")
    ? "failed"
    : verdicts.every((verdict) => verdict === "green") && input.proofClass !== "attested-proof"
      ? "verified"
      : "conditional";
  const routeSummary = route === "green"
    ? "Keel route locked"
    : route === "amber" ? `Route redirectable by ${input.facets.route.authority ?? input.facets.route.timelock}`
      : "Keel route not verifiable";
  const failedRows = rows.filter((row) => row.verdict === "red");
  const failedSummary = failedRows.length === 0 ? "" : ` ${failedRows.map((row) => `${row.label} failed: ${row.reason}`).join(" ")}`;
  const lifecycleFailure = input.revoked ? " Receipt revoked." : input.expired ? " Receipt expired." : "";
  const summary = `${routeSummary}. Current revision r${input.presentationRevision} ${content === "green" ? "verified" : "not verified"}.${failedSummary}${lifecycleFailure}`;
  return Object.freeze({
    state,
    seal: state === "failed" ? "Verification failed" : route === "green" ? "Keel route locked" : "Keel content only",
    summary,
    rows: Object.freeze(rows),
  });
}

export function allowCollectionVerificationFixtureQuery(hostname: string, explicitTestMode: boolean): boolean {
  return explicitTestMode || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

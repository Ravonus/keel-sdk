import type { Hex } from "@keel/protocol";

export interface KeelMarketProposal {
  readonly priceEth?: string;
  readonly bidder?: string;
}

export type KeelPluginFrameMessage =
  | { readonly kind: "handshake"; readonly plugin: "keel-market" }
  | {
      readonly kind: "intent";
      readonly plugin: "keel-market";
      readonly session: Hex;
      readonly intentId: string;
      readonly proposal: KeelMarketProposal;
    };

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

/**
 * Parse the only two messages accepted from a KeelMarket artwork frame.
 * Unknown protocols are ignored; malformed wallet protocols fail closed.
 */
export function parseKeelPluginFrameMessage(value: unknown): KeelPluginFrameMessage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.protocol === "keel-plugin-handshake@1") {
    if (!exactKeys(message, ["protocol", "plugin"]) || message.plugin !== "keel-market") {
      throw new TypeError("Malformed Keel plugin handshake.");
    }
    return { kind: "handshake", plugin: "keel-market" };
  }
  if (message.protocol !== "keel-wallet-intent@1") return undefined;
  if (!exactKeys(message, ["protocol", "session", "plugin", "intentId", "proposal"])) {
    throw new TypeError("Malformed Keel wallet intent envelope.");
  }
  if (
    message.plugin !== "keel-market" ||
    typeof message.session !== "string" ||
    !/^0x[0-9a-f]{64}$/u.test(message.session) ||
    typeof message.intentId !== "string" ||
    !/^market\.[a-z-]{2,32}$/u.test(message.intentId) ||
    message.proposal === null ||
    typeof message.proposal !== "object" ||
    Array.isArray(message.proposal)
  ) {
    throw new TypeError("Malformed Keel wallet intent fields.");
  }
  const proposal = message.proposal as Record<string, unknown>;
  if (!exactKeys(proposal, ["priceEth", "bidder"])) throw new TypeError("Malformed Keel market proposal.");
  if (
    typeof proposal.priceEth !== "string" ||
    proposal.priceEth.length > 80 ||
    typeof proposal.bidder !== "string" ||
    proposal.bidder.length > 42
  ) {
    throw new TypeError("Keel market proposal exceeds its schema limits.");
  }
  return {
    kind: "intent",
    plugin: "keel-market",
    session: message.session as Hex,
    intentId: message.intentId,
    proposal: { priceEth: proposal.priceEth, bidder: proposal.bidder },
  };
}

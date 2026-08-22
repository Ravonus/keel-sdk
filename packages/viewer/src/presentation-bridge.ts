/**
 * Hardened validator for the `keel-viewer-verification@1` presentation protocol
 * a gallery host receives from a Keel viewer frame.
 *
 * The legacy `isKeelViewerPresentationState` (in @keel/protocol) checks field
 * *types* but places no bound on string lengths, the `weapon.build` map size, or
 * numeric ranges, and callers fed the result straight into React state. This
 * module expresses the same protocol as a `host-bridge` policy so every inbound
 * presentation message is size-, depth-, and range-bounded, prototype-pollution
 * safe, and pinned to the expected frame window before any host UI reads it.
 */

import type { KeelViewerPresentationState } from "@keel/protocol";
import { createHostBridge, type HostBridgePolicy } from "./host-bridge.js";

export const KEEL_PRESENTATION_PROTOCOL = "keel-viewer-verification@1";

/**
 * Policy for the frame -> host presentation channel. The gallery frame is
 * sandboxed without `allow-same-origin` (see generative-visuals.tsx), so it
 * loads with an opaque origin and posts `origin === "null"`. The `opaque` policy
 * pins that origin AND makes host-bridge require an expected source window, so a
 * caller cannot accidentally accept from an unpinned window. Bounds are set
 * generously above the real producer's values
 * (examples/demos/vault-arcade/.../vault-character-gallery-viewer.js) while still
 * capping every attacker-controllable dimension; `maxBytes` is kept at or above
 * the largest field-bound total so a valid message is never rejected as oversize.
 */
export const keelPresentationBridgePolicy: HostBridgePolicy = {
  maxBytes: 16384,
  origin: { kind: "opaque" },
  maxDepth: 6,
  maxKeysPerObject: 64,
  protocols: [
    {
      protocol: KEEL_PRESENTATION_PROTOCOL,
      operationKey: "action",
      operations: {
        // The producer posts preview-ready with a `state` string; accept it.
        "preview-ready": { fields: { state: { type: "string", maxLength: 32, optional: true } } },
        "presentation-state": {
          fields: {
            presentation: { type: "enum", values: ["character", "weapon"] },
            character: {
              type: "object",
              fields: {
                tokenId: { type: "string", maxLength: 80 },
                seed: { type: "string", maxLength: 130 },
                appearance: { type: "string", maxLength: 160 },
              },
            },
            weapon: {
              type: "object",
              fields: {
                id: { type: "string", maxLength: 64 },
                name: { type: "string", maxLength: 96 },
                assetId: { type: "string", maxLength: 96 },
                build: { type: "string-map", maxEntries: 48, maxKeyLength: 48, maxValueLength: 96 },
                projectileStyle: { type: "string", maxLength: 48 },
                combat: {
                  type: "object",
                  fields: {
                    longRangeMode: { type: "string", maxLength: 48 },
                    cooldownMs: { type: "number", min: 0, max: 3_600_000 },
                    projectileSpeed: { type: "number", min: 0, max: 1_000_000 },
                    count: { type: "number", min: 0, max: 100_000, integer: true },
                    spread: { type: "number", min: 0, max: 100_000 },
                  },
                },
              },
            },
          },
        },
      },
    },
  ],
};

export type KeelPresentationInbound =
  | { readonly ok: true; readonly action: "preview-ready" }
  | { readonly ok: true; readonly action: "presentation-state"; readonly state: KeelViewerPresentationState }
  | { readonly ok: false; readonly code: string; readonly reason: string };

// Stateless (no session/sequence), so a single shared bridge is safe.
const presentationBridge = createHostBridge(keelPresentationBridgePolicy);

/**
 * Validate one presentation message. `expectedSource` is required — pass the
 * frame's `contentWindow` so a message from any other window is rejected.
 */
export function validateKeelPresentationMessage(
  event: { readonly data: unknown; readonly origin?: string | undefined; readonly source?: unknown },
  expectedSource: unknown,
): KeelPresentationInbound {
  const result = presentationBridge.accept(
    { data: event.data, origin: event.origin, source: event.source },
    expectedSource,
  );
  if (!result.ok) return result;
  if (result.operation === "preview-ready") return { ok: true, action: "preview-ready" };

  const message = result.message as {
    presentation: "character" | "weapon";
    character: { tokenId: string; seed: string; appearance: string };
    weapon: {
      id: string;
      name: string;
      assetId: string;
      build: Readonly<Record<string, string>>;
      projectileStyle: string;
      combat: {
        longRangeMode: string;
        cooldownMs: number;
        projectileSpeed: number;
        count: number;
        spread: number;
      };
    };
  };

  // Every field was validated by the policy above; assemble the typed state.
  const state: KeelViewerPresentationState = {
    protocol: KEEL_PRESENTATION_PROTOCOL,
    action: "presentation-state",
    presentation: message.presentation,
    character: {
      tokenId: message.character.tokenId,
      seed: message.character.seed,
      appearance: message.character.appearance,
    },
    weapon: {
      id: message.weapon.id,
      name: message.weapon.name,
      assetId: message.weapon.assetId,
      build: message.weapon.build,
      projectileStyle: message.weapon.projectileStyle,
      combat: {
        longRangeMode: message.weapon.combat.longRangeMode,
        cooldownMs: message.weapon.combat.cooldownMs,
        projectileSpeed: message.weapon.combat.projectileSpeed,
        count: message.weapon.combat.count,
        spread: message.weapon.combat.spread,
      },
    },
  };
  return { ok: true, action: "presentation-state", state };
}

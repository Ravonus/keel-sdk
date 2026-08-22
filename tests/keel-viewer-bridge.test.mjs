import assert from "node:assert/strict";
import test from "node:test";

import {
  createKeelViewerPresentationCommand,
  createKeelViewerPresentationRequest,
  isKeelViewerPresentationState,
  KEEL_VIEWER_BRIDGE_PROTOCOL,
} from "../packages/protocol/dist/index.js";

test("Keel viewer bridge keeps presentation controls and data in the host", () => {
  assert.deepEqual(createKeelViewerPresentationCommand("weapon"), {
    protocol: KEEL_VIEWER_BRIDGE_PROTOCOL,
    action: "set-presentation",
    presentation: "weapon",
  });
  assert.deepEqual(createKeelViewerPresentationRequest(), {
    protocol: KEEL_VIEWER_BRIDGE_PROTOCOL,
    action: "get-presentation",
  });
  assert.equal(isKeelViewerPresentationState({
    protocol: KEEL_VIEWER_BRIDGE_PROTOCOL,
    action: "presentation-state",
    presentation: "weapon",
    character: { tokenId: "4", seed: "0x01", appearance: "gold/cyan" },
    weapon: { id: "bloom", name: "Aegis Star", assetId: "0x02", build: { projectile: "blood" }, projectileStyle: "blood", combat: { longRangeMode: "six-node-burst", cooldownMs: 930, projectileSpeed: 475, count: 6, spread: 0.16 } },
  }), true);
  assert.equal(isKeelViewerPresentationState({ protocol: KEEL_VIEWER_BRIDGE_PROTOCOL, action: "presentation-state", presentation: "weapon" }), false);
  assert.equal(isKeelViewerPresentationState({ protocol: "attacker", action: "presentation-state", presentation: "weapon" }), false);
});

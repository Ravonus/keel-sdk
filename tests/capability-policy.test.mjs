import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedHostOperations,
  allowedWalletIntents,
  effectiveRuntimeCapabilities,
  hostOperationToken,
  intersectCapabilities,
  manifestCapabilityLayer,
  narrowWalletOperations,
  narrowHostOperations,
  walletIntentToken,
  walletSelectorToken,
} from "../packages/viewer/dist/index.js";

// A marketplace host policy expressed as the brief's flat ALLOW/DENY list.
function hostLayer() {
  return {
    label: "host",
    ceiling: true,
    allow: [
      "wallet.market.bid",
      "wallet.market.buy",
      "network.manifested",
      "chain.read",
      "storage",
      "browser.fullscreen",
      "browser.webassembly",
      "host.openlisting",
    ],
    deny: ["browser.camera", "browser.microphone", "navigation.parent", "wallet.market.approve"],
  };
}

test("effective set is the intersection of allows minus the union of denies", () => {
  const app = { label: "app", allow: ["wallet.market.bid", "browser.fullscreen", "chain.read", "storage"] };
  const effective = intersectCapabilities([hostLayer(), app]);
  assert.equal(effective.isAllowed("wallet.market.bid"), true);
  assert.equal(effective.isAllowed("browser.fullscreen"), true);
  assert.equal(effective.isAllowed("chain.read"), true);
  assert.equal(effective.isAllowed("wallet.market.buy"), false); // host allows, app did not request
  assert.equal(effective.isAllowed("host.openListing"), false); // isAllowed is case-insensitive; not requested by app
});

test("a concrete-ceiling app cannot widen above the host", () => {
  const app = { label: "app", allow: ["browser.camera", "wallet.market.drain", "wallet.market.bid"] };
  const effective = intersectCapabilities([hostLayer(), app]);
  assert.equal(effective.isAllowed("browser.camera"), false);
  assert.equal(effective.isAllowed("wallet.market.drain"), false);
  assert.equal(effective.isAllowed("wallet.market.bid"), true);
});

test("deny always wins over any allow", () => {
  const host = { label: "host", ceiling: true, allow: ["wallet.market.approve"], deny: ["wallet.market.approve"] };
  const app = { label: "app", allow: ["wallet.market.approve"] };
  const effective = intersectCapabilities([host, app]);
  assert.equal(effective.isAllowed("wallet.market.approve"), false);
  assert.deepEqual(effective.explain("wallet.market.approve").deniedBy, ["host"]);
});

test("monotonicity: adding a restrictive layer only removes capabilities", () => {
  const app = { label: "app", allow: ["wallet.market.bid", "wallet.market.buy", "chain.read"] };
  const two = intersectCapabilities([hostLayer(), app]);
  const module = { label: "module", allow: ["wallet.market.bid", "chain.read"] };
  const three = intersectCapabilities([hostLayer(), app, module]);
  for (const token of three.tokens) assert.equal(two.tokens.has(token), true);
  assert.equal(two.isAllowed("wallet.market.buy"), true);
  assert.equal(three.isAllowed("wallet.market.buy"), false);
});

test("matching is case-insensitive so a mixed-case token cannot evade a deny", () => {
  // Host allows the whole wallet namespace but denies approve; a plugin tries to
  // slip approve past the deny with different casing.
  const host = { label: "host", ceiling: true, allow: ["wallet.*"], deny: ["wallet.market.approve"] };
  const app = { label: "app", allow: ["wallet.market.Approve"] };
  const effective = intersectCapabilities([host, app]);
  assert.equal(effective.isAllowed("wallet.market.approve"), false);
  assert.equal(effective.isAllowed("wallet.market.Approve"), false);
});

test("a wildcard ceiling grant is surfaced (unbounded / wildcardGranted), not silent", () => {
  const host = { label: "host", ceiling: true, allow: ["wallet.*"] };
  const app = { label: "app", allow: ["wallet.market.newthing"] };
  const effective = intersectCapabilities([host, app]);
  // Dynamism is allowed, but the blast radius is visible.
  assert.equal(effective.isAllowed("wallet.market.newthing"), true);
  assert.deepEqual(effective.wildcardGranted, ["wallet.market.newthing"]);
  assert.equal(effective.unbounded, false); // namespace wildcard, not grant-all
  assert.equal(effective.explain("wallet.market.newthing").ceilingWildcardGranted, true);
});

test("grant-all ceiling is flagged unbounded", () => {
  const host = { label: "host", ceiling: true, allow: "*" };
  const app = { label: "app", allow: ["wallet.market.bid"] };
  const effective = intersectCapabilities([host, app]);
  assert.equal(effective.unbounded, true);
  assert.equal(effective.isAllowed("wallet.market.bid"), true);
});

test("strictCeiling makes a ceiling wildcard non-granting (forward-safe)", () => {
  const host = { label: "host", ceiling: true, allow: ["wallet.*", "chain.read"] };
  const app = { label: "app", allow: ["wallet.market.newthing", "chain.read"] };
  const strict = intersectCapabilities([host, app], { strictCeiling: true });
  // The wildcard no longer blesses an app-introduced token; only the concrete
  // ceiling token survives.
  assert.equal(strict.isAllowed("wallet.market.newthing"), false);
  assert.equal(strict.isAllowed("chain.read"), true);
  assert.equal(strict.unbounded, false);
  assert.deepEqual(strict.wildcardGranted, []);
});

test("array-form allow:['*'] behaves like grant-all and does not pollute the universe", () => {
  const host = { label: "host", ceiling: true, allow: ["*"] };
  const app = { label: "app", allow: ["wallet.market.bid"] };
  const effective = intersectCapabilities([host, app]);
  assert.equal(effective.unbounded, true);
  assert.equal(effective.isAllowed("*"), false); // "*" is not itself a grantable token
  assert.equal(effective.isAllowed("wallet.market.bid"), true);
});

test("a lone wildcard grants nothing on its own", () => {
  const host = { label: "host", ceiling: true, allow: "*" };
  const app = { label: "app", allow: "*" };
  const effective = intersectCapabilities([host, app]);
  assert.equal(effective.tokens.size, 0);
});

test("namespace deny wildcard removes a whole family", () => {
  const host = { label: "host", ceiling: true, allow: ["wallet.market.bid", "wallet.market.buy"], deny: ["wallet.*"] };
  const app = { label: "app", allow: ["wallet.market.bid", "wallet.market.buy"] };
  const effective = intersectCapabilities([host, app]);
  assert.equal(effective.isAllowed("wallet.market.bid"), false);
  assert.equal(effective.isAllowed("wallet.market.buy"), false);
});

test("order independence of intersection (concrete layers)", () => {
  const app = { label: "app", allow: ["wallet.market.bid", "chain.read", "storage"] };
  const a = intersectCapabilities([hostLayer(), { ...app }]);
  const b = intersectCapabilities([{ ...app }, hostLayer()]);
  assert.deepEqual([...a.tokens].sort(), [...b.tokens].sort());
});

test("token builders reject wildcard metacharacters", () => {
  assert.throws(() => walletIntentToken("market.*"), /must not contain/);
  assert.throws(() => hostOperationToken("*"), /must not contain/);
  assert.equal(walletSelectorToken("0x848a5307"), "walletselector.0x848a5307");
});

test("manifestCapabilityLayer derives browser + network + wallet tokens (lowercased)", () => {
  const layer = manifestCapabilityLayer({
    capabilities: { webAssembly: true, fullscreen: true, downloads: false },
    walletIntentIds: ["market.bid", "market.buy"],
    hasNetworkSources: true,
  });
  assert.equal(layer.allow.includes("browser.webassembly"), true);
  assert.equal(layer.allow.includes("browser.fullscreen"), true);
  assert.equal(layer.allow.includes("browser.downloads"), false);
  assert.equal(layer.allow.includes("network.manifested"), true);
  assert.equal(layer.allow.includes(walletIntentToken("market.bid")), true);
});

test("effectiveRuntimeCapabilities respects the host ceiling for the sandbox", () => {
  const host = { label: "host", ceiling: true, allow: ["browser.fullscreen"], deny: ["browser.webassembly"] };
  const manifest = manifestCapabilityLayer({
    capabilities: { webAssembly: true, fullscreen: true, gamepad: true },
    label: "manifest",
  });
  const effective = intersectCapabilities([host, manifest]);
  const caps = effectiveRuntimeCapabilities(effective);
  assert.equal(caps.fullscreen, true);
  assert.equal(caps.webAssembly, false); // host denies despite manifest wanting it
  assert.equal(caps.gamepad, false); // host never allows it
});

test("allowedWalletIntents / allowedHostOperations filter candidates by the effective set", () => {
  const app = { label: "app", allow: ["wallet.market.bid", "wallet.market.buy", "host.openlisting"] };
  const effective = intersectCapabilities([hostLayer(), app]);
  const intents = allowedWalletIntents(effective, ["market.bid", "market.buy", "market.approve", "market.drain"]);
  assert.deepEqual(intents.sort(), ["market.bid", "market.buy"]);
  const ops = allowedHostOperations(effective, ["openListing", "refreshArtwork"]);
  assert.deepEqual(ops, ["openListing"]);
  assert.equal(hostOperationToken("openListing"), "host.openlisting");
});

test("returned layers are frozen copies, not the caller's mutable arrays", () => {
  const allow = ["chain.read"];
  const app = { label: "app", allow };
  const effective = intersectCapabilities([hostLayer(), app]);
  const returned = effective.layers[1];
  assert.notEqual(returned.allow, allow); // copied, not aliased
  assert.throws(() => returned.allow.push("storage")); // frozen
});

test("narrowWalletOperations removes host-forbidden intents but never adds new ones", () => {
  const app = { label: "app", allow: ["wallet.market.bid", "wallet.market.buy"] };
  const effective = intersectCapabilities([hostLayer(), app]);
  // The plugin's cryptographically-verified intent table (the hard gate).
  const declared = {
    "market.bid": { selector: "0x01" },
    "market.buy": { selector: "0x02" },
    "market.approve": { selector: "0x03" }, // host denies this one
  };
  const narrowed = narrowWalletOperations(declared, effective);
  assert.deepEqual(Object.keys(narrowed).sort(), ["market.bid", "market.buy"]);
  // The schema object is preserved (further-restrict, not rewrite).
  assert.equal(narrowed["market.bid"].selector, "0x01");
  // It can never introduce an operation the declared table did not have.
  const stray = narrowWalletOperations({ "market.bid": {} }, effective);
  assert.deepEqual(Object.keys(stray), ["market.bid"]);
});

test("narrowHostOperations filters a host-operation map by policy", () => {
  const app = { label: "app", allow: ["host.openlisting"] };
  const effective = intersectCapabilities([hostLayer(), app]);
  const narrowed = narrowHostOperations({ openListing: { x: 1 }, refreshArtwork: { x: 2 } }, effective);
  assert.deepEqual(Object.keys(narrowed), ["openListing"]);
});

test("explain reports why a capability was blocked", () => {
  const app = { label: "app", allow: ["chain.read"] };
  const effective = intersectCapabilities([hostLayer(), app]);
  const buy = effective.explain("wallet.market.buy");
  assert.equal(buy.allowed, false);
  assert.equal(buy.inUniverse, true);
  assert.deepEqual(buy.notAllowedBy, ["app"]);
  const camera = effective.explain("browser.camera");
  assert.equal(camera.allowed, false);
  assert.equal(camera.deniedBy.includes("host"), true);
});

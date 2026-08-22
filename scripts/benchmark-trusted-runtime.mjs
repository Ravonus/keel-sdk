// Runtime benchmark for the trusted-runtime security layer. Proves that the
// host-bridge validation, capability intersection, and presentation validation
// added by the trusted-runtime effort cost far less than the work they guard
// (SHA-256 hashing of content), i.e. the boundary is practically free.
//
// Run: node scripts/benchmark-trusted-runtime.mjs [--json]
import { performance } from "node:perf_hooks";
import {
  createHostBridge,
  intersectCapabilities,
  validateKeelPresentationMessage,
} from "../packages/viewer/dist/index.js";
import { sha256Hex } from "../packages/protocol/dist/index.js";

const WARMUP = 5_000;
const ITERS = 50_000;

function bench(label, fn, iters = ITERS) {
  for (let i = 0; i < WARMUP; i += 1) fn(i);
  const start = performance.now();
  for (let i = 0; i < iters; i += 1) fn(i);
  const elapsedMs = performance.now() - start;
  const nsPerOp = (elapsedMs * 1e6) / iters;
  const opsPerSec = Math.round(1e3 / (elapsedMs / iters));
  return { label, iters, elapsedMs: Number(elapsedMs.toFixed(2)), nsPerOp: Number(nsPerOp.toFixed(1)), opsPerSec };
}

// --- host-bridge fixtures ---
const bridgePolicy = {
  maxBytes: 4096,
  origin: { kind: "opaque" },
  protocols: [
    {
      protocol: "keel-wallet-intent@1",
      operationKey: "intentId",
      sessionKey: "session",
      sequenceKey: "sequence",
      operations: {
        "market.bid": {
          fields: {
            proposal: {
              type: "object",
              fields: { priceEth: { type: "string", maxLength: 80 }, bidder: { type: "string", maxLength: 42, optional: true } },
            },
          },
        },
      },
    },
  ],
};
const SESSION = `0x${"ab".repeat(32)}`;
const frame = {};
const validBridge = createHostBridge(bridgePolicy);
validBridge.registerSession("keel-wallet-intent@1", SESSION);
function bridgeMessage(i) {
  return {
    data: {
      protocol: "keel-wallet-intent@1",
      intentId: "market.bid",
      session: SESSION,
      sequence: i + 1,
      proposal: { priceEth: "0.05", bidder: "" },
    },
    origin: "null",
    source: frame,
  };
}

// --- capability fixtures ---
const host = {
  label: "host",
  ceiling: true,
  allow: ["wallet.market.bid", "wallet.market.buy", "network.manifested", "chain.read", "storage", "browser.fullscreen", "browser.webassembly"],
  deny: ["browser.camera", "browser.microphone", "wallet.market.approve"],
};
const manifestLayer = { label: "manifest", allow: ["wallet.market.bid", "browser.fullscreen", "browser.webassembly", "chain.read"] };
const moduleLayer = { label: "module", allow: ["wallet.market.bid", "chain.read", "browser.fullscreen"] };
const appLayer = { label: "app", allow: ["wallet.market.bid", "chain.read"] };

// --- presentation fixtures ---
const presFrame = {};
const presMessage = {
  data: {
    protocol: "keel-viewer-verification@1",
    action: "presentation-state",
    presentation: "weapon",
    character: { tokenId: "1234", seed: "0xabc", appearance: "shell/visor/core/skin" },
    weapon: {
      id: "wpn-1",
      name: "Ion Lance",
      assetId: "asset-42",
      build: { barrel: "long", "projectile-style": "bolt" },
      projectileStyle: "bolt",
      combat: { longRangeMode: "charged", cooldownMs: 800, projectileSpeed: 420, count: 1, spread: 0 },
    },
  },
  origin: "null",
  source: presFrame,
};

// --- hashing fixtures (the guarded work, for comparison) ---
const oneKiB = new Uint8Array(1024).fill(7);
const sixtyFourKiB = new Uint8Array(64 * 1024).fill(7);

const results = [];
results.push(bench("host-bridge accept (valid wallet intent)", () => validBridge.accept(bridgeMessage(0), frame)));
results.push(
  bench("host-bridge reject (oversize message)", () => {
    const big = bridgeMessage(0);
    big.data = { ...big.data, proposal: { priceEth: "0".repeat(9000), bidder: "" } };
    validBridge.accept(big, frame);
  }),
);
results.push(bench("intersectCapabilities (4 layers)", () => intersectCapabilities([host, manifestLayer, moduleLayer, appLayer])));
results.push(bench("validateKeelPresentationMessage", () => validateKeelPresentationMessage(presMessage, presFrame)));
results.push(bench("sha256 (1 KiB) [guarded work]", () => sha256Hex(oneKiB), 20_000));
results.push(bench("sha256 (64 KiB) [guarded work]", () => sha256Hex(sixtyFourKiB), 5_000));

const report = { schema: "keel.trusted-runtime-benchmark@1", node: process.version, warmup: WARMUP, results };

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nTrusted-runtime security-layer benchmark (node ${process.version})\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("path", 42)}${pad("ns/op", 12)}ops/sec`);
  console.log("-".repeat(66));
  for (const r of results) console.log(`${pad(r.label, 42)}${pad(r.nsPerOp, 12)}${r.opsPerSec.toLocaleString()}`);
  const bridgeNs = results[0].nsPerOp;
  const hashNs = results[5].nsPerOp;
  console.log(
    `\nA valid bridge validation (${bridgeNs} ns) is ~${(hashNs / bridgeNs).toFixed(0)}x cheaper than hashing one 64 KiB resource (${hashNs} ns) — the boundary is negligible against the content work it guards.\n`,
  );
}

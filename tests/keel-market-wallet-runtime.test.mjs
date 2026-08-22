import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER_ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const EXACT_TRANSACTION = {
  from: ACCOUNT,
  to: OTHER_ACCOUNT,
  data: "0x1234",
  value: "0x0",
};
const sourcePath = path.resolve("examples/plugins/keel-market/wallet-runtime-v1.js");
const servedPath = path.resolve("apps/studio/public/keel/plugins/keel-market/wallet-runtime-v1.js");

async function loadRuntime() {
  const source = await readFile(sourcePath);
  return import(`data:text/javascript;base64,${source.toString("base64")}`);
}

function installProvider(value) {
  const provider = {
    on() {},
    removeListener() {},
    ...value,
  };
  const previousEthereum = Object.getOwnPropertyDescriptor(globalThis, "ethereum");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "ethereum", { configurable: true, writable: true, value: provider });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: globalThis });
  return () => {
    if (previousEthereum === undefined) delete globalThis.ethereum;
    else Object.defineProperty(globalThis, "ethereum", previousEthereum);
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  };
}

test("the served wallet runtime remains byte-identical to the graph-pinned seeder source", async () => {
  assert.deepEqual(await readFile(servedPath), await readFile(sourcePath));
});

test("a hostile provider that resolves a switch without changing chain cannot send", { concurrency: false }, async () => {
  const requests = [];
  const restore = installProvider({
    async request(input) {
      requests.push(input);
      switch (input.method) {
        case "eth_chainId": return "0x1";
        case "wallet_switchEthereumChain": return null;
        case "eth_requestAccounts":
        case "eth_accounts": return [ACCOUNT];
        case "eth_sendTransaction": return "0x" + "11".repeat(32);
        default: throw new Error(`Unexpected wallet method ${input.method}.`);
      }
    },
  });
  try {
    const runtime = await loadRuntime();
    await assert.rejects(() => runtime.connect(31_337), /did not switch to the required chain/u);
    await assert.rejects(() => runtime.sendExactTransaction(EXACT_TRANSACTION, 31_337), /no longer on the required chain/u);
    assert.equal(requests.filter((request) => request.method === "eth_sendTransaction").length, 0);
  } finally {
    restore();
  }
});

test("the runtime re-reads the active account and chain immediately before sending", { concurrency: false }, async () => {
  let chainId = "0x7a69";
  let activeAccount = ACCOUNT;
  const requests = [];
  const restore = installProvider({
    async request(input) {
      requests.push(input);
      switch (input.method) {
        case "eth_chainId": return chainId;
        case "eth_requestAccounts":
        case "eth_accounts": return [activeAccount];
        case "eth_sendTransaction": return "0x" + "22".repeat(32);
        default: throw new Error(`Unexpected wallet method ${input.method}.`);
      }
    },
  });
  try {
    const runtime = await loadRuntime();
    assert.equal(await runtime.connect(31_337), ACCOUNT);

    activeAccount = OTHER_ACCOUNT;
    await assert.rejects(
      () => runtime.sendExactTransaction(EXACT_TRANSACTION, 31_337),
      /account changed before transaction submission/u,
    );

    activeAccount = ACCOUNT;
    chainId = "0x1";
    await assert.rejects(() => runtime.sendExactTransaction(EXACT_TRANSACTION, 31_337), /no longer on the required chain/u);
    assert.equal(requests.filter((request) => request.method === "eth_sendTransaction").length, 0);
  } finally {
    restore();
  }
});

test("the runtime sends one unchanged exact transaction on the expected chain and account", { concurrency: false }, async () => {
  const requests = [];
  const restore = installProvider({
    async request(input) {
      requests.push(input);
      switch (input.method) {
        case "eth_chainId": return "0x7a69";
        case "eth_requestAccounts":
        case "eth_accounts": return [ACCOUNT];
        case "eth_sendTransaction": return "0x" + "33".repeat(32);
        default: throw new Error(`Unexpected wallet method ${input.method}.`);
      }
    },
  });
  try {
    const runtime = await loadRuntime();
    assert.equal(await runtime.connect(31_337), ACCOUNT);
    assert.equal(await runtime.sendExactTransaction(EXACT_TRANSACTION, 31_337), "0x" + "33".repeat(32));
    const sent = requests.filter((request) => request.method === "eth_sendTransaction");
    assert.deepEqual(sent, [{ method: "eth_sendTransaction", params: [EXACT_TRANSACTION] }]);
  } finally {
    restore();
  }
});

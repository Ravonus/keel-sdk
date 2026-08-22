import assert from "node:assert/strict";
import test from "node:test";

import { createViemKeelFactoryConnectors } from "@keel/ethereum-adapter";

const creator = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const agent = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const factory = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const hash = `0x${"11".repeat(32)}`;

test("viem connector keeps creator signing and agent submission separate", async () => {
  const calls = [];
  const connectors = createViemKeelFactoryConnectors({
    accountClient: {
      account: creator,
      signTypedData: async (input) => {
        calls.push({ kind: "sign", input });
        return hash;
      },
    },
    agentClient: {
      account: { address: agent },
      getChainId: async () => 31337,
      sendTransaction: async (input) => {
        calls.push({ kind: "send", input });
        return hash;
      },
    },
    publicClient: {
      getChainId: async () => 31337,
      getBlock: async () => ({ timestamp: 1_800_000_000n }),
      readContract: async (input) => {
        calls.push({ kind: "read", input });
        return input.functionName === "creatorNonces" ? 0n : `0x${"22".repeat(32)}`;
      },
      call: async (input) => { calls.push({ kind: "simulate", input }); },
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: hash, to: factory, logs: [{ address: factory, topics: [], data: "0x" }] }),
    },
  });

  assert.equal(await connectors.accountSigner.getAddress(), creator);
  assert.equal(await connectors.agentWallet.getChainId(), 31337);
  assert.equal(await connectors.publicClient.getChainTimestamp(), 1_800_000_000);
  await connectors.accountSigner.signTypedData({ account: creator, typedData: { domain: {}, types: {}, primaryType: "X", message: {} } });
  await connectors.agentWallet.sendTransaction({ account: agent, chainId: 31337, to: factory, data: "0x1234", value: 0n });
  const version = await connectors.publicClient.readContract({ address: factory, functionName: "FACTORY_VERSION" });
  assert.equal(version, `0x${"22".repeat(32)}`);
  await connectors.publicClient.simulateTransaction({ account: agent, chainId: 31337, to: factory, data: "0x1234", value: 0n });
  const receipt = await connectors.publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.to, factory);
  assert.deepEqual(receipt.logs[0], { address: factory, topics: [], data: "0x" });
  assert.deepEqual(calls.map((call) => call.kind), ["sign", "send", "read", "simulate"]);
});

test("viem connector rejects missing wallet accounts and unsafe timestamps", async () => {
  assert.throws(() => createViemKeelFactoryConnectors({
    accountClient: { signTypedData: async () => hash },
    agentClient: { account: agent, getChainId: async () => 31337, sendTransaction: async () => hash },
    publicClient: { getChainId: async () => 31337, getBlock: async () => ({ timestamp: 1n }), readContract: async () => `0x${"22".repeat(32)}`, call: async () => undefined, waitForTransactionReceipt: async () => ({ status: "success", transactionHash: hash, to: factory, logs: [] }) },
  }), /accountClient/iu);

  const connectors = createViemKeelFactoryConnectors({
    accountClient: { account: creator, signTypedData: async () => hash },
    agentClient: { account: agent, getChainId: async () => 31337, sendTransaction: async () => hash },
    publicClient: { getChainId: async () => 31337, getBlock: async () => ({ timestamp: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), readContract: async () => `0x${"22".repeat(32)}`, call: async () => undefined, waitForTransactionReceipt: async () => ({ status: "success", transactionHash: hash, to: factory, logs: [] }) },
  });
  await assert.rejects(connectors.publicClient.getChainTimestamp(), /safe integer/iu);
});

import { keelFactoryAbi, type Address } from "@keel/sdk";
import type { Hex } from "@keel/protocol";
import type {
  OcaFactoryAccountSigner,
  OcaFactoryAgentWallet,
  OcaFactoryPublicClient,
  OcaFactoryReceiptLog,
  OcaFactoryTransactionReceipt,
} from "./keel-factory-executor.js";
import { parseAbi } from "viem";

const OCA_FACTORY_ABI = parseAbi(keelFactoryAbi);

/**
 * The smallest viem client surface needed by the KeelFactory executor.
 *
 * The adapter deliberately accepts injected clients instead of creating a
 * transport. This makes the same connector usable from Wagmi, a test client,
 * or a server-side wallet without giving this package custody or RPC policy.
 */
export interface ViemOcaFactoryAccountClient {
  readonly account?: Address | { readonly address: Address };
  readonly signTypedData: (input: unknown) => Promise<Hex>;
}

export interface ViemOcaFactoryAgentClient {
  readonly account?: Address | { readonly address: Address };
  readonly getChainId: () => Promise<number>;
  readonly sendTransaction: (input: unknown) => Promise<Hex>;
}

export interface ViemOcaFactoryPublicClient {
  readonly getChainId: () => Promise<number>;
  readonly getBlock: () => Promise<{ readonly timestamp: bigint }>;
  readonly readContract: (input: unknown) => Promise<unknown>;
  readonly call: (input: unknown) => Promise<unknown>;
  readonly waitForTransactionReceipt: (input: unknown) => Promise<{
    readonly status: "success" | "reverted";
    readonly transactionHash: Hex;
    readonly to: Address | null;
    readonly logs: readonly {
      readonly address: Address;
      readonly topics: readonly Hex[];
      readonly data: Hex;
    }[];
  }>;
}

export interface ViemOcaFactoryClients {
  readonly accountClient: ViemOcaFactoryAccountClient;
  readonly agentClient: ViemOcaFactoryAgentClient;
  readonly publicClient: ViemOcaFactoryPublicClient;
}

function clientAddress(value: Address | { readonly address: Address } | undefined, label: string): Address {
  const address = typeof value === "string" ? value : value?.address;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(address)) {
    throw new TypeError(`${label} must expose a connected account address.`);
  }
  if (address.toLowerCase() === `0x${"00".repeat(20)}`) throw new TypeError(`${label} cannot be the zero address.`);
  return address.toLowerCase() as Address;
}

function chainTimestamp(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("Connected chain timestamp is outside the safe integer range.");
  return Number(value);
}

function receiptLog(log: { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }): OcaFactoryReceiptLog {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(log.address) || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(log.data)) {
    throw new TypeError("Viem returned a malformed KeelFactory receipt log.");
  }
  return { address: log.address.toLowerCase() as Address, topics: [...log.topics], data: log.data.toLowerCase() as Hex };
}

/**
 * Adapt two Wagmi/viem wallet clients and one viem public client to the
 * executor's explicit account-signs / agent-submits boundary.
 *
 * `accountClient` signs the creator's EIP-712 authorization. `agentClient`
 * sends the resulting `castDieFor` call. They may be the same
 * wallet only when the caller intentionally uses one account for both roles.
 */
export function createViemOcaFactoryConnectors(clients: ViemOcaFactoryClients): {
  readonly accountSigner: OcaFactoryAccountSigner;
  readonly agentWallet: OcaFactoryAgentWallet;
  readonly publicClient: OcaFactoryPublicClient;
} {
  const account = clientAddress(clients.accountClient.account, "accountClient");
  const agent = clientAddress(clients.agentClient.account, "agentClient");

  const accountSigner: OcaFactoryAccountSigner = {
    account,
    getAddress: async () => account,
    signTypedData: async ({ account: signingAccount, typedData }) => clients.accountClient.signTypedData({
      account: signingAccount,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    } as never),
  };

  const agentWallet: OcaFactoryAgentWallet = {
    account: agent,
    getChainId: clients.agentClient.getChainId,
    sendTransaction: async ({ account: sendingAccount, chainId, to, data, value }) => clients.agentClient.sendTransaction({
      account: sendingAccount,
      chainId,
      to,
      data,
      value,
    } as never),
  };

  const publicClient: OcaFactoryPublicClient = {
    getChainId: clients.publicClient.getChainId,
    getChainTimestamp: async () => chainTimestamp((await clients.publicClient.getBlock()).timestamp),
    readContract: async ({ address, functionName, args }) => clients.publicClient.readContract({
      address,
      abi: OCA_FACTORY_ABI,
      functionName,
      ...(args === undefined ? {} : { args }),
    } as never),
    simulateTransaction: async ({ account: sendingAccount, chainId, to, data, value }) => {
      await clients.publicClient.call({ account: sendingAccount, chainId, to, data, value } as never);
    },
    waitForTransactionReceipt: async ({ hash }) => {
      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash } as never);
      const normalized: OcaFactoryTransactionReceipt = {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        to: receipt.to === null ? null : receipt.to.toLowerCase() as Address,
        logs: receipt.logs.map(receiptLog),
      };
      return normalized;
    },
  };

  return { accountSigner, agentWallet, publicClient };
}

import {
  connect as wagmiConnect,
  createConfig,
  custom,
  disconnect,
  getConnection,
  sendTransaction,
  type Config,
} from "@wagmi/core";
import { injected } from "@wagmi/connectors";
import type { Address, EIP1193Provider, Hex } from "viem";

export const protocol = "keel-host-wallet-runtime@1" as const;
export const walletStack = Object.freeze({
  protocol: "keel-wagmi-wallet@1" as const,
  core: "@wagmi/core" as const,
  coreVersion: "3.6.4" as const,
  connectors: "@wagmi/connectors" as const,
  connectorsVersion: "8.1.0" as const,
  connector: "injected" as const,
});

type ExactTransaction = {
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: Hex;
};

type BrowserProvider = EIP1193Provider & {
  on?: (event: string, listener: (...args: readonly unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: readonly unknown[]) => void) => void;
};

let active:
  | {
      readonly chainId: number;
      readonly rpcUrl: string;
      readonly provider: BrowserProvider;
      readonly config: Config;
    }
  | undefined;

function browserProvider(): BrowserProvider {
  const value = (globalThis as typeof globalThis & { readonly ethereum?: BrowserProvider }).ethereum;
  if (value === undefined || typeof value.request !== "function") {
    throw new Error("Install or enable a browser wallet extension to continue.");
  }
  return value;
}

function validChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError("Invalid chain ID.");
  return chainId;
}

function publicRpcUrl(value: string | undefined): string {
  const raw = value ?? "http://127.0.0.1";
  if (raw.length > 2_048) throw new TypeError("Wallet RPC URL is too long.");
  const parsed = new URL(raw);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Wallet RPC URL must be a credential-free HTTP or HTTPS URL.");
  }
  return parsed.toString();
}

function chainDefinition(chainId: number, rpcUrl: string) {
  return {
    id: chainId,
    name: `Keel chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
}

function runtime(chainId: number, rpcUrl?: string) {
  const expectedChainId = validChainId(chainId);
  const provider = browserProvider();
  if (rpcUrl === undefined && active?.chainId === expectedChainId && active.provider === provider) return active;
  const expectedRpcUrl = publicRpcUrl(rpcUrl);
  if (
    active?.chainId === expectedChainId &&
    active.provider === provider &&
    active.rpcUrl === expectedRpcUrl
  ) return active;
  const chain = chainDefinition(expectedChainId, expectedRpcUrl);
  const connector = injected({
    shimDisconnect: false,
    target: () => ({ id: "keel-injected", name: "Browser wallet", provider }),
  });
  const config = createConfig({
    chains: [chain],
    connectors: [connector],
    multiInjectedProviderDiscovery: false,
    storage: null,
    transports: { [expectedChainId]: custom(provider, { retryCount: 0 }) },
  });
  active = { chainId: expectedChainId, rpcUrl: expectedRpcUrl, provider, config };
  return active;
}

function address(value: unknown, message: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/iu.test(value)) throw new Error(message);
  return value.toLowerCase() as Address;
}

async function providerState(provider: BrowserProvider): Promise<{ readonly chainId: number; readonly account: Address }> {
  const [rawChainId, rawAccounts] = await Promise.all([
    provider.request({ method: "eth_chainId" }),
    provider.request({ method: "eth_accounts" }),
  ]);
  if (typeof rawChainId !== "string" || !/^0x[0-9a-f]+$/iu.test(rawChainId)) {
    throw new Error("Wallet returned an invalid chain ID.");
  }
  if (!Array.isArray(rawAccounts)) throw new Error("Wallet returned no account.");
  return {
    chainId: Number(BigInt(rawChainId)),
    account: address(rawAccounts[0], "Wallet returned no account."),
  };
}

async function providerChainId(provider: BrowserProvider): Promise<number> {
  const rawChainId = await provider.request({ method: "eth_chainId" });
  if (typeof rawChainId !== "string" || !/^0x[0-9a-f]+$/iu.test(rawChainId)) {
    throw new Error("Wallet returned an invalid chain ID.");
  }
  return Number(BigInt(rawChainId));
}

function walletErrorCode(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = value as { readonly code?: unknown; readonly data?: unknown };
  if (typeof error.code === "number") return error.code;
  if (error.data !== null && typeof error.data === "object") {
    const nested = error.data as { readonly originalError?: { readonly code?: unknown } };
    if (typeof nested.originalError?.code === "number") return nested.originalError.code;
  }
  return undefined;
}

async function switchProviderChain(
  provider: BrowserProvider,
  chainId: number,
  rpcUrl: string,
): Promise<void> {
  if (await providerChainId(provider) === chainId) return;
  const chainIdHex = `0x${chainId.toString(16)}` as Hex;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error) {
    if (walletErrorCode(error) !== 4_902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainIdHex,
        chainName: `Keel chain ${chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [rpcUrl],
      }],
    });
  }
  if (await providerChainId(provider) !== chainId) {
    throw new Error("Wallet did not switch to the required chain.");
  }
}

export async function connect(chainId: number, rpcUrl?: string): Promise<Address> {
  const current = runtime(chainId, rpcUrl);
  await switchProviderChain(current.provider, current.chainId, current.rpcUrl);
  const existing = getConnection(current.config);
  if (existing.isConnected && existing.chainId === current.chainId) {
    const provider = await providerState(current.provider);
    const selected = address(existing.address, "Wagmi returned no connected account.");
    if (provider.chainId !== current.chainId) throw new Error("Wallet did not switch to the required chain.");
    if (provider.account !== selected) throw new Error("Wallet account changed while connecting.");
    return selected;
  }
  if (!existing.isDisconnected) {
    await disconnect(current.config);
  }
  const connector = current.config.connectors[0];
  if (connector === undefined) throw new Error("The verified Wagmi runtime has no injected connector.");
  const connected = await wagmiConnect(current.config, { connector });
  if (connected.chainId !== current.chainId) throw new Error("Wallet did not connect on the required chain.");
  const state = getConnection(current.config);
  const provider = await providerState(current.provider);
  const selected = address(state.address, "Wagmi returned no connected account.");
  if (!state.isConnected || state.chainId !== current.chainId || provider.chainId !== current.chainId) {
    throw new Error("Wallet did not switch to the required chain.");
  }
  if (provider.account !== selected) throw new Error("Wallet account changed while connecting.");
  return selected;
}

function exactTransaction(value: unknown): ExactTransaction {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Wallet runtime accepts only exact from/to/data/value transactions.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "data,from,to,value") {
    throw new TypeError("Wallet runtime accepts only exact from/to/data/value transactions.");
  }
  if (
    typeof record.data !== "string" ||
    typeof record.value !== "string" ||
    !/^0x[0-9a-f]*$/iu.test(record.data) ||
    !/^0x[0-9a-f]+$/iu.test(record.value)
  ) {
    throw new TypeError("Wallet runtime received malformed exact transaction fields.");
  }
  return {
    from: address(record.from, "Wallet runtime received a malformed sender."),
    to: address(record.to, "Wallet runtime received a malformed target."),
    data: record.data.toLowerCase() as Hex,
    value: record.value.toLowerCase() as Hex,
  };
}

export async function sendExactTransaction(transaction: unknown, chainId: number): Promise<Hex> {
  const exact = exactTransaction(transaction);
  const current = runtime(chainId);
  const connection = getConnection(current.config);
  const provider = await providerState(current.provider);
  if (!connection.isConnected || connection.chainId !== current.chainId || provider.chainId !== current.chainId) {
    throw new Error("Wallet is no longer on the required chain.");
  }
  const connected = address(connection.address, "Wagmi returned no connected account.");
  if (connected !== exact.from || provider.account !== exact.from) {
    throw new Error("Wallet account changed before transaction submission.");
  }
  return sendTransaction(current.config, {
    account: exact.from,
    chainId: current.chainId,
    connector: connection.connector,
    to: exact.to,
    data: exact.data,
    value: BigInt(exact.value),
  });
}

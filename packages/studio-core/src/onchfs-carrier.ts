import onchfs, {
  type DirectoryInode,
  type FileInode,
  type INode,
  type Inscription,
} from "onchfs";

import {
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  type Hex,
  type Integrity,
} from "@keel/protocol";

import {
  assertValidKeelMeasuredReadProfile,
  type KeelMeasuredReadProfile,
} from "./delivery-plan.js";
import type {
  BuiltKeelDirectory,
  KeelDirectoryOutputFile,
} from "./keel-hold.js";

export const KEEL_ONCHFS_CARRIER_PROTOCOL = "keel-tezos-onchfs-carrier@1" as const;
export const KEEL_ONCHFS_BINDING_PROTOCOL = "keel-tezos-onchfs-binding@1" as const;

export type KeelOnchfsInscription =
  | {
      readonly type: "chunk";
      readonly content: string;
      readonly hash: string;
    }
  | {
      readonly type: "file";
      readonly cid: string;
      readonly metadata: string;
      readonly chunks: readonly string[];
    }
  | {
      readonly type: "directory";
      readonly cid: string;
      readonly files: Readonly<Record<string, string>>;
    };

export interface KeelOnchfsObjectBinding {
  readonly objectId: string;
  readonly fileCid: string;
  readonly path: string;
  readonly resourceId?: string;
  readonly manifest: string;
  readonly manifestSha256: string;
  readonly storedSha256: string;
  readonly storedByteLength: number;
  readonly decodedSha256: string;
  readonly decodedByteLength: number;
  readonly mediaType: string;
  readonly compression: string;
}

/** Exact JSON handoff consumed by the Tezos inscription batch builder. */
export interface KeelOnchfsCarrierDocument {
  readonly schema: "keel-onchfs-directory@1";
  readonly rootCid: string;
  readonly files: readonly {
    readonly path: string;
    readonly resourceId?: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
  readonly keelBindingProtocol: typeof KEEL_ONCHFS_BINDING_PROTOCOL;
  readonly keelObjects: readonly KeelOnchfsObjectBinding[];
  readonly storageUpperBound: number;
  readonly inscriptions: readonly KeelOnchfsInscription[];
}

export interface KeelOnchfsCarrierReceipt {
  readonly protocol: typeof KEEL_ONCHFS_CARRIER_PROTOCOL;
  readonly network: string;
  readonly contract: string;
  readonly pinnedBlock: string;
  readonly profileEvidenceDigest: Hex;
  readonly rootCid: Hex;
  readonly rootUri: string;
  readonly documentIntegrity: Integrity;
  readonly metrics: {
    readonly files: number;
    readonly chunks: number;
    readonly directories: number;
    readonly bindings: number;
    readonly operations: number;
    readonly storageUpperBound: number;
  };
  readonly objects: readonly {
    readonly path: string;
    readonly resourceId?: string;
    readonly objectId: Hex;
    readonly fileCid: Hex;
    readonly decodedIntegrity: Integrity;
    readonly storedIntegrity: Integrity;
    readonly mediaType: string;
    readonly compression: string;
  }[];
}

export interface BuiltKeelOnchfsCarrier {
  readonly document: KeelOnchfsCarrierDocument;
  readonly receipt: KeelOnchfsCarrierReceipt;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function prefixed(value: string): Hex {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("OnchFS identity must be exactly 32 bytes.");
  return `0x${value}`;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function fileNodes(node: INode, prefix = ""): readonly { readonly path: string; readonly node: FileInode }[] {
  if (node.type === "file") return [{ path: prefix, node }];
  return Object.entries(node.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, child]) => fileNodes(child, prefix === "" ? name : `${prefix}/${name}`));
}

function encodedInscription(value: Inscription): KeelOnchfsInscription {
  if (value.type === "chunk") {
    return { type: "chunk", content: hex(value.content), hash: hex(value.hash) };
  }
  if (value.type === "file") {
    return {
      type: "file",
      cid: hex(value.cid),
      metadata: hex(value.metadata),
      chunks: value.chunks.map(hex),
    };
  }
  return {
    type: "directory",
    cid: hex(value.cid),
    files: Object.fromEntries(
      Object.entries(value.files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, cid]) => [name, hex(cid)]),
    ),
  };
}

function assertFitsProfile(directory: BuiltKeelDirectory, profile: KeelMeasuredReadProfile): void {
  assertValidKeelMeasuredReadProfile(profile);
  if (!/^tezos:[-a-zA-Z0-9]+$/u.test(profile.network)) {
    throw new TypeError("OnchFS carrier profile network must be a Tezos chain identifier.");
  }
  if (!/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(profile.contract)) {
    throw new TypeError("OnchFS carrier profile contract must be a KT1 address.");
  }
  const totalBytes = directory.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const largestFileBytes = directory.files.reduce((largest, file) => Math.max(largest, file.bytes.byteLength), 0);
  if (directory.files.length > profile.maxFiles) throw new RangeError("Directory exceeds the measured OnchFS file limit.");
  if (totalBytes > profile.maxDirectoryBytes) throw new RangeError("Directory exceeds the measured OnchFS total-byte limit.");
  if (largestFileBytes > profile.maxFileBytes) throw new RangeError("Directory exceeds the measured OnchFS per-file limit.");
}

function directoryFileByPath(directory: BuiltKeelDirectory): ReadonlyMap<string, KeelDirectoryOutputFile> {
  return new Map(directory.files.map((file) => [file.path, file] as const));
}

/**
 * Project one verified Keel directory into standard OnchFS inodes while
 * binding every resulting file CID back to its exact decoded/stored SHA-256
 * identity. The chunks are uploaded once: standard OnchFS and Keel reads
 * address the same contract storage.
 */
export async function buildKeelOnchfsCarrier(
  directory: BuiltKeelDirectory,
  profile: KeelMeasuredReadProfile,
): Promise<BuiltKeelOnchfsCarrier> {
  assertFitsProfile(directory, profile);
  if (!directory.files.some((file) => file.path === "index.html")) {
    throw new TypeError("OnchFS interactive carrier requires root index.html.");
  }
  const byPath = directoryFileByPath(directory);
  const root = onchfs.files.prepare(
    directory.files.map((file) => ({ path: file.path, content: file.bytes.slice() })),
  ) as DirectoryInode;
  const rawInscriptions = onchfs.inscriptions.prepare(root);
  const inscriptions = rawInscriptions.map(encodedInscription);
  const objects = await Promise.all(fileNodes(root).map(async ({ path, node }) => {
    const source = byPath.get(path);
    if (source === undefined) throw new Error(`OnchFS emitted an unknown file: ${path}`);
    const decodedIntegrity = await createIntegrity(node.source.content);
    if (
      decodedIntegrity.digest !== source.integrity.digest ||
      decodedIntegrity.byteLength !== source.integrity.byteLength
    ) {
      throw new Error(`OnchFS changed decoded bytes for ${path}.`);
    }
    const headers = onchfs.metadata.decode(node.metadata);
    const mediaType = headers["content-type"] ?? source.mediaType;
    const compression = headers["content-encoding"] ?? "none";
    const storedBytes = join(node.chunks.map((chunk) => chunk.bytes));
    const storedIntegrity = await createIntegrity(storedBytes);
    const fileCid = hex(node.cid);
    const manifestValue = {
      protocol: KEEL_ONCHFS_BINDING_PROTOCOL,
      path,
      decoded: {
        algorithm: "sha256",
        digest: decodedIntegrity.digest,
        byteLength: node.source.content.byteLength,
        mediaType,
      },
      carrier: {
        kind: "onchfs",
        fileCid: prefixed(fileCid),
        storedIntegrity,
        compression,
      },
    } as const;
    const manifestBytes = utf8ToBytes(canonicalJson(manifestValue));
    const manifestIntegrity = await createIntegrity(manifestBytes);
    return {
      objectId: manifestIntegrity.digest.slice(2),
      fileCid,
      path,
      ...(source.resourceId === undefined ? {} : { resourceId: source.resourceId }),
      manifest: hex(manifestBytes),
      manifestSha256: manifestIntegrity.digest.slice(2),
      storedSha256: storedIntegrity.digest.slice(2),
      storedByteLength: storedBytes.byteLength,
      decodedSha256: decodedIntegrity.digest.slice(2),
      decodedByteLength: node.source.content.byteLength,
      mediaType,
      compression,
    } satisfies KeelOnchfsObjectBinding;
  }));
  const document: KeelOnchfsCarrierDocument = {
    schema: "keel-onchfs-directory@1",
    rootCid: hex(root.cid),
    files: directory.files.map((file) => ({
      path: file.path,
      ...(file.resourceId === undefined ? {} : { resourceId: file.resourceId }),
      byteLength: file.bytes.byteLength,
      sha256: file.integrity.digest.slice(2),
    })),
    keelBindingProtocol: KEEL_ONCHFS_BINDING_PROTOCOL,
    keelObjects: objects,
    storageUpperBound: onchfs.inscriptions.inscriptionsBytesLength(rawInscriptions),
    inscriptions,
  };
  const documentIntegrity = await createIntegrity(utf8ToBytes(canonicalJson(document)));
  const chunks = inscriptions.filter((item) => item.type === "chunk").length;
  const files = inscriptions.filter((item) => item.type === "file").length;
  const directories = inscriptions.filter((item) => item.type === "directory").length;
  const rootCid = prefixed(document.rootCid);
  const rootUri = `onchfs://${profile.network}:${profile.contract}/${document.rootCid}/`;
  // Parsing is an important compatibility assertion: custom deployments must
  // carry their full chain + contract authority instead of relying on defaults.
  const parsed = onchfs.uri.parse(rootUri);
  if (parsed.cid !== document.rootCid || parsed.authority.contract !== profile.contract) {
    throw new Error("OnchFS custom-authority URI did not round-trip.");
  }
  return {
    document,
    receipt: {
      protocol: KEEL_ONCHFS_CARRIER_PROTOCOL,
      network: profile.network,
      contract: profile.contract,
      pinnedBlock: profile.pinnedBlock,
      profileEvidenceDigest: profile.evidenceDigest,
      rootCid,
      rootUri,
      documentIntegrity,
      metrics: {
        files,
        chunks,
        directories,
        bindings: objects.length,
        operations: inscriptions.length + objects.length,
        storageUpperBound: document.storageUpperBound,
      },
      objects: objects.map((object) => ({
        path: object.path,
        ...(object.resourceId === undefined ? {} : { resourceId: object.resourceId }),
        objectId: prefixed(object.objectId),
        fileCid: prefixed(object.fileCid),
        decodedIntegrity: {
          algorithm: "sha256",
          digest: prefixed(object.decodedSha256),
          byteLength: object.decodedByteLength,
        },
        storedIntegrity: {
          algorithm: "sha256",
          digest: prefixed(object.storedSha256),
          byteLength: object.storedByteLength,
        },
        mediaType: object.mediaType,
        compression: object.compression,
      })),
    },
  };
}

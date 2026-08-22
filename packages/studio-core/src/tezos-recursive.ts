import { createIntegrity, utf8ToBytes, type Hex } from "@keel/protocol";

export const KEEL_TEZOS_NODE_DOMAIN = utf8ToBytes("keel.tezos.node.v1");
export const KEEL_TEZOS_OBJECT_DOMAIN = utf8ToBytes("keel.tezos.object.v1");
export const KEEL_TEZOS_LEAF_BYTES = 12_000;
export const KEEL_TEZOS_NODE_FANOUT = 16;

export interface KeelTezosNode {
  readonly id: Hex;
  readonly encoded: Uint8Array;
  readonly kind: "leaf" | "composite";
  readonly decodedByteLength: number;
  readonly children: readonly Hex[];
}

export interface KeelTezosRecursiveObject {
  readonly id: Hex;
  readonly manifest: Uint8Array;
  readonly rootNode: Hex;
  readonly decodedSha256: Hex;
  readonly decodedByteLength: number;
  readonly mediaType: string;
  readonly nodes: readonly KeelTezosNode[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("u32 value is out of range");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("u64 value is out of range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function rawHex(value: Hex): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})+$/u.test(value)) throw new TypeError("non-canonical hex");
  return Uint8Array.from(value.slice(2).match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function node(encoded: Uint8Array, kind: KeelTezosNode["kind"], decodedByteLength: number, children: readonly Hex[]): Promise<KeelTezosNode> {
  const integrity = await createIntegrity(encoded);
  return { id: integrity.digest, encoded, kind, decodedByteLength, children };
}

/** Build the exact append-only node tree consumed by KeelRecursiveObjectStore. */
export async function buildKeelTezosRecursiveObject(bytes: Uint8Array, mediaType: string): Promise<KeelTezosRecursiveObject> {
  if (bytes.byteLength === 0) throw new TypeError("recursive object cannot be empty");
  const media = utf8ToBytes(mediaType);
  if (media.byteLength === 0 || media.byteLength > 64) throw new TypeError("recursive object media type must be 1-64 bytes");
  let layer: KeelTezosNode[] = [];
  const all = new Map<Hex, KeelTezosNode>();
  for (let offset = 0; offset < bytes.byteLength; offset += KEEL_TEZOS_LEAF_BYTES) {
    const payload = bytes.slice(offset, Math.min(offset + KEEL_TEZOS_LEAF_BYTES, bytes.byteLength));
    const current = await node(concat([KEEL_TEZOS_NODE_DOMAIN, Uint8Array.of(0), u32(payload.byteLength), payload]), "leaf", payload.byteLength, []);
    all.set(current.id, current);
    layer.push(current);
  }
  while (layer.length > 1) {
    const next: KeelTezosNode[] = [];
    for (let offset = 0; offset < layer.length; offset += KEEL_TEZOS_NODE_FANOUT) {
      const children = layer.slice(offset, offset + KEEL_TEZOS_NODE_FANOUT);
      const decodedByteLength = children.reduce((sum, child) => sum + child.decodedByteLength, 0);
      const encoded = concat([
        KEEL_TEZOS_NODE_DOMAIN,
        Uint8Array.of(1, children.length),
        ...children.map((child) => rawHex(child.id)),
        u64(decodedByteLength),
      ]);
      const current = await node(encoded, "composite", decodedByteLength, children.map((child) => child.id));
      all.set(current.id, current);
      next.push(current);
    }
    layer = next;
  }
  const root = layer[0] as KeelTezosNode;
  const decoded = await createIntegrity(bytes);
  const manifest = concat([
    KEEL_TEZOS_OBJECT_DOMAIN,
    rawHex(root.id),
    rawHex(decoded.digest),
    u64(bytes.byteLength),
    Uint8Array.of(media.byteLength),
    media,
  ]);
  const objectIntegrity = await createIntegrity(manifest);
  return {
    id: objectIntegrity.digest,
    manifest,
    rootNode: root.id,
    decodedSha256: decoded.digest,
    decodedByteLength: bytes.byteLength,
    mediaType,
    nodes: [...all.values()],
  };
}

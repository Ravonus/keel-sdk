/**
 * The smallest Micheline reader a sealed document can carry.
 *
 * Shared with the wrapper viewer rather than inlined into it, for the reason
 * `keel-asset-view.js` is shared: the viewer sealed into a token and anything
 * testing it have to be reading the same implementation, and a decoder that
 * only exists inside a DOM-bound IIFE is a decoder nothing can test.
 *
 * Everything here fails to `null` rather than throwing. A panel that says
 * nothing is better than a panel that says something wrong, and a sealed
 * document has no way to report an exception to anyone.
 */

/**
 * Flatten a right-combed Micheline record into positional fields.
 *
 * SmartPy lays a record out as nested pairs, so field five of nine is five
 * `Pair`s deep. There is no field name in the value — annotations live in the
 * *type*, not the data — so position is the only handle a reader has, and that
 * is why the field order of any record read this way has to be pinned by a
 * test against the compiled contract rather than remembered.
 */
export const flatten = (node, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (node.prim === "Pair" && Array.isArray(node.args)) {
    for (const arg of node.args) flatten(arg, out);
    return out;
  }
  out.push(node);
  return out;
};

export const asBytes = (node) => (node && typeof node.bytes === "string" ? node.bytes : null);

export const asInt = (node) => {
  if (!node || typeof node.int !== "string") return null;
  try {
    return BigInt(node.int);
  } catch {
    return null;
  }
};

export const asString = (node) => (node && typeof node.string === "string" ? node.string : null);

/** UTF-8 text from a hex byte string, or null if it is not decodable. */
export const bytesToText = (hex) => {
  if (typeof hex !== "string") return null;
  const body = hex.replace(/^0x/u, "");
  if (body.length % 2 !== 0 || /[^0-9a-fA-F]/u.test(body)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(body.match(/../gu) ?? [], (byte) => parseInt(byte, 16)),
    );
  } catch {
    return null;
  }
};

/**
 * Field positions in `KeelOnchFSStore.get_keel_object`.
 *
 * Taken from the compiled contract's declared view type, not from the source:
 *
 *   [0] file_cid  [1] manifest  [2] manifest_sha256  [3] stored_sha256
 *   [4] stored_byte_length  [5] decoded_sha256  [6] decoded_byte_length
 *   [7] media_type  [8] compression
 *
 * `stored_sha256` is the digest to show, because it is the one
 * `bind_keel_object` verified against the bytes it holds. `decoded_sha256` is
 * recorded but not checked, so it is the binder's claim rather than the
 * chain's finding, and a panel must not present the two as the same thing.
 */
export const KEEL_OBJECT_FIELDS = Object.freeze({
  fileCid: 0,
  manifestSha256: 2,
  storedSha256: 3,
  storedByteLength: 4,
  mediaType: 7,
  compression: 8,
});

/** Read a `get_keel_object` result. Null when the shape is not what it claims. */
export const readKeelObject = (node) => {
  const fields = flatten(node);
  if (fields.length < 9) return null;
  return {
    fileCid: asBytes(fields[KEEL_OBJECT_FIELDS.fileCid]),
    storedSha256: asBytes(fields[KEEL_OBJECT_FIELDS.storedSha256]),
    storedByteLength: asInt(fields[KEEL_OBJECT_FIELDS.storedByteLength]),
    mediaType: bytesToText(asBytes(fields[KEEL_OBJECT_FIELDS.mediaType])),
    compression: bytesToText(asBytes(fields[KEEL_OBJECT_FIELDS.compression])),
  };
};

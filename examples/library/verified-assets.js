/** Dependency-injected asset loader. The host resolver supplies already verified bytes. MIT. */
export function createVerifiedAssets(resolveResource) {
  if (typeof resolveResource !== "function") throw new TypeError("A verified host resolver is required.");
  const cache = new Map();
  const bytes = async (id) => {
    if (!cache.has(id)) cache.set(id, Promise.resolve(resolveResource(id)).then((value) => new Uint8Array(value)));
    return cache.get(id);
  };
  return {
    bytes,
    async text(id) { return new TextDecoder("utf-8", { fatal: true }).decode(await bytes(id)); },
    async json(id) { return JSON.parse(await this.text(id)); },
    async image(id, mediaType = "image/webp") { return createImageBitmap(new Blob([await bytes(id)], { type: mediaType })); },
    clear(id) { if (id === undefined) cache.clear(); else cache.delete(id); },
  };
}

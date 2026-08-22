/**
 * AI-friendly helpers for exact Keel poster and motion capture markers.
 * The viewer injects __KEEL_THUMBNAIL__; importing this file is optional.
 * MIT.
 */
function runtime() {
  const api = globalThis.__KEEL_THUMBNAIL__;
  if (api?.protocol !== "keel-thumbnail-capture@1") {
    throw new Error("This artwork is not running in a thumbnail-aware Keel viewer.");
  }
  return api;
}

export function thumbnailInit(label = "hero") {
  runtime().init(label);
}

export function thumbnailReady(label = "hero") {
  runtime().ready(label);
}

export function thumbnailStop(label = "hero") {
  runtime().stop(label);
}

export function thumbnailAfter(delayMs, label = "hero") {
  runtime().after(delayMs, label);
}

export async function thumbnailAfterInit(initializer, options = {}) {
  thumbnailInit(options.label);
  const value = await initializer();
  thumbnailAfter(options.delayMs ?? 0, options.label);
  return value;
}

(() => {
  "use strict";

  const ids = Object.freeze([2, 3, 4, 5, 6]);
  const packedWord = "0x0000000000000006000000000005000000000004000000000003000000000002";
  globalThis.__KEEL_COMET_INDEX__ = Object.freeze({
    protocol: "keel-comet-index@1",
    ids,
    packedWord,
    provenance: "modern-compatibility-mapping-not-historical-chain-snapshot",
  });

  function hashSeed(value) {
    return value * value * 0x5851f42d4c957f2dn + (value << 64n) - value;
  }

  globalThis.getColorComponent = (seed, index, limit) => {
    const primes = [92821n, 51437n, 44789n, 39631n, 34351n, 29059n, 22861n, 17659n, 12979n];
    return Number(hashSeed(seed * primes[index % primes.length] + BigInt(index)) % BigInt(limit));
  };
})();

import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_TEST_PUBLIC_RPC_URL,
  KEEL_TEST_STUDIO_URL,
  resolveKeelEndpoints,
} from "../packages/sdk/dist/index.js";

test("KEEL endpoints use canonical test hosts by default", () => {
  const resolved = resolveKeelEndpoints();
  assert.equal(resolved.studioUrl, KEEL_TEST_STUDIO_URL);
  assert.equal(resolved.publicRpcUrl, KEEL_TEST_PUBLIC_RPC_URL);
  assert.deepEqual(resolved.sources, {
    studioUrl: "canonical-default",
    publicRpcUrl: "canonical-default",
  });
  assert.match(resolved.compatibilityAliases.studioUrl, /^https:\/\/stratus-test\./u);
});

test("explicit KEEL endpoints take precedence over environment configuration", () => {
  const resolved = resolveKeelEndpoints({
    studioUrl: "https://explicit.example/",
    publicRpcUrl: "https://rpc.explicit.example",
    indexerUrl: "https://index.explicit.example",
  }, {
    KEEL_STUDIO_URL: "https://environment.example",
    KEEL_PUBLIC_RPC_URL: "https://rpc.environment.example",
    KEEL_INDEXER_URL: "https://index.environment.example",
  });
  assert.equal(resolved.studioUrl, "https://explicit.example");
  assert.equal(resolved.publicRpcUrl, "https://rpc.explicit.example");
  assert.equal(resolved.indexerUrl, "https://index.explicit.example");
  assert.deepEqual(resolved.sources, {
    studioUrl: "explicit",
    publicRpcUrl: "explicit",
    indexerUrl: "explicit",
  });
});

test("KEEL environment wins over the deprecated FRAY Studio alias", () => {
  const resolved = resolveKeelEndpoints({}, {
    KEEL_STUDIO_URL: "https://keel.example",
    FRAY_STUDIO_URL: "https://fray.example",
    KEEL_PUBLIC_RPC_URL: "https://rpc.keel.example",
  });
  assert.equal(resolved.studioUrl, "https://keel.example");
  assert.equal(resolved.sources.studioUrl, "environment");
});

test("endpoint configuration rejects paths, credentials, queries, and insecure URLs", () => {
  for (const studioUrl of [
    "http://keel.example",
    "https://user:secret@keel.example",
    "https://keel.example/studio",
    "https://keel.example?mode=test",
    "https://keel.example/#fragment",
  ]) {
    assert.throws(() => resolveKeelEndpoints({ studioUrl }), /credential-free HTTPS origin/u);
  }
});

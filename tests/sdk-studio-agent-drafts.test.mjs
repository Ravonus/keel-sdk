import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODULE = pathToFileURL(path.join(ROOT, "packages", "sdk", "dist", "studio-agent-drafts.js")).href;

const baseDraft = {
  artifactId: "artifact-1",
  title: "Agent work",
  description: "Drafted through an explicit creator grant.",
  story: "",
  releaseType: "one-of-one",
  accessMode: "public",
  supply: "1",
  priceEth: "0.1",
  maxPerTransaction: 1,
  maxPerWallet: 1,
  startsAt: null,
  endsAt: null,
  networkLabel: "Sepolia",
  payoutAddress: null,
  page: {},
};

test("agent draft client covers every Studio release type without wallet or publication methods", async () => {
  const { createKeelStudioAgentDraftClient, KEEL_STUDIO_RELEASE_TYPES } = await import(MODULE);
  const requests = [];
  const drafts = new Map();
  const client = createKeelStudioAgentDraftClient({
    studioUrl: "https://studio.example",
    grantToken: `keel_agent_${"a".repeat(48)}`,
    fetchImplementation: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const parsedUrl = new URL(url);
      if (init.method === "POST") {
        const draft = JSON.parse(init.body);
        const id = `release-${draft.releaseType}`;
        const saved = { ...draft, id, revision: 1, status: "draft", slug: id };
        drafts.set(id, saved);
        return Response.json(saved, { status: 201 });
      }
      const id = decodeURIComponent(parsedUrl.pathname.slice("/api/agent/drafts/".length));
      if (init.method === "PATCH") {
        const payload = JSON.parse(init.body);
        const current = drafts.get(id);
        assert.equal(payload.expectedRevision, current.revision);
        const saved = { ...payload.draft, id, revision: current.revision + 1, status: "draft", slug: id };
        drafts.set(id, saved);
        return Response.json(saved);
      }
      if (parsedUrl.pathname === "/api/agent/drafts") {
        return Response.json({ projects: [], releases: [...drafts.values()] });
      }
      return Response.json(drafts.get(id), { status: drafts.has(id) ? 200 : 404 });
    },
  });

  assert.deepEqual(Object.keys(client).sort(), ["create", "list", "read", "update"]);
  for (const releaseType of KEEL_STUDIO_RELEASE_TYPES) {
    const supply = releaseType === "open-edition" ? "open" : releaseType === "one-of-one" ? "1" : "100";
    const created = await client.create({ ...baseDraft, releaseType, supply, title: `Agent ${releaseType}` });
    const listed = await client.list();
    assert.equal(listed.releases.some((draft) => draft.id === created.id), true);
    const reopened = await client.read(created.id);
    assert.equal(reopened.releaseType, releaseType);
    const updated = await client.update(created.id, { ...reopened, title: `${reopened.title} revised` }, reopened.revision);
    assert.equal(updated.releaseType, releaseType);
    assert.equal(updated.revision, 2);
    assert.match(updated.title, /revised$/u);
  }
  assert.equal(requests.length, KEEL_STUDIO_RELEASE_TYPES.length * 4);
  assert.ok(requests.every(({ url }) => url.startsWith("https://studio.example/api/agent/drafts")));
  assert.ok(requests.every(({ init }) => new Headers(init.headers).get("authorization") === `Bearer keel_agent_${"a".repeat(48)}`));
});

test("agent draft client persists optimistic revisions and fails closed", async () => {
  const { createKeelStudioAgentDraftClient } = await import(MODULE);
  let payload;
  const client = createKeelStudioAgentDraftClient({
    studioUrl: "https://studio.example/base",
    grantToken: `keel_agent_${"b".repeat(48)}`,
    fetchImplementation: async (_url, init) => {
      payload = JSON.parse(init.body);
      return Response.json({ ...payload.draft, id: "release-1", revision: 2, status: "draft", slug: "renamed" });
    },
  });
  const updated = await client.update("release/1", { ...baseDraft, title: "Renamed" }, 1);
  assert.equal(updated.revision, 2);
  assert.equal(payload.expectedRevision, 1);
  await assert.rejects(client.update("release-1", baseDraft, 0), /positive integer/u);
  const insecure = createKeelStudioAgentDraftClient({ studioUrl: "http://studio.example", grantToken: "x".repeat(48) });
  await assert.rejects(insecure.list(), /HTTPS/u);

  const invalid = createKeelStudioAgentDraftClient({
    studioUrl: "https://studio.example",
    grantToken: "x".repeat(48),
    fetchImplementation: async () => new Response("broken", { status: 500 }),
  });
  await assert.rejects(invalid.list(), /HTTP 500 without JSON/u);

  const secret = `keel_agent_${"secret".repeat(8)}`;
  const hostile = createKeelStudioAgentDraftClient({
    studioUrl: "https://studio.example",
    grantToken: secret,
    fetchImplementation: async () => Response.json({ error: `invalid token ${secret}` }, { status: 401 }),
  });
  await assert.rejects(hostile.list(), (error) => {
    assert.match(error.message, /invalid token \[redacted\]/u);
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  });
});

test("agent draft operation config keeps stale edits and unsupported actions explicit", async () => {
  const { executeKeelStudioAgentDraftOperation } = await import(MODULE);
  const requests = [];
  const fetchImplementation = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (init.method === "POST") return Response.json({ ...JSON.parse(init.body), id: "release-json", revision: 1, status: "draft", slug: "release-json" }, { status: 201 });
    if (init.method === "PATCH") return Response.json({ ...JSON.parse(init.body).draft, id: "release-json", revision: 2, status: "draft", slug: "release-json" });
    return Response.json({ ...baseDraft, id: "release-json", revision: 1, status: "draft", slug: "release-json" });
  };
  const jsonConfig = {
    studioUrl: "http://127.0.0.1:43123",
    grantToken: `keel_agent_${"c".repeat(48)}`,
    operation: "create",
    draft: baseDraft,
  };
  const created = await executeKeelStudioAgentDraftOperation({ ...jsonConfig, fetchImplementation });
  assert.equal(created.id, "release-json");

  const editConfig = {
    ...jsonConfig,
    operation: "update",
    releaseId: "release-json",
    expectedRevision: 1,
    draft: { ...baseDraft, title: "Agent config edit" },
  };
  const edited = await executeKeelStudioAgentDraftOperation({ ...editConfig, fetchImplementation });
  assert.equal(edited.title, "Agent config edit");
  assert.equal(edited.revision, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ init }) => new Headers(init.headers).get("authorization")?.startsWith("Bearer keel_agent_") === true));

  const stale = { ...editConfig, fetchImplementation: async () => Response.json({ error: "Draft revision is stale." }, { status: 409 }) };
  await assert.rejects(executeKeelStudioAgentDraftOperation(stale), /stale/u);
  await assert.rejects(executeKeelStudioAgentDraftOperation({ ...editConfig, expectedRevision: undefined, fetchImplementation }), /positive integer/u);
  await assert.rejects(executeKeelStudioAgentDraftOperation({ ...jsonConfig, chainId: 11155111, fetchImplementation }), /not supported/u);
});

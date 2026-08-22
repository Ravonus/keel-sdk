import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  createIntegrity,
  encodeBase64,
  type ArtifactManifest,
  type ArtifactResource,
  type ResourceRole,
} from "@keel/protocol";
import { mountArtifact, resolveArtifact } from "@keel/viewer";
import "./site.css";

async function resource(
  id: string,
  role: ResourceRole,
  mediaType: string,
  text: string,
  executable = false,
): Promise<ArtifactResource> {
  const bytes = new TextEncoder().encode(text);
  return {
    id,
    role,
    mediaType,
    executable,
    sources: [
      {
        kind: "inline",
        data: encodeBase64(bytes),
        encoding: "base64",
        integrity: await createIntegrity(bytes),
      },
    ],
  };
}

async function createManifest(): Promise<ArtifactManifest> {
  const html = await resource(
    "viewer",
    "entrypoint",
    "text/html",
    `<main><canvas id="field"></canvas><img class="seal" src="/content/seal" alt="Verified artifact seal"><div class="copy"><small>CONTENT GRAPH 01</small><h1>Nothing here is merely a URL.</h1><p>Move your pointer through the field.</p></div><script type="module" src="/content/runtime"></script><link rel="stylesheet" href="/content/artifact-style">`,
    true,
  );
  const style = await resource(
    "artifact-style",
    "style",
    "text/css",
    `html,body,main{width:100%;height:100%;margin:0}body{overflow:hidden;background:#09090b;color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}main{position:relative}canvas{position:absolute;inset:0;width:100%;height:100%}.copy{position:absolute;left:7%;bottom:9%;max-width:560px;text-shadow:0 2px 22px #000}.copy small{letter-spacing:.24em;color:#ffb6c1}.copy h1{font:clamp(28px,6vw,72px)/.96 system-ui,sans-serif;letter-spacing:-.055em;margin:.18em 0}.copy p{opacity:.72}.seal{position:absolute;right:5%;top:6%;width:76px;height:76px;filter:drop-shadow(0 8px 30px #ffb6c166)}`,
  );
  const runtime = await resource(
    "runtime",
    "script",
    "text/javascript",
    `const c=document.querySelector('#field'),x=c.getContext('2d');let w=0,h=0,p={x:0,y:0},t=0;const dots=Array.from({length:110},(_,i)=>({a:i*2.399,r:20+(i%19)*13,s:.12+(i%7)*.025}));function size(){w=c.width=Math.floor(innerWidth*devicePixelRatio);h=c.height=Math.floor(innerHeight*devicePixelRatio);p.x||Object.assign(p,{x:w*.68,y:h*.42})}addEventListener('resize',size);addEventListener('pointermove',e=>Object.assign(p,{x:e.clientX*devicePixelRatio,y:e.clientY*devicePixelRatio}));size();function frame(){t+=.012;x.fillStyle='rgba(9,9,11,.15)';x.fillRect(0,0,w,h);for(const d of dots){const q=d.a+t*d.s,rr=d.r*devicePixelRatio+(Math.sin(t+d.a)+1)*18*devicePixelRatio,px=p.x+Math.cos(q)*rr,py=p.y+Math.sin(q*1.13)*rr;x.beginPath();x.arc(px,py,Math.max(1,2.2*devicePixelRatio*(1-d.r/300)),0,Math.PI*2);x.fillStyle='rgba(255,182,193,'+(0.18+0.55*(1-d.r/300))+')';x.fill()}requestAnimationFrame(frame)}frame();`,
    true,
  );
  const seal = await resource(
    "seal",
    "fallback",
    "image/svg+xml",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop stop-color="#ffb6c1"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><circle cx="50" cy="50" r="46" fill="#111" stroke="url(#g)" stroke-width="3"/><path d="M28 53l14 14 31-35" fill="none" stroke="url(#g)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );

  return {
    schema: KEEL_MANIFEST_SCHEMA,
    canonicalization: KEEL_CANONICALIZATION,
    id: "verified-field-01",
    name: "Verified Field 01",
    description: "A small interactive proof of the Keel resource graph and sandbox model.",
    entrypoint: { resource: "viewer", mode: "html" },
    resources: [html, style, runtime, seal],
    fallback: { image: "seal", animation: "viewer", backgroundColor: "#09090b" },
    runtime: {
      engine: {
        protocol: KEEL_RUNTIME_PROTOCOL,
        viewerProtocol: KEEL_VIEWER_PROTOCOL,
        renderer: "browser",
      },
      determinism: {
        mode: "replay",
        seed: "0xc3f9a8160fa9a07445c5ca49b59407c8a302a3ddf1246509bdad5b3003b96a24",
        randomAlgorithm: "xoshiro128ss",
        viewport: { width: 1280, height: 1280, devicePixelRatio: 1 },
        clock: { mode: "frame", epochMs: 1_786_060_800_000, frameDurationMs: 1000 / 60 },
        locale: "en-US",
        timezone: "UTC",
      },
      content: {
        protocol: KEEL_CONTENT_GATEWAY_PROTOCOL,
        mode: "verified-only",
        externalSources: "host-verified",
        manifestTrust: "digest",
        blockUndeclared: true,
        resourcePathPrefix: "/content/",
        onchainPathPrefix: "/onchain/",
        ipfsPathPrefix: "/ipfs/",
      },
      sandbox: "strict",
      capabilities: {},
      maxResourceBytes: 128_000,
      maxTotalBytes: 512_000,
      maxRecursionDepth: 8,
      maxResources: 16,
      timeoutMs: 8_000,
    },
    revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "immutable", frozen: true },
    provenance: { createdAt: "2026-08-07T00:00:00.000Z", creator: "Ravonus", license: "MIT" },
    attributes: [
      { trait_type: "Runtime", value: "Sandboxed HTML" },
      { trait_type: "Content Gateway", value: "Verified only" },
      { trait_type: "Resources", value: 4 },
    ],
  };
}

const viewer = document.querySelector<HTMLElement>("#viewer");
const auditBody = document.querySelector<HTMLTableSectionElement>("#audit");
const summary = document.querySelector<HTMLElement>("#summary");
const status = document.querySelector<HTMLElement>("#status");
const statusDot = document.querySelector<HTMLElement>("#status-dot");
if (!viewer || !auditBody || !summary || !status || !statusDot) throw new Error("Demo DOM is incomplete.");

try {
  const artifact = await resolveArtifact(await createManifest());
  mountArtifact(viewer, artifact, { title: artifact.manifest.name });
  status.textContent = "Verified and isolated";
  statusDot.classList.add("ok");
  summary.innerHTML = `<div><dt>Manifest</dt><dd>${artifact.manifest.schema}</dd></div><div><dt>Resources</dt><dd>${artifact.audit.resolvedResources}</dd></div><div><dt>Decoded bytes</dt><dd>${artifact.audit.totalBytes.toLocaleString()}</dd></div><div><dt>Same-origin</dt><dd>Denied</dd></div>`;
  for (const entry of artifact.audit.entries) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${entry.resourceId}</td><td>${entry.sourceKind}</td><td>${entry.status}</td><td>${entry.byteLength?.toLocaleString() ?? "—"}</td><td>${entry.integrityVerified ? "✓" : "—"}</td>`;
    auditBody.append(row);
  }
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  statusDot.classList.add("bad");
}

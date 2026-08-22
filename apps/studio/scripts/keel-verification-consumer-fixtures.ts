import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createIntegrity, utf8ToBytes, type Hex } from "@keel/protocol";

import {
  KEEL_STANDALONE_VIEWER_PROTOCOL,
  buildStandaloneKeelViewer,
  type KeelStandaloneViewerEnvelope,
  type KeelStandaloneViewerItem,
} from "./keel-viewer-builder";

export interface KeelVerificationConsumerCase {
  readonly id: string;
  readonly group: "module" | "integrity" | "state" | "api" | "contract-control";
  readonly title: string;
  readonly description: string;
  readonly expected: "verified" | "failed";
  readonly mutation: string;
  readonly file: string;
  readonly envelope: KeelStandaloneViewerEnvelope;
  readonly repairLabel?: string;
  readonly repairMutation?: string;
  readonly repairFile?: string;
  readonly repairEnvelope?: KeelStandaloneViewerEnvelope;
  readonly variants?: readonly KeelVerificationConsumerVariant[];
}

export interface KeelVerificationConsumerVariant {
  readonly id: string;
  readonly label: string;
  readonly authority: "token-owner" | "creator";
  readonly mutation: string;
  readonly file: string;
  readonly envelope: KeelStandaloneViewerEnvelope;
}

const text = (value: string): Uint8Array => utf8ToBytes(value);
const base64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

async function embeddedItem(input: {
  readonly id: string;
  readonly role: "entrypoint" | "module" | "asset" | "data";
  readonly mediaType: string;
  readonly aliases?: readonly string[];
  readonly bytes: Uint8Array;
  readonly committedBytes?: Uint8Array;
}): Promise<KeelStandaloneViewerItem> {
  const committed = input.committedBytes ?? input.bytes;
  return {
    id: input.id,
    role: input.role,
    mediaType: input.mediaType,
    aliases: input.aliases ?? [],
    integrity: await createIntegrity(committed),
    embedded: { storedBase64: base64(input.bytes), compression: "none" },
  };
}

const html = (body: string, script: string, extra = "") => text(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#stage{width:100%;height:100%;margin:0;overflow:hidden;background:#07101a;color:#eafff7;font-family:system-ui,sans-serif}#stage{display:grid;place-items:center;position:relative}canvas,img,video{display:block;width:100%;height:100%;object-fit:cover}.label{position:fixed;left:22px;top:20px;z-index:2;padding:8px 10px;border:1px solid #67f6c555;border-radius:999px;background:#04110ddd;color:#67f6c5;font:900 9px ui-monospace,monospace;letter-spacing:.12em}.state-card,#stage>p{max-width:min(72%,340px);margin:0;padding:24px;border:1px solid #67f6c555;border-radius:20px;background:#06131ddd;box-shadow:0 24px 70px #0008;text-align:center;font:800 15px/1.5 ui-monospace,monospace;letter-spacing:.08em}.state-card b{display:block;margin-top:8px;color:#67f6c5;font-size:24px}.canvas-copy{position:absolute;inset:auto 24px 24px;z-index:1;padding:12px 14px;border:1px solid #ffffff33;border-radius:14px;background:#030712c9;color:#fff;font:900 12px ui-monospace,monospace;letter-spacing:.1em;text-align:center;pointer-events:none}</style>${extra}</head><body><span class="label">CANONICAL KEEL SHELL CHILD</span><div id="stage">${body}</div><script type="module">${script}</script></body></html>`);

async function envelope(title: string, items: readonly KeelStandaloneViewerItem[], entrypoint: string, minimumCanvasCount = 0): Promise<KeelStandaloneViewerEnvelope> {
  return { protocol: KEEL_STANDALONE_VIEWER_PROTOCOL, title, deliveryProfile: "embedded-assembled", entrypoint, runtimeExpectations: { minimumCanvasCount }, items };
}

export async function createKeelVerificationConsumerCases(repositoryRoot: string): Promise<readonly KeelVerificationConsumerCase[]> {
  const demos = path.join(repositoryRoot, "examples/demos");
  const lab = path.join(demos, "keel-creative-lab");
  const [p5, threeCore, threeModule, image, video, vaultGame] = await Promise.all([
    readFile(path.join(demos, "vendor/p5.min.js")),
    readFile(path.join(demos, "vendor/three.core.min.js")),
    readFile(path.join(demos, "vendor/three.min.js")),
    readFile(path.join(lab, "assets/aurora-data-horizon-onchain-v1.webp")),
    readFile(path.join(lab, "assets/aurora-signal-loop-v1.webm")),
    readFile(path.join(demos, "vault-arcade/generated-attribute-proxy/vault-keel-viewer-bundled.html")),
  ]);

  type VariantInput = Omit<KeelVerificationConsumerVariant, "file">;
  type CaseInput = Omit<KeelVerificationConsumerCase, "file" | "repairFile" | "variants"> & { readonly variants?: readonly VariantInput[] };
  const cases: KeelVerificationConsumerCase[] = [];
  const push = (value: CaseInput) => cases.push({
    ...value,
    file: `${value.id}.html`,
    ...(value.repairEnvelope === undefined ? {} : { repairFile: `${value.id}-repaired.html` }),
    ...(value.variants === undefined ? {} : { variants: value.variants.map((variant) => ({ ...variant, file: `${value.id}-${variant.id}.html` })) }),
  });

  const scriptEntry = await embeddedItem({ id: "script-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<canvas id='art'></canvas>", `const c=document.querySelector('#art'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;const g=x.createLinearGradient(0,0,c.width,c.height);g.addColorStop(0,'#67f6c5');g.addColorStop(1,'#315cff');x.fillStyle=g;x.fillRect(0,0,c.width,c.height);document.body.dataset.module='classic-script';`) });
  push({ id: "classic-script", group: "module", title: "Locked ordinary JavaScript", description: "A normal canvas script executes only after its exact entrypoint bytes pass the shared verifier.", expected: "verified", mutation: "none", envelope: await envelope("Locked classic script", [scriptEntry], scriptEntry.id, 1) });

  const p5Item = await embeddedItem({ id: "p5-runtime", role: "module", mediaType: "text/javascript", aliases: ["keel://module/p5.js"], bytes: p5 });
  const p5Entry = await embeddedItem({ id: "p5-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<div class='canvas-copy'>TOKEN OWNER · P5 SCENE VARIABLES</div>", `Object.defineProperty(globalThis,'DeviceMotionEvent',{value:undefined,configurable:true});Object.defineProperty(globalThis,'DeviceOrientationEvent',{value:undefined,configurable:true});const state=await fetch('keel://data/p5-state').then(response=>response.json());if(state.protocol!=='keel-typed-state@1'||state.authority!=='token-owner'||state.valueKind!=='p5-scene-controls'||state.tokenId!==7||!/^#[0-9a-f]{6}$/i.test(state.background)||!/^#[0-9a-f]{6}$/i.test(state.stroke)||!Number.isInteger(state.ringCount)||state.ringCount<8||state.ringCount>96)throw new Error('Typed p5 scene state is invalid.');const lib=document.createElement('script');lib.src='keel://module/p5.js';lib.onload=()=>new p5(p=>{const paint=()=>{p.background(state.background);p.noFill();p.stroke(state.stroke);p.strokeWeight(2);for(let i=0;i<state.ringCount;i++)p.circle(p.width/2,p.height/2,18+i*(460/state.ringCount)+Math.sin(p.frameCount*.02+i)*8)};p.setup=()=>{const canvas=p.createCanvas(innerWidth,innerHeight);canvas.parent('stage');paint();document.body.dataset.assetReady='p5';document.body.dataset.stateRevision=String(state.revision)};p.draw=paint});lib.onerror=()=>{document.body.dataset.loadError='p5-runtime'};document.head.append(lib);`) });
  const p5State = async (id: string, background: string, stroke: string, ringCount: number, revision: number) => embeddedItem({ id: "p5-state", role: "data", mediaType: "application/json", aliases: ["keel://data/p5-state"], bytes: text(JSON.stringify({ protocol: "keel-typed-state@1", authority: "token-owner", tokenId: 7, valueKind: "p5-scene-controls", background, stroke, ringCount, revision, id })) });
  const p5Base = await p5State("minted", "#050914", "#67f6c5", 48, 1);
  const p5Sunset = await p5State("sunset", "#230918", "#ffc857", 28, 2);
  const p5Electric = await p5State("electric", "#08164a", "#ff66e5", 72, 3);
  push({ id: "p5", group: "module", title: "Pinned p5.js scene", description: "The real pinned p5.js runtime is verified, paints synchronously on setup, and consumes committed token-owner scene variables.", expected: "verified", mutation: "minted token-owner p5 controls", envelope: await envelope("Pinned p5.js", [p5Item, p5Base, p5Entry], p5Entry.id, 1), variants: [
    { id: "owner-sunset", label: "Owner · Sunset / 28 rings", authority: "token-owner", mutation: "same token; owner sets background, stroke, and ringCount at revision 2", envelope: await envelope("Pinned p5.js owner sunset", [p5Item, p5Sunset, p5Entry], p5Entry.id, 1) },
    { id: "owner-electric", label: "Owner · Electric / 72 rings", authority: "token-owner", mutation: "same token; owner sets background, stroke, and ringCount at revision 3", envelope: await envelope("Pinned p5.js owner electric", [p5Item, p5Electric, p5Entry], p5Entry.id, 1) },
  ] });

  const threeCoreItem = await embeddedItem({ id: "three-core", role: "module", mediaType: "text/javascript", aliases: ["/content/three.core.min.js"], bytes: threeCore });
  const threeModuleItem = await embeddedItem({ id: "three-runtime", role: "module", mediaType: "text/javascript", aliases: ["keel://module/three.js"], bytes: threeModule });
  const threeEntry = await embeddedItem({ id: "three-entry", role: "entrypoint", mediaType: "text/html", bytes: html("", `import * as THREE from 'keel://module/three.js';const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);document.querySelector('#stage').append(renderer.domElement);const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.1,100);camera.position.z=4;const mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(1.2,3),new THREE.MeshNormalMaterial());scene.add(mesh);renderer.setAnimationLoop(()=>{mesh.rotation.x+=.004;mesh.rotation.y+=.007;renderer.render(scene,camera)});`) });
  push({ id: "three", group: "module", title: "Pinned Three.js scene", description: "The real Three.js module and its core dependency are independently verified and then linked in memory.", expected: "verified", mutation: "none", envelope: await envelope("Pinned Three.js", [threeCoreItem, threeModuleItem, threeEntry], threeEntry.id, 1) });

  const imageItem = await embeddedItem({ id: "image", role: "asset", mediaType: "image/webp", aliases: ["keel://asset/image"], bytes: image });
  const imageEntry = await embeddedItem({ id: "image-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<img src='keel://asset/image' alt='Verified Keel image'>", `const image=document.querySelector('img');image.addEventListener('load',()=>document.body.dataset.assetReady='image');image.addEventListener('error',()=>document.body.dataset.loadError='image');`) });
  push({ id: "image", group: "module", title: "Image presentation module", description: "An image creator upload is placed behind the same verifier without asking the creator to write a shell.", expected: "verified", mutation: "none", envelope: await envelope("Verified image", [imageItem, imageEntry], imageEntry.id) });

  const videoItem = await embeddedItem({ id: "video", role: "asset", mediaType: "video/webm", aliases: ["keel://asset/video"], bytes: video });
  const videoEntry = await embeddedItem({ id: "video-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<video src='keel://asset/video' muted autoplay loop playsinline controls></video>", `const video=document.querySelector('video');video.addEventListener('loadeddata',()=>document.body.dataset.assetReady='video');video.addEventListener('error',()=>document.body.dataset.loadError='video');void video.play().catch(()=>undefined);`) });
  push({ id: "video", group: "module", title: "Video presentation module", description: "The WebM is verified as ordinary media and mounted by a community presentation module.", expected: "verified", mutation: "none", envelope: await envelope("Verified video", [videoItem, videoEntry], videoEntry.id) });

  const vaultGameSource = vaultGame.toString("utf8");
  const verificationRuntimeStart = vaultGameSource.indexOf("const verificationFixturesAllowed =");
  const gameRuntimeStart = vaultGameSource.indexOf("const seed = contextData?.derivedTokenSeed;", verificationRuntimeStart);
  if (verificationRuntimeStart < 0 || gameRuntimeStart < 0) throw new Error("Vault game presentation could not be separated from its legacy verifier runtime.");
  const vaultGameWithoutRuntime = `${vaultGameSource.slice(0, verificationRuntimeStart)}${vaultGameSource.slice(gameRuntimeStart)}`;
  const vaultGameFixtureSource = vaultGameWithoutRuntime
    .replace(/<script id="keel-verification-presentation" type="application\/json">[\s\S]*?<\/script>/u, "")
    .replace(/<div class="verify-corner"[\s\S]*?<section class="verify-alert"[\s\S]*?<\/section>/u, "")
    .replace("globalThis.__KEEL_CONTEXT__ == null\n    ? Object.keys(weaponAttributeCatalog.weapons)", "assetId === undefined\n    ? Object.keys(weaponAttributeCatalog.weapons)")
    .replace("if (!verificationReadyEmitted) { verificationReadyEmitted = true; verificationUI.ready(); }", "if (!verificationReadyEmitted) { verificationReadyEmitted = true; document.body.dataset.assetReady = 'vault-game'; }");
  if (vaultGameFixtureSource.includes("const verificationUI = mountVerificationUI") || vaultGameFixtureSource.includes('class="verify-corner"') || vaultGameFixtureSource === vaultGameSource) {
    throw new Error("Vault game fixture still contains a duplicate verification shell.");
  }
  const vaultGameEntry = await embeddedItem({ id: "vault-game-entry", role: "entrypoint", mediaType: "text/html", bytes: text(vaultGameFixtureSource) });
  push({ id: "vault-game", group: "module", title: "Vault game with mint-derived seed", description: "The actual bundled Vault game runs inside the shared shell. Target any token ID; the consumer resolves a different seed from that token's mint commitment, or an explicitly selected VRF/commit-reveal word.", expected: "verified", mutation: "target token and resolve current mint-bound seed", envelope: await envelope("Vault game token target", [vaultGameEntry], vaultGameEntry.id, 1) });

  const cssRevision = text(":root{--keel-css-revision:2}#stage{background:radial-gradient(circle at 35% 35%,#7fffd4 0,#214a75 28%,#070b18 72%)}#stage::after{content:'CREATOR CSS · AURORA';font:900 28px ui-monospace;color:#eafff7;letter-spacing:.08em}");
  const cssEmberRevision = text(":root{--keel-css-revision:3}#stage{background:linear-gradient(135deg,#14060c,#b63b24 55%,#ffbd4a)}#stage::after{content:'CREATOR CSS · EMBER';padding:24px;border:2px solid #fff6;border-radius:18px;font:900 28px ui-monospace;color:#fff;letter-spacing:.08em;box-shadow:0 24px 80px #0008}");
  const cssGridRevision = text(":root{--keel-css-revision:4}#stage{background-color:#080b12;background-image:linear-gradient(#72ffd622 1px,transparent 1px),linear-gradient(90deg,#72ffd622 1px,transparent 1px);background-size:34px 34px}#stage::after{content:'CREATOR CSS · GRID';padding:24px;background:#07101add;border:1px solid #72ffd6;font:900 28px ui-monospace;color:#72ffd6;letter-spacing:.08em}");
  const cssItem = await embeddedItem({ id: "creator-css", role: "module", mediaType: "text/css", aliases: ["keel://module/creator.css"], bytes: cssRevision });
  const cssEmberItem = await embeddedItem({ id: "creator-css", role: "module", mediaType: "text/css", aliases: ["keel://module/creator.css"], bytes: cssEmberRevision });
  const cssGridItem = await embeddedItem({ id: "creator-css", role: "module", mediaType: "text/css", aliases: ["keel://module/creator.css"], bytes: cssGridRevision });
  const cssEntry = await embeddedItem({ id: "creator-css-entry", role: "entrypoint", mediaType: "text/html", bytes: html("", `const response=await fetch('keel://module/creator.css');if((response.headers.get('content-type')||'').split(';')[0]!=='text/css')throw new Error('Creator CSS revision has the wrong media type.');const style=document.createElement('style');style.textContent=await response.text();document.head.append(style);document.body.dataset.resourceRevision=getComputedStyle(document.documentElement).getPropertyValue('--keel-css-revision').trim();document.body.dataset.assetReady='creator-css';`) });
  push({ id: "creator-css-revision", group: "state", title: "Creator CSS revision stays verified", description: "Only the committed CSS resource advances. The executable and verifier shell stay locked and are not repacked.", expected: "verified", mutation: "creator publishes committed CSS revision 2", envelope: await envelope("Creator CSS revision", [cssItem, cssEntry], cssEntry.id), variants: [
    { id: "creator-ember", label: "Creator · Ember CSS", authority: "creator", mutation: "same token and code; creator publishes committed CSS revision 3", envelope: await envelope("Creator CSS ember revision", [cssEmberItem, cssEntry], cssEntry.id) },
    { id: "creator-grid", label: "Creator · Grid CSS", authority: "creator", mutation: "same token and code; creator publishes committed CSS revision 4", envelope: await envelope("Creator CSS grid revision", [cssGridItem, cssEntry], cssEntry.id) },
  ] });

  const paletteState = text(JSON.stringify({ protocol: "keel-typed-state@1", authority: "token-owner", tokenId: 7, valueKind: "rgb24", value: "#72ffd6", revision: 2 }));
  const paletteItem = await embeddedItem({ id: "owner-palette", role: "data", mediaType: "application/json", aliases: ["keel://data/owner-palette"], bytes: paletteState });
  const paletteEntry = await embeddedItem({ id: "owner-palette-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<canvas id='palette'></canvas><div class='canvas-copy'>TOKEN OWNER · BACKGROUND COLOR</div>", `const state=await fetch('keel://data/owner-palette').then(response=>response.json());if(state.protocol!=='keel-typed-state@1'||state.authority!=='token-owner'||state.tokenId!==7||state.valueKind!=='rgb24'||!/^#[0-9a-f]{6}$/i.test(state.value))throw new Error('Typed token-owner state is invalid.');const c=document.querySelector('#palette'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;const gradient=x.createRadialGradient(c.width*.35,c.height*.3,10,c.width*.5,c.height*.5,c.width*.8);gradient.addColorStop(0,'#ffffff88');gradient.addColorStop(.22,state.value);gradient.addColorStop(1,'#030611');x.fillStyle=gradient;x.fillRect(0,0,c.width,c.height);document.body.dataset.typedState=String(state.revision);document.body.dataset.assetReady='owner-palette';`) });
  const paletteSunsetState = text(JSON.stringify({ protocol: "keel-typed-state@1", authority: "token-owner", tokenId: 7, valueKind: "rgb24", value: "#ff925c", revision: 3 }));
  const paletteVioletState = text(JSON.stringify({ protocol: "keel-typed-state@1", authority: "token-owner", tokenId: 7, valueKind: "rgb24", value: "#8d72ff", revision: 4 }));
  const paletteSunsetItem = await embeddedItem({ id: "owner-palette", role: "data", mediaType: "application/json", aliases: ["keel://data/owner-palette"], bytes: paletteSunsetState });
  const paletteVioletItem = await embeddedItem({ id: "owner-palette", role: "data", mediaType: "application/json", aliases: ["keel://data/owner-palette"], bytes: paletteVioletState });
  push({ id: "token-owner-palette", group: "state", title: "Token owner updates typed palette", description: "A token-owner RGB value changes live presentation state without granting authority to replace executable code.", expected: "verified", mutation: "token owner publishes rgb24 revision 2", envelope: await envelope("Token owner palette", [paletteItem, paletteEntry], paletteEntry.id, 1), variants: [
    { id: "owner-sunset", label: "Owner · Sunset background", authority: "token-owner", mutation: "same token; owner publishes rgb24 revision 3", envelope: await envelope("Token owner sunset palette", [paletteSunsetItem, paletteEntry], paletteEntry.id, 1) },
    { id: "owner-violet", label: "Owner · Violet background", authority: "token-owner", mutation: "same token; owner publishes rgb24 revision 4", envelope: await envelope("Token owner violet palette", [paletteVioletItem, paletteEntry], paletteEntry.id, 1) },
  ] });

  const unconfiguredStakeState = text(JSON.stringify({ protocol: "keel-staking-verification@1", configured: false, tokenId: 7 }));
  const unconfiguredStakeItem = await embeddedItem({ id: "staking-unconfigured", role: "data", mediaType: "application/json", aliases: ["keel://data/staking"], bytes: unconfiguredStakeState });
  const unconfiguredStakeEntry = await embeddedItem({ id: "staking-unconfigured-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<p>NO STAKING CLAIM</p>", `const state=await fetch('keel://data/staking').then(response=>response.json());if(state.protocol!=='keel-staking-verification@1'||state.configured!==false)throw new Error('Unconfigured staking status is invalid.');document.body.dataset.stakingClaim='none';`) });
  push({ id: "staking-adapter-unconfigured", group: "state", title: "No staking adapter, no staking claim", description: "Core integrity stays green. Without an explicitly configured adapter, Keel neither infers staking nor applies a staking-specific failure.", expected: "verified", mutation: "none; standard token ownership remains authoritative", envelope: await envelope("No staking claim", [unconfiguredStakeItem, unconfiguredStakeEntry], unconfiguredStakeEntry.id) });

  const lockedStakeState = text(JSON.stringify({ protocol: "keel-staking-verification@1", configured: true, adapter: "0xadapter", mode: "lock-updates-while-staked", staked: true, attemptedUpdate: "palette" }));
  const unlockedStakeState = text(JSON.stringify({ protocol: "keel-staking-verification@1", configured: true, adapter: "0xadapter", mode: "lock-updates-while-staked", staked: false, attemptedUpdate: "palette" }));
  const lockedStakeItem = await embeddedItem({ id: "staking-lock", role: "data", mediaType: "application/json", aliases: ["keel://data/staking"], bytes: lockedStakeState });
  const unlockedStakeItem = await embeddedItem({ id: "staking-lock", role: "data", mediaType: "application/json", aliases: ["keel://data/staking"], bytes: unlockedStakeState });
  const stakeLockEntryBytes = html("<canvas id='stake'></canvas>", `const state=await fetch('keel://data/staking').then(response=>response.json());if(state.protocol!=='keel-staking-verification@1'||state.configured!==true||state.mode!=='lock-updates-while-staked')throw new Error('Configured staking rule is invalid.');if(state.staked)throw new Error('Configured staking adapter reports staked; policy locks mutable updates.');const c=document.querySelector('#stake'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;x.fillStyle='#67f6c5';x.fillRect(0,0,c.width,c.height);document.body.dataset.stakingUpdate='accepted';`);
  const lockedStakeEntry = await embeddedItem({ id: "staking-lock-entry", role: "entrypoint", mediaType: "text/html", bytes: stakeLockEntryBytes });
  push({
    id: "staking-update-locked",
    group: "state",
    title: "Configured staking policy locks updates",
    description: "This rejection exists only because the creator explicitly configured a staking adapter and chose the lock-while-staked policy.",
    expected: "failed",
    mutation: "configured adapter reports staked=true",
    envelope: await envelope("Configured staking lock", [lockedStakeItem, lockedStakeEntry], lockedStakeEntry.id),
    repairLabel: "Report unstaked & recheck",
    repairMutation: "same token and policy; configured adapter now reports staked=false",
    repairEnvelope: await envelope("Configured staking lock repaired", [unlockedStakeItem, lockedStakeEntry], lockedStakeEntry.id, 1),
  });

  const delegatedStakeState = text(JSON.stringify({ protocol: "keel-staking-verification@1", configured: true, adapter: "0xadapter", mode: "controller-while-staked", staked: true, controller: "0xescrow", caller: "0xescrow", value: "#ffca72" }));
  const delegatedStakeItem = await embeddedItem({ id: "staking-controller", role: "data", mediaType: "application/json", aliases: ["keel://data/staking"], bytes: delegatedStakeState });
  const delegatedStakeEntry = await embeddedItem({ id: "staking-controller-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<canvas id='stake-controller'></canvas>", `const state=await fetch('keel://data/staking').then(response=>response.json());if(state.protocol!=='keel-staking-verification@1'||state.configured!==true||state.mode!=='controller-while-staked'||!state.staked||state.caller!==state.controller)throw new Error('Configured staking controller did not authorize this update.');const c=document.querySelector('#stake-controller'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;x.fillStyle=state.value;x.fillRect(0,0,c.width,c.height);`) });
  push({ id: "staking-controller-enabled", group: "state", title: "Configured adapter delegates update authority", description: "A separate opt-in policy may delegate token-owner updates to the controller returned by the configured staking adapter.", expected: "verified", mutation: "configured adapter reports escrow controller", envelope: await envelope("Configured staking controller", [delegatedStakeItem, delegatedStakeEntry], delegatedStakeEntry.id, 1) });

  const lockedCodeState = text(JSON.stringify({ protocol: "keel-code-lock@1", locked: true, committedDigest: `0x${"11".repeat(32)}`, attemptedDigest: `0x${"22".repeat(32)}` }));
  const acceptedCodeState = text(JSON.stringify({ protocol: "keel-code-lock@1", locked: true, committedDigest: `0x${"11".repeat(32)}`, attemptedDigest: `0x${"11".repeat(32)}` }));
  const lockedCodeItem = await embeddedItem({ id: "locked-code-state", role: "data", mediaType: "application/json", aliases: ["keel://data/code-lock"], bytes: lockedCodeState });
  const acceptedCodeItem = await embeddedItem({ id: "locked-code-state", role: "data", mediaType: "application/json", aliases: ["keel://data/code-lock"], bytes: acceptedCodeState });
  const lockedCodeEntry = await embeddedItem({ id: "locked-code-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<div class='state-card'>IMMUTABLE EXECUTABLE<b>COMMITTED CODE ACTIVE</b></div>", `const state=await fetch('keel://data/code-lock').then(response=>response.json());if(state.locked&&state.attemptedDigest!==state.committedDigest)throw new Error('Immutable executable revision rejected after code lock.');document.body.dataset.assetReady='committed-code';`) });
  push({ id: "immutable-code-revision", group: "state", title: "Locked executable cannot be revised", description: "A creator revision remains forbidden after the executable lock. CSS and typed state permissions do not weaken the code commitment.", expected: "failed", mutation: "creator attempts executable revision after lock", envelope: await envelope("Immutable executable rejection", [lockedCodeItem, lockedCodeEntry], lockedCodeEntry.id), repairLabel: "Use committed code & recheck", repairMutation: "same token; discard the replacement and resolve the committed executable", repairEnvelope: await envelope("Immutable executable restored", [acceptedCodeItem, lockedCodeEntry], lockedCodeEntry.id) });

  const enabledControlState = text(JSON.stringify({ protocol: "keel-contract-control@1", namespace: "palette", method: "setAccent", enabled: true, valueKind: "rgb24", value: "#76a8ff" }));
  const enabledControlItem = await embeddedItem({ id: "enabled-control", role: "data", mediaType: "application/json", aliases: ["keel://data/enabled-control"], bytes: enabledControlState });
  const enabledControlEntry = await embeddedItem({ id: "enabled-control-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<canvas id='custom'></canvas>", `const control=await fetch('keel://data/enabled-control').then(response=>response.json());if(control.protocol!=='keel-contract-control@1'||!control.enabled||control.namespace!=='palette'||control.method!=='setAccent'||control.valueKind!=='rgb24')throw new Error('Enabled custom contract control does not match its verifier manifest.');const c=document.querySelector('#custom'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;x.fillStyle=control.value;x.fillRect(0,0,c.width,c.height);`) });
  push({ id: "custom-contract-enabled", group: "contract-control", title: "Manifested custom contract control", description: "A custom method is accepted only because its namespace, method, value type, and enabled flag are committed by the viewer manifest.", expected: "verified", mutation: "enabled palette.setAccent(rgb24) call", envelope: await envelope("Enabled custom contract control", [enabledControlItem, enabledControlEntry], enabledControlEntry.id, 1) });

  const apiManifestDigest = (await createIntegrity(text('{"endpoint":"weather","mediaType":"application/json"}'))).digest;
  const apiValue = (sequence: number, mediaType: string, value: object, digest: Hex = apiManifestDigest) => JSON.stringify({ protocol: "keel-api-snapshot@1", mediaType, sequence, sourceManifestDigest: digest, value });
  const apiEntryBytes = (expectedSequence: number) => html("<canvas id='api'></canvas>", `const response=await fetch('keel://data/weather');const contentType=(response.headers.get('content-type')||'').split(';')[0];if(contentType!=='application/json')throw new Error('API snapshot format is not enabled by the Keel manifest.');const snapshot=await response.json();if(snapshot.protocol!=='keel-api-snapshot@1'||snapshot.sourceManifestDigest!==${JSON.stringify(apiManifestDigest)})throw new Error('API response is not committed by the enabled manifest.');if(snapshot.sequence<${expectedSequence})throw new Error('API snapshot sequence is stale.');const c=document.querySelector('#api'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;x.fillStyle='#07101d';x.fillRect(0,0,c.width,c.height);x.strokeStyle='#7fe7ff';for(let i=0;i<80;i++){x.beginPath();x.moveTo(0,i*13);x.lineTo(c.width,i*13+Number(snapshot.value.wind)*18);x.stroke()}`);
  async function apiCase(id: string, title: string, snapshot: string, mediaType: string, expected: "verified" | "failed", mutation: string, expectedSequence = 17, repair?: { readonly snapshot: string; readonly mediaType: string; readonly mutation: string }) {
    const data = await embeddedItem({ id: "weather", role: "data", mediaType, aliases: ["keel://data/weather"], bytes: text(snapshot) });
    const entry = await embeddedItem({ id: `${id}-entry`, role: "entrypoint", mediaType: "text/html", bytes: apiEntryBytes(expectedSequence) });
    const repairedData = repair === undefined ? undefined : await embeddedItem({ id: "weather", role: "data", mediaType: repair.mediaType, aliases: ["keel://data/weather"], bytes: text(repair.snapshot) });
    push({ id, group: "api", title, description: "The child accepts API data only when its media type, manifest digest, and monotonic sequence are committed.", expected, mutation, envelope: await envelope(title, [data, entry], entry.id, expected === "verified" ? 1 : 0), ...(repair === undefined || repairedData === undefined ? {} : { repairLabel: "Apply manifested value & recheck", repairMutation: repair.mutation, repairEnvelope: await envelope(`${title} repaired`, [repairedData, entry], entry.id, 1) }) });
  }
  await apiCase("api-verified", "Manifested API snapshot", apiValue(17, "application/json", { temperature: 21, wind: 3.4 }), "application/json", "verified", "none");
  await apiCase("api-wrong-format", "API returned the wrong format", apiValue(18, "text/plain", { temperature: 22, wind: 4.1 }), "text/plain", "failed", "media type application/json -> text/plain", 17, { snapshot: apiValue(18, "application/json", { temperature: 22, wind: 4.1 }), mediaType: "application/json", mutation: "same snapshot; serve the enabled application/json format" });
  await apiCase("api-uncommitted", "API output was not manifested", apiValue(18, "application/json", { temperature: 37, wind: 9.9 }, `0x${"00".repeat(32)}`), "application/json", "failed", "source manifest digest mismatch", 17, { snapshot: apiValue(18, "application/json", { temperature: 37, wind: 9.9 }), mediaType: "application/json", mutation: "same snapshot; bind it to the enabled source manifest digest" });
  await apiCase("api-stale", "API sequence did not advance", apiValue(17, "application/json", { temperature: 21, wind: 3.4 }), "application/json", "failed", "sequence 17 replayed while revision requires 18", 18, { snapshot: apiValue(18, "application/json", { temperature: 21, wind: 3.4 }), mediaType: "application/json", mutation: "same source; advance the committed sequence from 17 to 18" });

  const original = html("<p>These committed bytes should never be replaced.</p>", "document.body.dataset.module='integrity';");
  const tampered = html("<p>ATTACKER REPLACED THE COMMITTED BYTES.</p>", "document.body.dataset.module='integrity';");
  const tamperedEntry = await embeddedItem({ id: "tampered-entry", role: "entrypoint", mediaType: "text/html", bytes: tampered, committedBytes: original });
  const restoredEntry = await embeddedItem({ id: "tampered-entry", role: "entrypoint", mediaType: "text/html", bytes: original });
  push({ id: "integrity-tampered", group: "integrity", title: "Committed HTML bytes were changed", description: "The carrier still returns bytes, but their SHA-256 no longer matches the viewer item.", expected: "failed", mutation: "entrypoint bytes changed after commitment", envelope: await envelope("Tampered carrier", [tamperedEntry], tamperedEntry.id), repairLabel: "Restore committed bytes & recheck", repairMutation: "same token; restore the exact committed entrypoint bytes", repairEnvelope: await envelope("Restored committed carrier", [restoredEntry], restoredEntry.id) });

  const disabledEntry = await embeddedItem({ id: "disabled-entry", role: "entrypoint", mediaType: "text/html", bytes: html("<p>Unsupported custom contract control</p>", `throw new Error('Verifier API not enabled for this contract control; no verifier receipt is being claimed.');`) });
  push({ id: "verifier-api-disabled", group: "contract-control", title: "Custom contract API was not enabled", description: "Unknown contract behavior cannot manufacture a green receipt. The shell fails with an explicit not-enabled verdict.", expected: "failed", mutation: "unsupported contract control", envelope: await envelope("Unsupported verifier API", [disabledEntry], disabledEntry.id), repairLabel: "Enable manifested API & recheck", repairMutation: "same token; enable the committed palette.setAccent(rgb24) verifier contract", repairEnvelope: await envelope("Enabled custom contract control", [enabledControlItem, enabledControlEntry], enabledControlEntry.id, 1) });

  return cases;
}

export async function buildKeelVerificationConsumerFixtures(input: { readonly repositoryRoot: string; readonly outputDirectory: string }) {
  const cases = await createKeelVerificationConsumerCases(input.repositoryRoot);
  const sourceDirectory = path.join(input.repositoryRoot, "examples/demos/keel-verification-consumer");
  const viewersDirectory = path.join(input.outputDirectory, "viewers");
  await mkdir(viewersDirectory, { recursive: true });
  await Promise.all(["index.html", "styles.css", "app.js"].map(async (name) => writeFile(path.join(input.outputDirectory, name), await readFile(path.join(sourceDirectory, name)))));
  const receipts=[];
  for (const item of cases) {
    const built=await buildStandaloneKeelViewer({repositoryRoot:input.repositoryRoot,envelope:item.envelope});
    await writeFile(path.join(viewersDirectory,item.file),built.html);
    let repairReceipt;
    if(item.repairEnvelope!==undefined&&item.repairFile!==undefined){const repaired=await buildStandaloneKeelViewer({repositoryRoot:input.repositoryRoot,envelope:item.repairEnvelope});await writeFile(path.join(viewersDirectory,item.repairFile),repaired.html);repairReceipt={file:item.repairFile,sha256:repaired.htmlIntegrity.digest,byteLength:repaired.htmlIntegrity.byteLength}}
    const variantReceipts=[];
    for(const variant of item.variants??[]){const variantBuild=await buildStandaloneKeelViewer({repositoryRoot:input.repositoryRoot,envelope:variant.envelope});await writeFile(path.join(viewersDirectory,variant.file),variantBuild.html);variantReceipts.push({id:variant.id,file:variant.file,sha256:variantBuild.htmlIntegrity.digest,byteLength:variantBuild.htmlIntegrity.byteLength})}
    receipts.push({id:item.id,file:item.file,expected:item.expected,sha256:built.htmlIntegrity.digest,byteLength:built.htmlIntegrity.byteLength,...(repairReceipt===undefined?{}:{repair:repairReceipt}),...(variantReceipts.length===0?{}:{variants:variantReceipts})});
  }
  const output={schema:"keel-verification-consumer-matrix@1",chainProof:{evm:{label:"Forge policy, mint-seed registry, and optional-staking-adapter tests",test:"packages/contracts/test/KeelPresentationStateRegistry.t.sol + KeelSeedRegistry.t.sol"},tezos:{label:"SmartPy policy, commit-reveal seed, and optional-staking-adapter tests",test:"packages/tezos/tests/test_keel_presentation_state.py + test_vault.py"}},cases:cases.map(({envelope:_envelope,repairEnvelope:_repairEnvelope,variants,...item})=>({...item,...(variants===undefined?{}:{variants:variants.map(({envelope:_variantEnvelope,...variant})=>variant)})})),receipts};
  await writeFile(path.join(input.outputDirectory,"cases.json"),`${JSON.stringify(output,null,2)}\n`);
  return output;
}

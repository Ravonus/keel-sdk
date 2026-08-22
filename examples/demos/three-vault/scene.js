// Vault Of The Fallen — a procedural three.js chamber for the Keel demo gallery.
//
// three.js itself is an ordinary manifest resource: the sandbox imports it from
// /content/three.min.js only after its declared SHA-256 matches the bytes returned by
// the gateway. This is the artifact behind the whitepaper's storage claim —
// a full 3D library, committed on chain and verified byte-for-byte.

import * as THREE from "/content/three.min.js";

const SEED = (globalThis.OCA_SEED ?? 0x5f3a91c7) >>> 0;
const TOKEN_ID = globalThis.__KEEL_CONTEXT__?.tokenId ?? "preview";

function makeRandom(seed) {
  let state = (seed ^ 0x6d2b79f5) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = makeRandom(SEED);
const hue = rand();
const accentHue = (hue + 0.43 + rand() * 0.12) % 1;
const orbitDirection = rand() > 0.5 ? 1 : -1;
const chamberShape = Math.floor(rand() * 4);
const pillarCount = 42 + Math.floor(rand() * 79);

const color = (h, saturation, lightness) =>
  new THREE.Color().setHSL((h + 1) % 1, saturation, lightness);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById("stage").appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = color(hue, 0.72, 0.035);
scene.fog = new THREE.FogExp2(color(hue + 0.035, 0.78, 0.065), 0.042 + rand() * 0.036);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 120);
const cameraRadius = 8 + rand() * 5;
camera.position.set(0, 2.1 + rand() * 2.3, cameraRadius);

// --- Vault floor -----------------------------------------------------------
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(90, 90, 1, 1),
  new THREE.MeshStandardMaterial({
    color: color(hue + 0.015, 0.58, 0.09),
    roughness: 0.65,
    metalness: 0.3,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -2.2;
scene.add(floor);

const grid = new THREE.GridHelper(90, 60, color(accentHue, 0.96, 0.63), color(hue, 0.65, 0.18));
grid.position.y = -2.19;
scene.add(grid);

// --- Procedural pillars ----------------------------------------------------
// Each vault is generated from the seed, so the same token always descends
// into the same chamber.
const pillars = new THREE.Group();
const pillarGeometry = new THREE.BoxGeometry(1, 1, 1);
for (let i = 0; i < pillarCount; i += 1) {
  const height = 1.5 + rand() * 7;
  const material = new THREE.MeshStandardMaterial({
    color: color(hue + (rand() - 0.5) * 0.22, 0.62 + rand() * 0.28, 0.13 + rand() * 0.27),
    roughness: 0.4,
    metalness: 0.65,
    emissive: color(accentHue + (rand() - 0.5) * 0.08, 0.92, 0.045 + rand() * 0.085),
  });
  const pillar = new THREE.Mesh(pillarGeometry, material);
  const angle = rand() * Math.PI * 2;
  const radius = 4.5 + rand() * (16 + chamberShape * 4);
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  pillar.position.set(
    chamberShape === 1 ? Math.round(x / 3) * 3 : x,
    -2.2 + height / 2,
    chamberShape === 2 ? Math.round(z / 3) * 3 : z,
  );
  pillar.scale.set(0.6 + rand() * 1.5, height, 0.6 + rand() * 1.5);
  pillars.add(pillar);
}
scene.add(pillars);

// --- The relic -------------------------------------------------------------
const relicGeometries = [
  new THREE.IcosahedronGeometry(1.45, 0),
  new THREE.DodecahedronGeometry(1.35, 0),
  new THREE.TorusKnotGeometry(0.92, 0.34, 96, 12, 2, 3),
  new THREE.OctahedronGeometry(1.55, 1),
];
const relic = new THREE.Mesh(
  relicGeometries[chamberShape],
  new THREE.MeshStandardMaterial({
    color: color(accentHue, 0.82, 0.68),
    emissive: color(accentHue, 0.96, 0.38),
    emissiveIntensity: 0.75,
    roughness: 0.18,
    metalness: 0.95,
    flatShading: true,
  }),
);
relic.position.y = 0.6;
scene.add(relic);

const halo = new THREE.Mesh(
  new THREE.TorusGeometry(2.5, 0.035, 8, 120),
  new THREE.MeshBasicMaterial({ color: color(hue + 0.5, 0.96, 0.66) }),
);
halo.rotation.x = Math.PI / 2;
halo.position.y = 0.6;
scene.add(halo);

// --- Lighting --------------------------------------------------------------
scene.add(new THREE.AmbientLight(color(hue, 0.48, 0.42), 1.1));
const key = new THREE.PointLight(color(accentHue, 0.98, 0.63), 90, 40, 2);
key.position.set(0, 5, 0);
scene.add(key);
const rim = new THREE.PointLight(color(hue + 0.5, 0.98, 0.64), 55, 45, 2);
rim.position.set(-9, 3, -7);
scene.add(rim);

// --- Frame loop ------------------------------------------------------------
let frame = 0;
const plate = document.getElementById("plate");
if (plate) {
  plate.querySelector("small").textContent = `TOKEN #${TOKEN_ID} · SEED ${SEED.toString(16).padStart(8, "0")}`;
  plate.querySelector("strong").textContent = ["Crystal Vault", "Grid Citadel", "Knot Cathedral", "Octa Shrine"][chamberShape];
  plate.querySelector("span").textContent = `${pillarCount} seeded pillars · palette ${Math.round(hue * 360)}° · immutable Three.js viewer`;
}
renderer.setAnimationLoop(() => {
  frame += 1;
  const t = frame / 60;

  relic.rotation.x = t * 0.5;
  relic.rotation.y = t * 0.8;
  relic.position.y = 0.6 + Math.sin(t * 1.6) * 0.28;

  halo.rotation.z = t * 0.6;
  halo.position.y = relic.position.y;

  key.intensity = 78 + Math.sin(t * 3.1) * 22;

  camera.position.x = Math.sin(t * 0.14 * orbitDirection) * cameraRadius;
  camera.position.z = Math.cos(t * 0.14 * orbitDirection) * cameraRadius;
  camera.lookAt(0, 0.4, 0);

  renderer.render(scene, camera);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

import * as THREE from "/content/libraries/three.module.mjs";

const context = globalThis.__OCA_CONTEXT__ ?? {};
const tokenId = String(context.tokenId ?? "preview");
const seedHex = context.derivedTokenSeed ?? "0x7a31e5c9";
const seed = Number.parseInt(seedHex.slice(-8), 16) >>> 0;
const model = await fetch("/content/assets/model.json").then((response) => response.json());

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color().setHSL((seed % 360) / 360, 0.45, 0.055);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.6, 6);

const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.Float32BufferAttribute(model.positions, 3));
geometry.setIndex(model.indices);
geometry.computeVertexNormals();
const material = new THREE.MeshStandardMaterial({
  color: new THREE.Color().setHSL(((seed >>> 8) % 360) / 360, 0.78, 0.58),
  roughness: 0.25,
  metalness: 0.72,
  flatShading: true,
});
const artifact = new THREE.Mesh(geometry, material);
scene.add(artifact);
scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x241333, 2.4));
const key = new THREE.PointLight(0xff72cc, 48, 20);
key.position.set(3, 4, 4);
scene.add(key);

document.getElementById("label").textContent = `TOKEN #${tokenId} · CUSTOM MODEL · SEED ${seedHex.slice(-8)}`;
renderer.setAnimationLoop((time) => {
  artifact.rotation.y = time * 0.00035 * (seed & 1 ? 1 : -1);
  artifact.rotation.x = Math.sin(time * 0.00022) * 0.22;
  renderer.render(scene, camera);
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

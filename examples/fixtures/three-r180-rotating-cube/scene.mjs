import * as THREE from "/content/three.module.min.js";

const proof = { revision: THREE.REVISION, frames: 0, renderCalls: 0, network: "denied" };
globalThis.__keelThreeR180Fixture = proof;
const harness = globalThis.__keelThreeR180Harness ?? { errors: ["fixture probe did not initialize"] };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#090b11");
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.z = 3;

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({ color: "#49d8ff", metalness: 0.45, roughness: 0.28 }),
);
scene.add(cube, new THREE.HemisphereLight("#c5eaff", "#07111f", 2));

function render(time) {
  const size = Math.max(1, Math.min(innerWidth, innerHeight));
  renderer.setSize(size, size, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  cube.rotation.set(time / 1300, time / 1800, time / 2400);
  renderer.render(scene, camera);
  proof.frames += 1;
  proof.renderCalls = renderer.info.render.calls;
  if (proof.frames === 2) {
    const result = document.createElement("output");
    result.id = "keel-three-r180-proof";
    result.hidden = true;
    result.textContent = JSON.stringify({ ...proof, errors: harness.errors });
    document.body.append(result);
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

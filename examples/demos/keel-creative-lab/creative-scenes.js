const input = globalThis.__KEEL_SCENE_INPUT__ ?? { scene: "p5-one", seed: 4078, background: "#090819", accent: "#ff5fba" };

function randomFactory(seed) {
  let state = (seed ^ 0x6d2b79f5) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function mountP5Scene() {
  const fixed = input.scene === "p5-one";
  const editable = input.scene === "p5-edit";
  const imageScene = input.scene === "p5-image-onchain" || input.scene === "p5-image-hybrid";
  const seed = fixed ? 0x51a7f10d : input.seed;
  const rand = randomFactory(seed);
  new globalThis.p5((p) => {
    const points = Array.from({ length: editable ? 220 : 420 }, () => ({
      x: rand(), y: rand(), phase: rand() * Math.PI * 2, speed: .25 + rand() * .75,
    }));
    let verifiedImage;
    p.preload = () => {
      if (!imageScene) return;
      verifiedImage = p.loadImage(
        input.assetUri,
        undefined,
        () => { document.body.dataset.loadError = `image:${input.assetId ?? "unknown"}`; },
      );
    };
    p.setup = () => {
      const canvas = p.createCanvas(innerWidth, innerHeight);
      canvas.parent("stage");
      p.pixelDensity(Math.min(devicePixelRatio, 2));
      p.noFill();
    };
    p.draw = () => {
      p.background(input.background);
      if (imageScene && verifiedImage) {
        const imageRatio = verifiedImage.width / verifiedImage.height;
        const viewportRatio = p.width / p.height;
        const width = viewportRatio > imageRatio ? p.width : p.height * imageRatio;
        const height = viewportRatio > imageRatio ? p.width / imageRatio : p.height;
        p.image(verifiedImage, (p.width - width) / 2, (p.height - height) / 2, width, height);
        p.fill(4, 7, 18, 78);
        p.noStroke();
        p.rect(0, 0, p.width, p.height);
        const time = p.frameCount / 60;
        p.noFill();
        p.stroke(input.accent);
        for (let index = 0; index < 96; index += 1) {
          const point = points[index];
          const radius = 2 + 14 * (.5 + .5 * Math.sin(point.phase + time * point.speed));
          p.circle(point.x * p.width, point.y * p.height, radius);
        }
        return;
      }
      const accent = p.color(input.accent);
      p.stroke(p.red(accent), p.green(accent), p.blue(accent), editable ? 120 : 72);
      const time = p.frameCount / 60;
      if (input.scene === "p5-seeded") {
        p.strokeWeight(1.15);
        for (const point of points) {
          const x = point.x * p.width;
          const y = point.y * p.height;
          const radius = 10 + 90 * (.5 + .5 * Math.sin(point.phase + time * point.speed));
          p.arc(x, y, radius, radius, point.phase, point.phase + Math.PI * 1.2);
        }
      } else if (editable) {
        p.translate(p.width / 2, p.height / 2);
        for (let index = 0; index < 180; index += 1) {
          const t = index / 180 * Math.PI * 2;
          const pulse = 120 + Math.sin(t * 7 + time * 1.4) * 42;
          p.line(Math.cos(t) * 28, Math.sin(t) * 28, Math.cos(t) * pulse, Math.sin(t) * pulse);
        }
      } else {
        p.translate(p.width / 2, p.height / 2);
        p.strokeWeight(1.25);
        for (let ring = 0; ring < 72; ring += 1) {
          const radius = 26 + ring * 5.6;
          const start = time * .12 + ring * .29;
          p.arc(0, 0, radius, radius, start, start + Math.PI * (0.4 + (ring % 7) / 9));
        }
      }
    };
    p.windowResized = () => p.resizeCanvas(innerWidth, innerHeight);
  });
}

export function mountThreeScene(THREE) {
  const fixed = input.scene === "three-one";
  const editable = input.scene === "three-edit";
  const textureScene = input.scene === "three-texture-onchain" || input.scene === "three-texture-hybrid" || input.scene === "three-mixed";
  const heavyScene = input.scene === "three-heavy" || input.scene === "three-mixed";
  const rand = randomFactory(fixed ? 0x715a9e3d : input.seed);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.querySelector("#stage").appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(input.background);
  scene.fog = new THREE.FogExp2(input.background, editable ? .035 : .055);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, .1, 100);
  camera.position.set(0, 2.8, 10);
  const group = new THREE.Group();
  scene.add(group);
  const material = new THREE.MeshStandardMaterial({ color: input.accent, emissive: input.accent, emissiveIntensity: .22, metalness: .82, roughness: .24 });
  if (textureScene) {
    new THREE.TextureLoader().load(
      input.assetUri,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(input.scene === "three-mixed" ? 3 : 1, input.scene === "three-mixed" ? 3 : 1);
        material.map = texture;
        material.needsUpdate = true;
        document.body.dataset.textureReady = input.assetId ?? "verified";
      },
      undefined,
      () => { document.body.dataset.loadError = `texture:${input.assetId ?? "unknown"}`; },
    );
  }
  if (heavyScene) {
    const count = input.scene === "three-mixed" ? 1400 : 3200;
    const geometry = new THREE.IcosahedronGeometry(input.scene === "three-mixed" ? .12 : .08, 0);
    const instances = new THREE.InstancedMesh(geometry, material, count);
    const transform = new THREE.Object3D();
    for (let index = 0; index < count; index += 1) {
      const angle = rand() * Math.PI * 2;
      const radius = 1.5 + Math.pow(rand(), .52) * 8;
      transform.position.set(Math.cos(angle) * radius, (rand() - .5) * 8, Math.sin(angle) * radius);
      const scale = .45 + rand() * 2.2;
      transform.scale.setScalar(scale);
      transform.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      transform.updateMatrix();
      instances.setMatrixAt(index, transform.matrix);
    }
    group.add(instances);
  }
  const count = input.scene === "three-seeded" ? 72 : editable ? 38 : 24;
  for (let index = 0; index < (heavyScene ? 0 : count); index += 1) {
    const geometry = fixed
      ? new THREE.TorusGeometry(.35 + (index % 4) * .07, .08, 8, 28)
      : editable
        ? new THREE.IcosahedronGeometry(.24 + rand() * .42, index % 3 === 0 ? 1 : 0)
        : new THREE.OctahedronGeometry(.22 + rand() * .36, 0);
    const mesh = new THREE.Mesh(geometry, material.clone());
    const angle = index / count * Math.PI * 2 + rand() * .2;
    const radius = fixed ? 2.2 + (index % 6) * .42 : 1.4 + rand() * 5.2;
    mesh.position.set(Math.cos(angle) * radius, (rand() - .5) * (editable ? 5 : 3), Math.sin(angle) * radius);
    mesh.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
    group.add(mesh);
  }
  scene.add(new THREE.AmbientLight(0xffffff, .75));
  const light = new THREE.PointLight(input.accent, 85, 40, 2);
  light.position.set(2, 5, 4);
  scene.add(light);
  let frame = 0;
  renderer.setAnimationLoop(() => {
    frame += 1;
    const t = frame / 60;
    group.rotation.y = t * (fixed ? .14 : .22);
    group.rotation.x = Math.sin(t * .23) * .18;
    for (let index = 0; index < group.children.length; index += 1) {
      const mesh = group.children[index];
      mesh.rotation.x += .002 + (index % 7) * .0003;
      mesh.rotation.z += .003;
    }
    camera.position.x = Math.sin(t * .12) * 3.2;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

export function mountImageScene() {
  const image = document.createElement("img");
  image.src = input.assetUri;
  image.alt = "Verified Aurora Keel image presentation";
  image.decoding = "async";
  image.style.cssText = "width:100%;height:100%;display:block;object-fit:cover";
  image.addEventListener("load", () => { document.body.dataset.imageReady = input.assetId ?? "verified"; });
  image.addEventListener("error", () => { document.body.dataset.loadError = `image:${input.assetId ?? "unknown"}`; });
  document.querySelector("#stage").replaceChildren(image);
}

export function mountVideoScene() {
  const video = document.createElement("video");
  video.src = input.assetUri;
  video.loop = true;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.controls = true;
  video.style.cssText = "width:100%;height:100%;display:block;object-fit:cover";
  video.addEventListener("loadeddata", () => { document.body.dataset.videoReady = input.assetId ?? "verified"; });
  video.addEventListener("error", () => { document.body.dataset.loadError = `video:${input.assetId ?? "unknown"}`; });
  document.querySelector("#stage").replaceChildren(video);
  void video.play().catch(() => undefined);
}

export function mountClassicScriptScene() {
  const stage = document.querySelector("#stage");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  stage.replaceChildren(canvas);
  const rand = randomFactory(input.seed);
  const phases = Array.from({ length: 84 }, () => rand() * Math.PI * 2);
  let frame = 0;
  const render = () => {
    canvas.width = innerWidth * Math.min(devicePixelRatio, 2);
    canvas.height = innerHeight * Math.min(devicePixelRatio, 2);
    context.setTransform(canvas.width / innerWidth, 0, 0, canvas.height / innerHeight, 0, 0);
    context.fillStyle = input.background;
    context.fillRect(0, 0, innerWidth, innerHeight);
    context.strokeStyle = input.accent;
    context.globalAlpha = .74;
    context.lineWidth = 1.2;
    const time = frame / 60;
    for (let index = 0; index < phases.length; index += 1) {
      const angle = index / phases.length * Math.PI * 2;
      const radius = 42 + index * 3 + Math.sin(time + phases[index]) * 24;
      context.beginPath();
      context.arc(innerWidth / 2, innerHeight / 2, radius, angle + time * .08, angle + 1.4);
      context.stroke();
    }
    frame += 1;
    requestAnimationFrame(render);
  };
  document.body.dataset.classicScriptReady = "locked-code";
  render();
}

export function mountApiWeatherScene() {
  const snapshot = input.apiSnapshot;
  if (!snapshot || snapshot.protocol !== "keel-api-snapshot@1" || snapshot.mediaType !== "application/json") {
    document.body.dataset.loadError = "api:manifest-not-enabled";
    throw new Error("API snapshot format is not enabled by the Keel manifest.");
  }
  const stage = document.querySelector("#stage");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  stage.replaceChildren(canvas);
  const render = () => {
    canvas.width = innerWidth * Math.min(devicePixelRatio, 2);
    canvas.height = innerHeight * Math.min(devicePixelRatio, 2);
    context.setTransform(canvas.width / innerWidth, 0, 0, canvas.height / innerHeight, 0, 0);
    const temperature = Number(snapshot.value.temperature);
    const wind = Number(snapshot.value.wind);
    context.fillStyle = input.background;
    context.fillRect(0, 0, innerWidth, innerHeight);
    context.strokeStyle = input.accent;
    context.globalAlpha = .65;
    for (let line = 0; line < 90; line += 1) {
      const y = line / 90 * innerHeight;
      context.beginPath();
      for (let x = 0; x <= innerWidth; x += 14) {
        const offset = Math.sin(x * .01 + line * .16 + wind) * (8 + temperature * .25);
        if (x === 0) context.moveTo(x, y + offset);
        else context.lineTo(x, y + offset);
      }
      context.stroke();
    }
  };
  addEventListener("resize", render);
  document.body.dataset.apiSnapshotReady = String(snapshot.sequence);
  render();
}

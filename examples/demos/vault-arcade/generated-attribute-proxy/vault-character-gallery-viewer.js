import {
  ORB_LIGHT_STYLES,
  ORB_METAL_PALETTES,
  ORB_PORT_LIGHTS,
  ORB_SKIN_STYLES,
  ORB_VISOR_PALETTES,
  paintOrbMaterialAtlas,
} from "/content/orb-materials.mjs";
import {
  materialBuildFromPackedAttributes,
  materializeWeaponFrame,
  weaponMaterialLedger,
} from "/content/weapon-material-runtime.mjs";
import {
  VAULT_WEAPON_COMBAT_RULES,
  createVaultWeaponProjectileVolley,
  rollVaultWeapon,
  vaultGyroFrameIndex,
  updateVaultGyroProjectile,
  vaultWeaponProjectileDamageScale,
} from "/content/vault-combat-shared.mjs";

const WALLET_EXTENSION_ERROR = /(?:failed to connect to metamask|metamask|ethereum provider|wallet extension)/iu;
const errorText = (value) => value instanceof Error ? value.message : String(value ?? "Unknown preview error");
addEventListener("error", (event) => {
  if (WALLET_EXTENSION_ERROR.test(errorText(event.error ?? event.message))) event.preventDefault();
}, true);
addEventListener("unhandledrejection", (event) => {
  if (WALLET_EXTENSION_ERROR.test(errorText(event.reason))) event.preventDefault();
});

const fail = (error) => {
  document.documentElement.dataset.vaultGalleryState = "failed";
  document.documentElement.dataset.vaultGalleryError = errorText(error).slice(0, 180);
  parent.postMessage({ protocol: "keel-viewer-verification@1", action: "preview-failed" }, "*");
};

try {
  // Match the full viewer/game host contract. The runtime envelope is the
  // canonical injection path; the legacy global remains a compatibility
  // fallback for static gallery embeds.
  const contextData = globalThis.__KEEL_RUNTIME__?.context ?? globalThis.__KEEL_CONTEXT__;
  const seed = contextData?.derivedTokenSeed;
  const packedAttributes = contextData?.packedAttributes;
  const assetId = contextData?.assetId?.toLowerCase();
  if (typeof seed !== "string" || !/^0x[0-9a-f]{64}$/iu.test(seed)) throw new Error("Missing committed character seed");
  if (typeof packedAttributes !== "string" || !/^0x[0-9a-f]{64}$/iu.test(packedAttributes)) throw new Error("Missing committed character attributes");
  if (typeof assetId !== "string" || !/^0x[0-9a-f]{64}$/iu.test(assetId)) throw new Error("Missing committed weapon asset");

  const attributeBytes = Array.from(
    { length: 32 },
    (_, index) => Number.parseInt(packedAttributes.slice(2 + (31 - index) * 2, 4 + (31 - index) * 2), 16),
  );
  const choose = (values, index) => values[attributeBytes[index] % values.length];
  const appearance = Object.freeze({
    shell: choose(["gunmetal", "gold", "copper", "chrome", "obsidian", "pearl"], 1),
    visor: choose(["matched", "glass", "ruby", "sapphire", "brass", "ceramic", "prism"], 2),
    coreLight: choose(["cyan", "amber", "magenta", "white", "plasma", "aurora", "eclipse", "starfire"], 3),
    rearLight: choose(["utility", "dormant", "linked-light", "titanium", "reactor", "ion", "hazard", "void"], 4),
    skin: choose(["metal", "brushed", "battle-worn", "polished", "oxidized", "prism-light"], 5),
  });
  const [weaponCatalog, weaponLayouts, weaponRegionOverrides, vaultGameAtlas] = await Promise.all([
    fetch("/content/weapon-attributes.json").then((response) => response.json()),
    fetch("/content/weapon-region-layouts.json").then((response) => response.json()),
    fetch("/content/weapon-region-overrides.json").then((response) => response.json()),
    fetch("/content/vault-game-atlas.json").then((response) => response.json()),
  ]);
  const weaponId = Object.entries(weaponCatalog.weapons).find(([, definition]) => definition.assetId?.toLowerCase() === assetId)?.[0];
  if (!weaponId) throw new Error(`Committed weapon asset is not in this viewer: ${assetId}`);
  const weaponSpec = weaponCatalog.weapons[weaponId];
  const weaponBuild = materialBuildFromPackedAttributes(weaponCatalog, packedAttributes, weaponId);
  const combatWeapon = rollVaultWeapon(vaultGameAtlas, seed, 0, weaponId);
  const combatRules = VAULT_WEAPON_COMBAT_RULES[weaponId].longRange;
  const directions = Object.freeze(["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"]);
  const loadImage = (source) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Onchain image failed: ${source.slice(0, 32)}`));
    image.src = source;
  });
  const pixels = (image) => {
    const surface = document.createElement("canvas");
    surface.width = image.naturalWidth; surface.height = image.naturalHeight;
    const target = surface.getContext("2d", { willReadFrequently: true });
    target.drawImage(image, 0, 0);
    return target.getImageData(0, 0, surface.width, surface.height);
  };
  const decodeFrame = (runs) => {
    const output = [];
    for (const [value, count] of runs) for (let index = 0; index < count; index += 1) output.push(value);
    if (output.length !== 34 * 34) throw new Error("Invalid committed target frame");
    return output;
  };
  const rgba = (hex, alpha) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
  };

  const [rawOrb, mask, panel, targets, rawWeapon, rawGyroFrames] = await Promise.all([
    loadImage("/content/orb-core.png"),
    loadImage("/content/orb-material-mask.png"),
    loadImage("/content/orb-panel-mask.png"),
    fetch("/content/orb-targets.json").then((response) => response.json()),
    loadImage(weaponSpec.sprite),
    weaponId === "gyro" ? Promise.all((weaponSpec.frames ?? []).map(loadImage)) : Promise.resolve([]),
  ]);
  const sourcePixels = pixels(rawOrb);
  const maskPixels = pixels(mask);
  const panelPixels = new ImageData(34 * directions.length, 34);
  const skinPixels = new ImageData(34 * directions.length, 34);
  const colors = { shell: [96,96,96,255], visor: [0,255,255,255], light: [180,0,255,255], port: [255,200,0,255] };
  directions.forEach((direction, frame) => {
    const components = decodeFrame(targets.componentFrames[direction]);
    const skin = decodeFrame(targets.skinFrames[direction]);
    components.forEach((componentIndex, pixel) => {
      const component = targets.componentLabels[componentIndex];
      const x = pixel % 34, y = Math.floor(pixel / 34), offset = (y * panelPixels.width + frame * 34 + x) * 4;
      if (colors[component]) panelPixels.data.set(colors[component], offset);
      if (component === "shell" && !skin[pixel]) skinPixels.data.set([255,255,255,255], offset);
    });
  });
  const orb = document.createElement("canvas");
  orb.width = rawOrb.naturalWidth; orb.height = rawOrb.naturalHeight;
  const shellPalette = ORB_METAL_PALETTES[appearance.shell];
  const port = ORB_PORT_LIGHTS[appearance.rearLight];
  paintOrbMaterialAtlas({
    sourcePixels, maskPixels, panelPixels, skinPixels,
    targetContext: orb.getContext("2d"),
    shellPalette,
    visorPalette: appearance.visor === "matched" ? shellPalette : ORB_VISOR_PALETTES[appearance.visor],
    lightStyle: ORB_LIGHT_STYLES[appearance.coreLight],
    portLightStyle: port?.linkedLight ? { ...ORB_LIGHT_STYLES[appearance.coreLight], intensity: port.intensity } : port,
    skinStyle: ORB_SKIN_STYLES[appearance.skin],
  });

  const weapon = materializeWeaponFrame({
    catalog: weaponCatalog,
    layouts: weaponLayouts,
    overrides: weaponRegionOverrides,
    build: weaponBuild,
    sourceImage: rawWeapon,
    coreStyle: ORB_LIGHT_STYLES[appearance.coreLight],
  });
  // This is the same authored nine-frame spin used by vault-game.js and the
  // full Keel preview. A Gyro projectile is the weapon sprite itself, not
  // a generic circle pretending to be one.
  const tintedGyroFrames = rawGyroFrames.map((sourceImage, frame) => materializeWeaponFrame({
    catalog: weaponCatalog,
    layouts: weaponLayouts,
    overrides: weaponRegionOverrides,
    build: weaponBuild,
    sourceImage,
    coreStyle: ORB_LIGHT_STYLES[appearance.coreLight],
    frame: String(frame),
  }));
  const currentGyroFrame = (time) => {
    if (tintedGyroFrames.length === 0) return weapon;
    const frame = vaultGyroFrameIndex(time, tintedGyroFrames.length);
    document.documentElement.dataset.vaultGyroFrame = String(frame);
    return tintedGyroFrames[frame];
  };

  const canvas = document.querySelector("#vault-character");
  const target = canvas.getContext("2d");
  target.imageSmoothingEnabled = false;
  const light = ORB_LIGHT_STYLES[appearance.coreLight];
  let galleryMode = "character";
  const presentationState = () => Object.freeze({
    protocol: "keel-viewer-verification@1",
    action: "presentation-state",
    presentation: galleryMode,
    character: Object.freeze({
      tokenId: String(contextData.tokenId ?? ""),
      seed,
      appearance: `${appearance.shell}/${appearance.visor}/${appearance.coreLight}/${appearance.skin}`,
    }),
    weapon: Object.freeze({
      id: weaponId,
      name: weaponSpec.name,
      assetId,
      build: Object.freeze({ ...weaponBuild.attributes }),
      projectileStyle: weaponBuild.attributes["projectile-style"],
      combat: Object.freeze({
        longRangeMode: combatWeapon.longRange.mode,
        cooldownMs: combatWeapon.longRange.cooldownMs,
        projectileSpeed: combatWeapon.longRange.projectileSpeed,
        count: combatRules.count ?? 1,
        spread: combatRules.spread ?? 0,
      }),
    }),
  });
  const publishPresentationState = () => parent.postMessage(presentationState(), "*");
  const setGalleryMode = (mode) => {
    galleryMode = mode === "weapon" ? "weapon" : "character";
    document.documentElement.dataset.vaultGalleryMode = galleryMode;
    canvas.setAttribute("aria-label", galleryMode === "weapon" ? `Onchain rotating ${weaponSpec.name} preview` : "Onchain rotating Vault character preview");
    publishPresentationState();
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.protocol !== "keel-viewer-verification@1") return;
    if (event.data.action === "set-presentation") setGalleryMode(event.data.presentation);
    else if (event.data.action === "get-presentation") publishPresentationState();
  });
  Object.defineProperty(globalThis, "__KEEL_PRESENTATION_API__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      protocol: "keel-viewer-verification@1",
      setPresentation: setGalleryMode,
      state: presentationState,
    }),
  });
  document.documentElement.style.setProperty("--glow", light.glow);
  document.documentElement.dataset.vaultGalleryState = "ready";
  document.documentElement.dataset.vaultPresentationMode = "gallery";
  document.documentElement.dataset.vaultCharacterToken = String(contextData.tokenId ?? "");
  document.documentElement.dataset.vaultCharacterSeed = seed;
  document.documentElement.dataset.vaultOrbAppearance = `${appearance.shell}/${appearance.visor}/${appearance.coreLight}/${appearance.skin}`;
  document.documentElement.dataset.vaultWeapon = weaponId;
  document.documentElement.dataset.vaultWeaponAsset = assetId;
  document.documentElement.dataset.vaultWeaponBuild = weaponMaterialLedger(weaponBuild);
  document.documentElement.dataset.vaultWeaponCombat = `${combatWeapon.longRange.mode}:${combatWeapon.longRange.cooldownMs}:${combatWeapon.longRange.projectileSpeed}:${combatRules.count ?? 1}`;
  document.documentElement.dataset.vaultWeaponProjectileVisual = weaponId === "gyro" ? "self-sprite:gyro-saw-spin" : "materialized-core";
  setGalleryMode("character");

  const projectileColors = () => {
    const style = weaponBuild.attributes["projectile-style"];
    if (style === "solid-cyan") return ["#4ff8ff", "#d8ffff"];
    if (style === "solid-amber") return ["#ffbc38", "#fff0a3"];
    if (style === "solid-magenta") return ["#ff51d8", "#ffd1f5"];
    if (style === "blood") return ["#ff314d", "#ffb09f"];
    if (style === "matrix") return ["#70ff74", "#d8ffd0"];
    if (style === "void") return ["#a967ff", "#ead6ff"];
    if (style === "aurora") return ["#55e2ff", "#8dffc6"];
    if (style === "prism") return [light.glow, "#fff3a1"];
    return [light.glow, light.core];
  };
  const weaponProjectiles = [];
  let nextWeaponFireAt = 0;
  let nextPreviewProjectileId = 1;
  const spawnWeaponVolley = (time, angle) => {
    const colors = projectileColors();
    const volley = createVaultWeaponProjectileVolley({
      weaponId,
      attack: "longRange",
      aimX: Math.cos(angle),
      aimY: Math.sin(angle),
      projectileSpeed: combatWeapon.longRange.projectileSpeed,
      radius: combatRules.radius,
      damage: Math.round(combatWeapon.longRange.damage * vaultWeaponProjectileDamageScale(weaponId, "longRange")),
      ttl: weaponId === "gyro" ? 2.1 : 2.2,
      pierce: combatRules.pierce,
      now: time,
      nextId: () => nextPreviewProjectileId++,
    });
    volley.forEach((projectile, index) => weaponProjectiles.push({ ...projectile, lastAt: time, primary: colors[index % colors.length] }));
    document.documentElement.dataset.vaultWeaponBurst = String(nextPreviewProjectileId - 1);
  };

  const drawStage = (time) => {
    const width = canvas.width, height = canvas.height, centerX = width / 2, centerY = height / 2;
    target.clearRect(0, 0, width, height);
    const aura = target.createRadialGradient(centerX, centerY, 0, centerX, centerY, width * .38);
    aura.addColorStop(0, rgba(light.glow, galleryMode === "weapon" ? .25 : .22)); aura.addColorStop(.48, rgba(light.glow, .07)); aura.addColorStop(1, "transparent");
    target.fillStyle = aura; target.fillRect(0, 0, width, height);
    target.save(); target.translate(centerX, centerY); target.strokeStyle = rgba(light.glow, .42); target.lineWidth = 2;
    target.beginPath(); target.arc(0, 0, Math.min(width, height) * .38, 0, Math.PI * 2); target.stroke();
    target.setLineDash([6, 12]); target.lineDashOffset = -time * .012; target.strokeStyle = "rgba(255,255,255,.18)";
    target.beginPath(); target.arc(0, 0, Math.min(width, height) * .29, 0, Math.PI * 2); target.stroke(); target.restore();
    return { width, height, centerX, centerY };
  };

  const drawWeapon = (time) => {
    const { centerX, centerY } = drawStage(time);
    const weaponSize = Math.round(Math.min(canvas.width, canvas.height) * .52);
    const angle = time * (weaponId === "gyro" ? .0011 : .00042) + Math.sin(time * .00073) * .16;
    if (time >= nextWeaponFireAt) {
      spawnWeaponVolley(time, angle);
      nextWeaponFireAt = time + combatWeapon.longRange.cooldownMs;
    }
    target.save(); target.translate(centerX, centerY + weaponSize * .31); target.scale(1, .22);
    const shadow = target.createRadialGradient(0, 0, 0, 0, 0, weaponSize * .5);
    shadow.addColorStop(0, "rgba(0,0,0,.68)"); shadow.addColorStop(1, "transparent"); target.fillStyle = shadow;
    target.beginPath(); target.arc(0, 0, weaponSize * .5, 0, Math.PI * 2); target.fill(); target.restore();
    target.save(); target.translate(centerX, centerY); target.rotate(angle); target.shadowColor = light.glow; target.shadowBlur = 20;
    target.drawImage(weaponId === "gyro" ? currentGyroFrame(time) : weapon, -weaponSize / 2, -weaponSize / 2, weaponSize, weaponSize); target.restore();
    target.save(); target.globalCompositeOperation = "lighter";
    const worldScale = .46;
    for (let index = weaponProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = weaponProjectiles[index];
      const seconds = Math.min(.16, Math.max(0, time - projectile.lastAt) / 1000);
      projectile.lastAt = time;
      updateVaultGyroProjectile(projectile, { x: 0, y: 0 }, time);
      projectile.x += projectile.vx * seconds;
      projectile.y += projectile.vy * seconds;
      projectile.ttl -= seconds;
      if (projectile.ttl <= 0 || (projectile.returning && Math.hypot(projectile.x, projectile.y) < 10)) { weaponProjectiles.splice(index, 1); continue; }
      const x = centerX + projectile.x * worldScale, y = centerY + projectile.y * worldScale;
      target.globalAlpha = Math.min(1, projectile.ttl);
      if (projectile.weapon === "gyro") {
        const saw = currentGyroFrame(time);
        target.save(); target.translate(x, y); target.globalCompositeOperation = "lighter";
        const halo = target.createRadialGradient(0, 0, 2, 0, 0, projectile.radius * worldScale * 1.9);
        halo.addColorStop(0, rgba(light.glow, .42)); halo.addColorStop(.58, rgba(light.glow, .14)); halo.addColorStop(1, rgba(light.glow, 0));
        target.fillStyle = halo; target.beginPath(); target.arc(0, 0, projectile.radius * worldScale * 1.9, 0, Math.PI * 2); target.fill();
        target.globalCompositeOperation = "source-over"; target.shadowBlur = 0;
        const sawSize = projectile.radius * worldScale * 3.1;
        target.drawImage(saw, -sawSize / 2, -sawSize / 2, sawSize, sawSize); target.restore();
      } else {
        target.strokeStyle = projectile.primary; target.shadowColor = projectile.primary; target.shadowBlur = 12;
        target.lineWidth = Math.max(1, projectile.radius * worldScale); target.beginPath();
        target.moveTo(x - projectile.vx * worldScale * .028, y - projectile.vy * worldScale * .028); target.lineTo(x, y); target.stroke();
        target.fillStyle = projectile.primary; target.beginPath(); target.arc(x, y, Math.max(2, projectile.radius * worldScale), 0, Math.PI * 2); target.fill();
      }
    }
    target.restore();
    document.documentElement.dataset.vaultWeaponAngle = angle.toFixed(4);
    document.documentElement.dataset.vaultWeaponParticleCount = String(weaponProjectiles.length);
  };

  let firstFrame = true;
  const draw = (time) => {
    if (galleryMode === "weapon") {
      drawWeapon(time);
      setTimeout(() => requestAnimationFrame(draw), 120);
      return;
    }
    const frame = Math.floor(time / 650) % directions.length;
    const { width, height, centerX, centerY } = drawStage(time);
    const orbSize = Math.round(Math.min(width, height) * .55), bob = Math.sin(time * .0018) * 5;
    target.save(); target.translate(centerX, centerY + orbSize * .35); target.scale(1, .23);
    const shadow = target.createRadialGradient(0, 0, 0, 0, 0, orbSize * .48);
    shadow.addColorStop(0, "rgba(0,0,0,.62)"); shadow.addColorStop(1, "transparent"); target.fillStyle = shadow;
    target.beginPath(); target.arc(0, 0, orbSize * .48, 0, Math.PI * 2); target.fill(); target.restore();
    target.drawImage(orb, frame * 34, 0, 34, 34, centerX - orbSize / 2, centerY - orbSize / 2 + bob, orbSize, orbSize);
    document.documentElement.dataset.vaultGalleryFrame = String(frame);
    document.documentElement.dataset.vaultDirection = directions[frame];
    if (firstFrame) {
      firstFrame = false;
      document.documentElement.dataset.vaultCharacterReady = "true";
      parent.postMessage({ protocol: "keel-viewer-verification@1", action: "preview-ready", state: "verified" }, "*");
      publishPresentationState();
    }
    setTimeout(() => requestAnimationFrame(draw), 120);
  };
  requestAnimationFrame(draw);
} catch (error) {
  fail(error);
}

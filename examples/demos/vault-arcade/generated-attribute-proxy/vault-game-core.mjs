import { rollVaultWeapon, selectVaultEscapeStyle } from "./vault-combat-shared.mjs";

export function hash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function makeRng(seed) {
  let state = hash32(seed) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
export const lerp = (minimum, maximum, amount) => minimum + (maximum - minimum) * amount;
export const pick = (items, rng) => items[Math.floor(rng() * items.length) % items.length];

export function rarityRoll(rng) {
  const value = rng();
  if (value > 0.995) return { id: "mythic", rank: 5, multiplier: 1.18 };
  if (value > 0.97) return { id: "legendary", rank: 4, multiplier: 1.12 };
  if (value > 0.88) return { id: "rare", rank: 3, multiplier: 1.07 };
  if (value > 0.62) return { id: "uncommon", rank: 2, multiplier: 1.03 };
  return { id: "common", rank: 1, multiplier: 1 };
}

function clampedRoll(range, rng, rarity, bias = 1.75) {
  const amount = Math.pow(rng(), bias / rarity.multiplier);
  return Number(lerp(range[0], range[1], amount).toFixed(4));
}

export function rollWeapon(atlas, runSeed, inventoryIndex = 0) {
  return rollVaultWeapon(atlas, runSeed, inventoryIndex);
}

function packedAttributeBytes(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) return undefined;
  return Array.from(
    { length: 32 },
    (_, index) => Number.parseInt(value.slice(2 + (31 - index) * 2, 4 + (31 - index) * 2), 16),
  );
}

export function rollCharacter(atlas, runSeed, packedAttributes = undefined) {
  const rng = makeRng(`${runSeed}:character`);
  const committed = packedAttributeBytes(packedAttributes);
  const choose = (values, index) => committed === undefined ? pick(values, rng) : values[committed[index] % values.length];
  const affinity = pick(["power", "agility", "guard", "signal"], rng);
  const shell = choose(["gunmetal", "gold", "copper", "chrome", "obsidian", "pearl"], 1);
  const visorChoice = committed === undefined
    ? (rng() < 0.34 ? "matched" : pick(["glass", "ruby", "sapphire", "brass", "ceramic", "prism"], rng))
    : choose(["matched", "glass", "ruby", "sapphire", "brass", "ceramic", "prism"], 2);
  const escapeStyle = selectVaultEscapeStyle(hash32(`${runSeed}:escape`));
  const abilities = structuredClone(atlas.character.abilities);
  abilities.escape = { ...abilities.escape, ...escapeStyle };
  return {
    id: atlas.character.id,
    level: 1,
    experience: 0,
    affinity,
    maxHealth: Math.round(95 + rng() * 18),
    moveSpeed: Math.round(205 + rng() * 24),
    defense: Number((0.04 + rng() * 0.06).toFixed(3)),
    critical: Number((0.02 + rng() * 0.045).toFixed(3)),
    pickupRadius: Math.round(54 + rng() * 16),
    appearance: {
      shell,
      visor: visorChoice,
      coreLight: choose(["cyan", "amber", "magenta", "white", "plasma", "aurora", "eclipse", "starfire"], 3),
      rearLight: choose(["utility", "dormant", "linked-light", "titanium", "reactor", "ion", "hazard", "void"], 4),
      skin: choose(["metal", "brushed", "battle-worn", "polished", "oxidized", "prism-light"], 5),
    },
    abilities,
  };
}

export function createRunDescriptor(atlas, mapSeed, characterSeed = "orb-character-001", options = {}) {
  const normalizedMapSeed = String(mapSeed || "vault-map-001").trim() || "vault-map-001";
  const normalizedCharacterSeed = String(characterSeed || "orb-character-001").trim() || "orb-character-001";
  const rng = makeRng(`${normalizedMapSeed}:run`);
  const shopInterval = Math.floor(lerp(atlas.shop.intervalLayers[0], atlas.shop.intervalLayers[1] + 1, rng()));
  const atlasClamp = {
    tilesets: seededSubset(atlas.tilesets.map((item) => item.id), rng, 2, 3),
    palettes: seededSubset(atlas.palettes.map((item) => item.id), rng, 2, 3),
    mobs: seededSubset(atlas.mobs.map((item) => item.id), rng, 3, atlas.mobs.length),
    bosses: seededSubset(atlas.bosses.map((item) => item.id), rng, 2, atlas.bosses.length),
  };
  const primaryWeapon = rollVaultWeapon(atlas, normalizedCharacterSeed, 0, options.forcedWeaponId);
  const secondaryAtlas = { ...atlas, weapons: atlas.weapons.filter((weapon) => weapon.id !== primaryWeapon.id) };
  const secondaryWeapon = rollWeapon(secondaryAtlas, normalizedCharacterSeed, 1);
  return {
    schema: "vault-run@2",
    seed: normalizedMapSeed,
    mapSeed: normalizedMapSeed,
    characterSeed: normalizedCharacterSeed,
    mapSeedDigest: hash32(`${normalizedMapSeed}:map`).toString(16).padStart(8, "0"),
    characterSeedDigest: hash32(`${normalizedCharacterSeed}:character`).toString(16).padStart(8, "0"),
    packedAttributes: options.packedAttributes,
    shopInterval,
    atlasClamp,
    character: rollCharacter(atlas, normalizedCharacterSeed, options.packedAttributes),
    weapon: primaryWeapon,
    weapons: [primaryWeapon, secondaryWeapon],
    activeWeaponIndex: 0,
    backpack: {
      slots: atlas.backpack.baseSlots,
      maximumUnits: atlas.backpack.maximumSlots,
      equipmentSlots: 9,
      items: [
        { kind: "weapon", weaponIndex: 0, name: primaryWeapon.name, rarity: primaryWeapon.rarity, equipped: true },
        { kind: "weapon", weaponIndex: 1, name: secondaryWeapon.name, rarity: secondaryWeapon.rarity, equipped: false },
      ],
    },
  };
}

function seededSubset(items, rng, minimum, maximum) {
  const pool = [...items];
  const count = Math.min(pool.length, Math.floor(lerp(minimum, maximum + 1, rng())));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count);
}

export function createLayerProfile(atlas, run, layer) {
  const rng = makeRng(`${run.seed}:layer:${layer}`);
  const bossLayer = layer % run.shopInterval === 0;
  const shopAfter = bossLayer;
  const tilesetId = pick(run.atlasClamp.tilesets, rng);
  const paletteId = pick(run.atlasClamp.palettes, rng);
  const tileset = atlas.tilesets.find((item) => item.id === tilesetId);
  const palette = atlas.palettes.find((item) => item.id === paletteId);
  const mobPool = seededSubset(run.atlasClamp.mobs, rng, 2, Math.min(4, run.atlasClamp.mobs.length));
  const bossId = bossLayer ? pick(run.atlasClamp.bosses, rng) : null;
  const boss = bossId ? atlas.bosses.find((item) => item.id === bossId) : null;
  const moveCount = boss ? Math.min(boss.moves.length, 2 + Math.floor(layer / run.shopInterval)) : 0;
  const story = pick([
    { title: "The sealed signal", premise: "A buried relay is transmitting through the vault", objective: "trace its source", finale: "survive the relay's final defense" },
    { title: "The stolen core", premise: "A scavenger cell dragged a live core below", objective: "follow the energy trail", finale: "hold the extraction chamber" },
    { title: "The waking machine", premise: "Dormant machinery is restarting room by room", objective: "break the activation chain", finale: "contain the machine intelligence" },
    { title: "The fractured archive", premise: "A lost map revision is rebuilding itself", objective: "recover its scattered keys", finale: "defend the restored archive" },
  ], rng);
  return {
    schema: "vault-layer@1",
    layer,
    waveSeed: hash32(`${run.seed}:wave:${layer}`).toString(16).padStart(8, "0"),
    tilesetId,
    tilesetName: tileset.name,
    biome: tileset.biome,
    roomDesigns: seededSubset(tileset.roomDesigns, rng, 2, tileset.roomDesigns.length),
    paletteId,
    palette,
    floor: pick(tileset.floor, rng),
    wall: pick(tileset.walls, rng),
    objectPool: seededSubset(tileset.objects, rng, 2, tileset.objects.length),
    effects: seededSubset(tileset.fx, rng, 1, tileset.fx.length),
    mobPool,
    mobCount: bossLayer ? 2 + Math.floor(layer / 3) : 5 + layer * 2,
    bossLayer,
    shopAfter,
    boss: boss ? { id: boss.id, name: boss.name, shape: boss.shape, parts: boss.parts, moves: seededSubset(boss.moves, rng, Math.min(2, moveCount), moveCount) } : null,
    challenge: bossLayer ? "boss" : pick(["clear", "survive", "shatter-elites", "protect-relay"], rng),
    story: { ...story, chapter: layer, codename: `${story.title.replaceAll(" ", "-").toLowerCase()}-${hash32(`${run.seed}:${layer}:story`).toString(16).slice(0, 4)}` },
  };
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function gradientAt(seed, x, y) {
  const angle = (hash32(`${seed}:${x}:${y}`) / 4294967296) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function gradientNoise2D(seed, x, y) {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const localX = x - left;
  const localY = y - top;
  const dot = (gridX, gridY, offsetX, offsetY) => {
    const gradient = gradientAt(seed, gridX, gridY);
    return gradient.x * offsetX + gradient.y * offsetY;
  };
  const north = lerp(dot(left, top, localX, localY), dot(left + 1, top, localX - 1, localY), smoothstep(localX));
  const south = lerp(dot(left, top + 1, localX, localY - 1), dot(left + 1, top + 1, localX - 1, localY - 1), smoothstep(localX));
  return clamp(lerp(north, south, smoothstep(localY)) * 0.7 + 0.5, 0, 1);
}

export const VAULT_CARDINAL_NEIGHBORS = Object.freeze([
  Object.freeze({ dx: 0, dy: -1, bit: 1, name: "north" }),
  Object.freeze({ dx: 1, dy: 0, bit: 2, name: "east" }),
  Object.freeze({ dx: 0, dy: 1, bit: 4, name: "south" }),
  Object.freeze({ dx: -1, dy: 0, bit: 8, name: "west" }),
]);

export function classifyAutotileMask(mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 15) throw new Error("Vault autotile mask must be an integer from 0 through 15");
  const count = VAULT_CARDINAL_NEIGHBORS.reduce((total, neighbor) => total + (mask & neighbor.bit ? 1 : 0), 0);
  if (count === 0) return "island";
  if (count === 1) return "cap";
  if (count === 3) return "t-junction";
  if (count === 4) return "cross";
  return mask === 5 || mask === 10 ? "straight" : "corner";
}

export function fractalNoise2D(seed, x, y, octaves = 4) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let normalization = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += gradientNoise2D(`${seed}:octave:${octave}`, x * frequency, y * frequency) * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / normalization;
}

const BIOME_WORLD_GRAMMARS = Object.freeze({
  "industrial-forge": Object.freeze({
    body: "lava",
    foliage: ["cable-foliage", "slag-reeds", "steam-vines"],
    tower: "smelter-tower",
    situations: ["molten-crossing", "pressure-terrace", "foundry-courtyard", "gantry-span"],
  }),
  "crystal-overgrowth": Object.freeze({
    body: "water",
    foliage: ["crystal-foliage", "root-fan", "glass-mushrooms"],
    tower: "prism-tower",
    situations: ["root-basin", "prism-cliff", "hanging-garden", "living-bridge"],
  }),
  "occult-machine-catacomb": Object.freeze({
    body: "mist",
    foliage: ["bone-foliage", "candle-thicket", "wire-brambles"],
    tower: "reliquary-tower",
    situations: ["ritual-channel", "reliquary-terrace", "ossuary-yard", "phase-span"],
  }),
  "zero-gravity-reactor": Object.freeze({
    body: "void",
    foliage: ["ion-foliage", "coolant-bloom", "magnetic-fronds"],
    tower: "reactor-tower",
    situations: ["coolant-crossing", "gravity-terrace", "reactor-yard", "phase-bridge"],
  }),
});

function worldGrammar(profile) {
  return BIOME_WORLD_GRAMMARS[profile.biome] ?? BIOME_WORLD_GRAMMARS["industrial-forge"];
}

function situationForRoom(run, profile, room, roomIndex) {
  const grammar = worldGrammar(profile);
  if (room.role === "entry") return { id: "arrival-court", body: null, elevation: "flat", traversal: "open", breathing: "beacon-pulse" };
  if (room.final) return { id: `${grammar.situations[2]}-holdout`, body: grammar.body, elevation: "ring", traversal: "holdout", breathing: "hazard-cycle" };
  const offset = hash32(`${run.seed}:${profile.layer}:${room.id}:situation`) % grammar.situations.length;
  const id = grammar.situations[(roomIndex + offset) % grammar.situations.length];
  const body = /basin|channel|crossing|bridge|span/.test(id) ? grammar.body : null;
  const elevation = /terrace|cliff|garden|yard/.test(id) ? "terraced" : /holdout/.test(id) ? "ring" : "split";
  const traversal = /bridge|span|crossing|channel|basin/.test(id) ? "bridge" : /terrace|cliff/.test(id) ? "double-ramp" : "open";
  return { id, body, elevation, traversal, breathing: body ? `${body}-flow` : "ambient-cycle" };
}

function partitionWorld(rng, columns, rows, targetCount) {
  const leaves = [{ x: 2, y: 2, width: columns - 4, height: rows - 4 }];
  while (leaves.length < targetCount) {
    const candidates = leaves
      .map((leaf, index) => ({ leaf, index, score: leaf.width * leaf.height + rng() * 120 }))
      .filter(({ leaf }) => leaf.width >= 18 || leaf.height >= 15)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) break;
    const { leaf, index } = candidates[0];
    const vertical = leaf.width / leaf.height > 1.25 ? true : leaf.height / leaf.width > 1.25 ? false : rng() > 0.5;
    const span = vertical ? leaf.width : leaf.height;
    const minimum = vertical ? 9 : 8;
    if (span < minimum * 2) break;
    const split = minimum + Math.floor(rng() * Math.max(1, span - minimum * 2 + 1));
    const children = vertical
      ? [{ x: leaf.x, y: leaf.y, width: split, height: leaf.height }, { x: leaf.x + split, y: leaf.y, width: leaf.width - split, height: leaf.height }]
      : [{ x: leaf.x, y: leaf.y, width: leaf.width, height: split }, { x: leaf.x, y: leaf.y + split, width: leaf.width, height: leaf.height - split }];
    leaves.splice(index, 1, ...children);
  }
  return leaves;
}

function minimumSpanningEdges(rooms) {
  const candidates = [];
  for (let left = 0; left < rooms.length; left += 1) for (let right = left + 1; right < rooms.length; right += 1) {
    const dx = rooms[left].column - rooms[right].column;
    const dy = rooms[left].row - rooms[right].row;
    candidates.push({ left, right, distance: dx * dx + dy * dy });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.left - b.left || a.right - b.right);
  const parent = rooms.map((_, index) => index);
  const find = (value) => parent[value] === value ? value : (parent[value] = find(parent[value]));
  const edges = [];
  for (const edge of candidates) {
    const leftRoot = find(edge.left);
    const rightRoot = find(edge.right);
    if (leftRoot === rightRoot) continue;
    parent[leftRoot] = rightRoot;
    edges.push(edge);
    if (edges.length === rooms.length - 1) break;
  }
  return { edges, candidates };
}

function routeCorridor(columns, rows, tiles, start, target, sourceRoomId, targetRoomId, seed) {
  const key = (column, row) => row * columns + column;
  const startKey = key(start.column, start.row);
  const targetKey = key(target.column, target.row);
  const open = [{ column: start.column, row: start.row, cost: 0, score: 0 }];
  const best = new Map([[startKey, 0]]);
  const previous = new Map();
  while (open.length) {
    open.sort((a, b) => a.score - b.score || hash32(`${seed}:${a.column}:${a.row}`) - hash32(`${seed}:${b.column}:${b.row}`));
    const current = open.shift();
    const currentKey = key(current.column, current.row);
    if (currentKey === targetKey) {
      const path = [];
      let cursor = currentKey;
      while (cursor !== undefined) {
        path.push({ column: cursor % columns, row: Math.floor(cursor / columns) });
        cursor = previous.get(cursor);
      }
      return path.reverse();
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const column = current.column + dx;
      const row = current.row + dy;
      if (column < 1 || row < 1 || column >= columns - 1 || row >= rows - 1) continue;
      const tile = tiles[key(column, row)];
      const unrelatedRoom = tile.roomId && tile.roomId !== sourceRoomId && tile.roomId !== targetRoomId;
      const step = unrelatedRoom ? 28 : tile.kind === "corridor" ? 0.35 : tile.kind === "floor" ? 0.7 : 1;
      const cost = current.cost + step;
      const nextKey = key(column, row);
      if (cost >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, cost);
      previous.set(nextKey, currentKey);
      const heuristic = Math.abs(column - target.column) + Math.abs(row - target.row);
      open.push({ column, row, cost, score: cost + heuristic });
    }
  }
  throw new Error("Unable to route deterministic Vault corridor");
}

export function createArenaLayout(run, profile, width = 1280, height = 720) {
  const rng = makeRng(`${run.seed}:arena:${profile.layer}`);
  const columns = 88 + Math.min(16, Math.floor(profile.layer / 3) * 4);
  const rows = 56 + Math.min(12, Math.floor(profile.layer / 4) * 4);
  const tileWidth = 64;
  const tileHeight = 64;
  const corridorRadius = 2;
  const corridorWidth = corridorRadius * 2 + 1;
  const worldWidth = columns * tileWidth;
  const worldHeight = rows * tileHeight;
  const tiles = Array.from({ length: columns * rows }, (_, index) => ({
    kind: "wall",
    variant: hash32(`${run.seed}:${profile.layer}:tile:${index}`) % 6,
    roomId: null,
  }));
  const roomCount = clamp(10 + Math.floor(profile.layer / 3), 10, 14);
  const partitions = partitionWorld(rng, columns, rows, roomCount);
  const missionPool = ["purge", "defend-relay", "recover-cache", "hunt-elite", "survive", "signal-puzzle"];
  if (profile.mobPool.includes("wisp")) missionPool.push("disable-lasers");
  const storyVerbs = ["restore", "breach", "trace", "stabilize", "recover", "seal"];
  let rooms = partitions.map((partition, index) => {
    const maximumWidth = Math.max(7, partition.width - 4);
    const maximumHeight = Math.max(7, partition.height - 4);
    const roomWidth = Math.max(7, Math.min(maximumWidth, 7 + Math.floor(rng() * Math.max(1, maximumWidth - 6)))) | 1;
    const roomHeight = Math.max(7, Math.min(maximumHeight, 7 + Math.floor(rng() * Math.max(1, maximumHeight - 6)))) | 1;
    const offsetX = 2 + Math.floor(rng() * Math.max(1, partition.width - roomWidth - 3));
    const offsetY = 2 + Math.floor(rng() * Math.max(1, partition.height - roomHeight - 3));
    const left = partition.x + offsetX;
    const top = partition.y + offsetY;
    return {
      id: `room-${index}`,
      column: left + Math.floor(roomWidth / 2),
      row: top + Math.floor(roomHeight / 2),
      left,
      top,
      width: roomWidth,
      height: roomHeight,
      halfWidth: Math.floor(roomWidth / 2),
      halfHeight: Math.floor(roomHeight / 2),
      design: profile.roomDesigns[index % profile.roomDesigns.length],
      role: "encounter",
      mission: pick(missionPool, rng),
      storyBeat: `${pick(storyVerbs, rng)}-${profile.biome}-${index + 1}`,
      locked: true,
      final: false,
      depth: 0,
      enemyBudget: 3 + Math.floor(profile.layer / 3),
      holdoutSeconds: 0,
      spawnSockets: [],
    };
  });
  const entry = rooms.reduce((best, room) => room.column + room.row < best.column + best.row ? room : best, rooms[0]);
  const tree = minimumSpanningEdges(rooms);
  const adjacency = rooms.map(() => []);
  for (const edge of tree.edges) {
    adjacency[edge.left].push(edge.right);
    adjacency[edge.right].push(edge.left);
  }
  const entryIndex = rooms.indexOf(entry);
  const queue = [entryIndex];
  const parent = Array(rooms.length).fill(-1);
  const depth = Array(rooms.length).fill(-1);
  depth[entryIndex] = 0;
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency[current]) if (depth[next] < 0) {
      parent[next] = current;
      depth[next] = depth[current] + 1;
      queue.push(next);
    }
  }
  const finalIndex = depth.reduce((best, value, index) => value > depth[best] ? index : best, entryIndex);
  const ordering = rooms.map((room, index) => ({ room, index, depth: depth[index] })).sort((a, b) => a.depth - b.depth || a.index - b.index);
  rooms = ordering.map(({ room }, index) => ({ ...room, id: `room-${index}` }));
  const oldToNew = new Map(ordering.map(({ index }, newIndex) => [index, newIndex]));
  const remappedParent = ordering.map(({ index }) => parent[index] < 0 ? -1 : oldToNew.get(parent[index]));
  const remappedDepth = ordering.map(({ depth: value }) => value);
  const remappedFinal = oldToNew.get(finalIndex);
  rooms.forEach((room, index) => {
    room.depth = remappedDepth[index];
    room.locked = index !== 0;
    room.final = index === remappedFinal;
    const degree = adjacency[ordering[index].index].length;
    room.mission = index === 0 ? "breach" : room.final ? "final-holdout" : degree >= 3 ? "defend-relay" : degree === 1 && rng() > 0.45 ? "recover-cache" : pick(missionPool, rng);
    room.miniBoss = !room.final && room.depth >= 2 && (room.mission === "hunt-elite" || hash32(`${run.seed}:${profile.layer}:${room.id}:miniboss`) % 7 === 0);
    room.optional = !room.final && degree === 1 && room.mission === "signal-puzzle";
    room.puzzleComplete = room.mission !== "signal-puzzle";
    room.role = index === 0 ? "entry" : room.final ? (profile.bossLayer ? "boss" : "holdout") : room.miniBoss ? "miniboss" : room.mission === "recover-cache" ? "cache" : room.mission === "defend-relay" ? "relay" : room.mission === "signal-puzzle" ? "puzzle" : "encounter";
    room.storyBeat = index === 0 ? `breach-${profile.biome}-and-${profile.story.objective.replaceAll(" ", "-")}` : room.final ? profile.story.finale.replaceAll(" ", "-") : `${pick(storyVerbs, rng)}-${profile.biome}-${index + 1}`;
    room.enemyBudget = room.final ? 8 + profile.layer : 3 + room.depth + Math.floor(profile.layer / 3);
    if (room.miniBoss) room.enemyBudget += 2;
    room.holdoutSeconds = room.final ? 14 + Math.min(18, profile.layer * 1.5) : room.mission === "survive" || room.mission === "defend-relay" ? 8 + Math.min(10, profile.layer) : 0;
    room.situation = situationForRoom(run, profile, room, index);
    room.motifId = room.design;
    room.motifTransform = ["r0", "r90", "r180", "r270"][hash32(`${run.seed}:${profile.layer}:${room.id}:motif-transform`) % 4];
    const signalCryptMacros = { "cross-sanctum": 0, "relay-chapel": 1, "rune-hall": 2, "split-vault": 3 };
    room.floorMacro = profile.biome === "occult-machine-catacomb"
      ? signalCryptMacros[room.design]
      : hash32(`${run.seed}:${profile.layer}:${room.id}:floor-macro`) % 4;
  });
  for (let roomIndex = 1; roomIndex < rooms.length; roomIndex += 1) {
    const parentRoom = rooms[remappedParent[roomIndex]];
    const room = rooms[roomIndex];
    if (parentRoom && room.floorMacro === parentRoom.floorMacro && room.motifTransform === parentRoom.motifTransform) {
      const transforms = ["r0", "r90", "r180", "r270"];
      room.motifTransform = transforms[(transforms.indexOf(room.motifTransform) + 1) % transforms.length];
    }
  }
  if (!rooms.some((room) => room.miniBoss)) {
    const miniBossRoom = rooms.filter((room) => !room.final && room.depth >= 2).sort((left, right) => right.depth - left.depth)[0];
    miniBossRoom.miniBoss = true;
    miniBossRoom.role = "miniboss";
    miniBossRoom.mission = "hunt-elite";
    miniBossRoom.enemyBudget += 2;
  }
  const tileAt = (column, row) => tiles[row * columns + column];
  const carve = (column, row, kind, roomId = null) => {
    if (column < 1 || row < 1 || column >= columns - 1 || row >= rows - 1) return;
    const tile = tileAt(column, row);
    if (kind === "floor" || tile.kind === "wall") tile.kind = kind;
    tile.roomId ??= roomId;
  };
  for (const room of rooms) {
    for (let row = room.top; row < room.top + room.height; row += 1) {
      for (let column = room.left; column < room.left + room.width; column += 1) {
        const corner = Math.abs(column - room.column) === room.halfWidth && Math.abs(row - room.row) === room.halfHeight;
        if (!corner || room.design.includes("grid") || room.design.includes("vault")) carve(column, row, "floor", room.id);
      }
    }
  }
  const connections = [];
  const connectRooms = (parentIndex, childIndex, connectionKind = "critical") => {
    const from = rooms[parentIndex];
    const to = rooms[childIndex];
    const path = routeCorridor(columns, rows, tiles, from, to, from.id, to.id, `${run.seed}:${profile.layer}:${connectionKind}:${from.id}:${to.id}`);
    for (let pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
      const point = path[pathIndex];
      const previousPoint = path[Math.max(0, pathIndex - 1)];
      const nextPoint = path[Math.min(path.length - 1, pathIndex + 1)];
      const horizontal = previousPoint.row === point.row && nextPoint.row === point.row;
      const vertical = previousPoint.column === point.column && nextPoint.column === point.column;
      const offsets = [];
      if (horizontal) {
        for (let offset = -corridorRadius; offset <= corridorRadius; offset += 1) offsets.push([0, offset]);
      } else if (vertical) {
        for (let offset = -corridorRadius; offset <= corridorRadius; offset += 1) offsets.push([offset, 0]);
      } else {
        for (let offsetRow = -corridorRadius; offsetRow <= corridorRadius; offsetRow += 1) {
          for (let offsetColumn = -corridorRadius; offsetColumn <= corridorRadius; offsetColumn += 1) offsets.push([offsetColumn, offsetRow]);
        }
      }
      for (const [offsetColumn, offsetRow] of offsets) {
        const corridorTile = tileAt(point.column + offsetColumn, point.row + offsetRow);
        if (!corridorTile?.roomId) carve(point.column + offsetColumn, point.row + offsetRow, "corridor");
      }
    }
    let doorPoint = path.find((point, index) => tileAt(point.column, point.row).roomId === to.id && index > 0 && tileAt(path[index - 1].column, path[index - 1].row).roomId !== to.id);
    doorPoint ??= path.at(-2);
    const doorId = `door-${connectionKind}-${parentIndex}-${childIndex}`;
    const doorColumn = doorPoint.column;
    const doorRow = doorPoint.row;
    const doorPathIndex = path.indexOf(doorPoint);
    const beforeDoor = path[Math.max(0, doorPathIndex - 1)];
    const passageAxis = beforeDoor.column !== doorColumn ? "horizontal" : "vertical";
    const doorTiles = Array.from({ length: corridorWidth }, (_, index) => index - corridorRadius).map((segment) => ({
      column: doorColumn + (passageAxis === "vertical" ? segment : 0),
      row: doorRow + (passageAxis === "horizontal" ? segment : 0),
      segment,
    }));
    if (doorTiles.some((door) => tileAt(door.column, door.row)?.kind === "door")) return false;
    for (const door of doorTiles) {
      const doorTile = tileAt(door.column, door.row);
      doorTile.kind = "door";
      doorTile.roomId = to.id;
      doorTile.doorId = doorId;
      doorTile.doorAxis = passageAxis;
      doorTile.doorSegment = door.segment;
      doorTile.doorRole = door.segment === 0 ? "mechanism" : Math.abs(door.segment) === 1 ? "inner" : "cap";
    }
    connections.push({
      id: doorId,
      from: from.id,
      to: to.id,
      door: { column: doorColumn, row: doorRow, axis: passageAxis, span: corridorWidth, tiles: doorTiles },
      locked: true,
      openedAt: null,
      kind: connectionKind,
    });
    return true;
  };
  for (let childIndex = 1; childIndex < rooms.length; childIndex += 1) {
    connectRooms(remappedParent[childIndex], childIndex, "critical");
  }
  const existingPairs = new Set(connections.map((connection) => [connection.from, connection.to].sort().join(":")));
  const desiredShortcuts = 1 + (hash32(`${run.seed}:${profile.layer}:shortcut-count`) % 3);
  const shortcutCandidates = tree.candidates
    .map((edge) => {
      const left = oldToNew.get(edge.left);
      const right = oldToNew.get(edge.right);
      return left < right ? { left, right, distance: edge.distance } : { left: right, right: left, distance: edge.distance };
    })
    .filter((edge) => edge.left !== edge.right && !existingPairs.has([rooms[edge.left].id, rooms[edge.right].id].sort().join(":")))
    .filter((edge) => Math.abs(rooms[edge.left].depth - rooms[edge.right].depth) <= 2)
    .sort((left, right) => {
      const leftScore = left.distance + (hash32(`${run.seed}:${profile.layer}:${left.left}:${left.right}:shortcut`) % 200);
      const rightScore = right.distance + (hash32(`${run.seed}:${profile.layer}:${right.left}:${right.right}:shortcut`) % 200);
      return leftScore - rightScore;
    });
  let shortcutCount = 0;
  for (const edge of shortcutCandidates) {
    if (shortcutCount >= desiredShortcuts) break;
    const fromIndex = rooms[edge.left].depth <= rooms[edge.right].depth ? edge.left : edge.right;
    const toIndex = fromIndex === edge.left ? edge.right : edge.left;
    if (!connectRooms(fromIndex, toIndex, "shortcut")) continue;
    existingPairs.add([rooms[fromIndex].id, rooms[toIndex].id].sort().join(":"));
    shortcutCount += 1;
  }
  const objects = [];
  for (const room of rooms) {
    const sockets = [
      [room.left + 1, room.top + 1], [room.left + room.width - 2, room.top + 1],
      [room.left + 1, room.top + room.height - 2], [room.left + room.width - 2, room.top + room.height - 2],
      [room.column, room.top + 1], [room.column, room.top + room.height - 2],
    ];
    const combatSockets = [
      [room.left + 2, room.row], [room.left + room.width - 3, room.row],
      [room.column, room.top + 2], [room.column, room.top + room.height - 3],
      [room.left + 2, room.top + 2], [room.left + room.width - 3, room.top + room.height - 3],
    ];
    room.spawnSockets = combatSockets.map(([column, row]) => ({ x: (column + 0.5) * tileWidth, y: (row + 0.5) * tileHeight }));
    if (room.role === "cache") {
      objects.push({
        id: `${profile.layer}:${room.id}:chest`,
        type: "cache",
        roomId: room.id,
        x: (room.column + 0.5) * tileWidth,
        y: (room.row + 0.5) * tileHeight,
        radius: 18,
        variant: hash32(`${run.seed}:${profile.layer}:${room.id}:chest`) % 4,
        animation: "sealed-chest",
        state: "sealed",
      });
    }
    if (room.mission === "defend-relay") {
      objects.push({
        id: `${profile.layer}:${room.id}:relay`,
        type: "relay",
        roomId: room.id,
        x: (room.column + 0.5) * tileWidth,
        y: (room.row + 0.5) * tileHeight,
        radius: 16,
        variant: hash32(`${run.seed}:${profile.layer}:${room.id}:relay`) % 4,
        animation: "relay-pulse",
        state: "dormant",
      });
    }
    if (room.mission === "signal-puzzle") {
      room.puzzleSequence = [0, 1, 2].sort((left, right) => hash32(`${run.seed}:${profile.layer}:${room.id}:puzzle:${left}`) - hash32(`${run.seed}:${profile.layer}:${room.id}:puzzle:${right}`));
      const puzzlePoints = [[room.column - 2, room.row + 1], [room.column, room.row - 2], [room.column + 2, room.row + 1]];
      for (let puzzleIndex = 0; puzzleIndex < puzzlePoints.length; puzzleIndex += 1) {
        const [column, row] = puzzlePoints[puzzleIndex];
        objects.push({
          id: `${profile.layer}:${room.id}:puzzle:${puzzleIndex}`,
          type: "puzzle-node",
          puzzleIndex,
          roomId: room.id,
          x: (column + 0.5) * tileWidth,
          y: (row + 0.5) * tileHeight,
          radius: 18,
          variant: puzzleIndex,
          animation: "relay-pulse",
          state: "dormant",
        });
      }
    }
    const setPieces = room.final ? 6 : room.role === "entry" ? 2 : room.mission === "survive" ? 5 : 3;
    const perimeter = sockets.filter((_, index) => index < 4);
    for (let objectIndex = 0; objectIndex < Math.min(setPieces, perimeter.length); objectIndex += 1) {
      const point = perimeter[(objectIndex + room.depth) % perimeter.length];
      objects.push({
        id: `${profile.layer}:${room.id}:set-piece:${objectIndex}`,
        type: pick(profile.objectPool, rng),
        roomId: room.id,
        x: (point[0] + 0.5) * tileWidth,
        y: (point[1] + 0.5) * tileHeight,
        radius: 17 + (objectIndex % 2) * 4,
        variant: hash32(`${run.seed}:${profile.layer}:${room.id}:object:${objectIndex}`) % 4,
        animation: objectIndex % 2 ? "machine-cycle" : "static",
        state: "idle",
      });
    }
  }
  const grammar = worldGrammar(profile);
  const features = {
    "water-body": [],
    "lava-body": [],
    "other-body": [],
    cliff: [],
    ramp: [],
    bridge: [],
    "dynamic-bridge": [],
    tower: [],
    foliage: [],
  };
  const addTileFeature = (column, row, feature) => {
    const tile = tileAt(column, row);
    if (!tile || tile.kind === "wall") return false;
    tile.features ??= [];
    if (!tile.features.includes(feature)) tile.features.push(feature);
    tile.feature ??= feature;
    return true;
  };
  const bodyFeature = (terrain) => terrain === "water" ? "water-body" : terrain === "lava" ? "lava-body" : "other-body";
  const protectedTile = (column, row) => {
    const tile = tileAt(column, row);
    return !tile || tile.kind === "wall" || tile.kind === "door";
  };
  for (const [roomIndex, room] of rooms.entries()) {
    const situation = room.situation;
    const axis = hash32(`${run.seed}:${profile.layer}:${room.id}:axis`) % 2 ? "horizontal" : "vertical";
    room.elevation = situation.elevation === "flat" ? 0 : 1 + (hash32(`${run.seed}:${profile.layer}:${room.id}:height`) % 2);
    const interior = [];
    for (let row = room.top + 1; row < room.top + room.height - 1; row += 1) {
      for (let column = room.left + 1; column < room.left + room.width - 1; column += 1) {
        const tile = tileAt(column, row);
        if (tile.kind !== "wall" && tile.kind !== "door") interior.push({ column, row, tile });
      }
    }
    for (const { tile } of interior) {
      tile.elevation = 0;
      tile.traversable = true;
      tile.situationId = situation.id;
      tile.animation = situation.breathing;
    }
    const bridgeTiles = [];

    if (situation.body) {
      const thickness = room.final ? 2 : 1 + (hash32(`${run.seed}:${room.id}:body-width`) % 2);
      const bodyTiles = [];
      for (const { column, row, tile } of interior) {
        const offset = axis === "horizontal" ? row - room.row : column - room.column;
        const meander = ((axis === "horizontal" ? column : row) + hash32(`${run.seed}:${room.id}:meander`)) % 5 === 0 ? 1 : 0;
        if (Math.abs(offset - meander) > thickness) continue;
        tile.terrain = situation.body;
        // Bodies remain traversable at the graph layer. Runtime movement and
        // damage rules interpret the hazard; the authored bridge is the safe,
        // fast route without making a seeded room accidentally unreachable.
        tile.traversable = true;
        tile.hazard = ["lava", "void"].includes(situation.body) ? situation.body : null;
        tile.animation = `${situation.body}-flow`;
        bodyTiles.push({ column, row });
      }
      const feature = bodyFeature(situation.body);
      const body = { id: `${room.id}:${situation.body}`, roomId: room.id, terrain: situation.body, axis, tiles: bodyTiles };
      features[feature].push(body);

      const bridgeWidth = room.final ? 3 : 2;
      const bodyCoordinates = bodyTiles.map((point) => axis === "horizontal" ? point.row : point.column);
      const bodyMinimum = Math.min(...bodyCoordinates) - 1;
      const bodyMaximum = Math.max(...bodyCoordinates) + 1;
      for (let crossing = bodyMinimum; crossing <= bodyMaximum; crossing += 1) {
        for (let lane = -bridgeWidth + 1; lane < bridgeWidth; lane += 1) {
          const column = axis === "horizontal" ? room.column + lane : crossing;
          const row = axis === "horizontal" ? crossing : room.row + lane;
          const tile = tileAt(column, row);
          if (!tile || tile.kind === "wall" || tile.kind === "door") continue;
          tile.traversable = true;
          tile.bridgeId = `${room.id}:bridge`;
          tile.animation = "bridge-energy-cycle";
          addTileFeature(column, row, "bridge");
          bridgeTiles.push({ column, row });
        }
      }
      const dynamic = hash32(`${run.seed}:${profile.layer}:${room.id}:dynamic-bridge`) % 5 === 0;
      const bridge = {
        id: `${room.id}:bridge`,
        roomId: room.id,
        axis: axis === "horizontal" ? "vertical" : "horizontal",
        tiles: bridgeTiles,
        dynamic,
        state: dynamic ? "phase-cycle" : "stable",
        animation: dynamic ? "phase-bridge-cycle" : "bridge-energy-cycle",
      };
      features.bridge.push(bridge);
      if (dynamic) {
        features["dynamic-bridge"].push(bridge);
        for (const point of bridgeTiles) addTileFeature(point.column, point.row, "dynamic-bridge");
      }
    }

    if (situation.elevation !== "flat") {
      const elevationAxis = axis === "horizontal" ? "vertical" : "horizontal";
      const highSide = hash32(`${run.seed}:${profile.layer}:${room.id}:high-side`) % 2 ? 1 : -1;
      const transition = elevationAxis === "horizontal" ? room.column : room.row;
      const rampTiles = [];
      const rampTileKeys = new Set();
      const cliffTiles = [];
      const rampStartSigned = 1 - room.elevation;
      for (const { column, row, tile } of interior) {
        const coordinate = elevationAxis === "horizontal" ? column : row;
        const cross = elevationAxis === "horizontal" ? row : column;
        const centerCross = elevationAxis === "horizontal" ? room.row : room.column;
        const signed = (coordinate - transition) * highSide;
        if (signed > 1) tile.elevation = room.elevation;
        if (signed === 1 && Math.abs(cross - centerCross) > 1) {
          tile.elevation = room.elevation;
          tile.traversable = false;
          tile.cliffDirection = highSide > 0 ? (elevationAxis === "horizontal" ? "west" : "north") : (elevationAxis === "horizontal" ? "east" : "south");
          addTileFeature(column, row, "cliff");
          cliffTiles.push({ column, row });
        }
        const bridgeTransition = tile.features?.includes("bridge") && signed >= rampStartSigned && signed <= 1;
        if ((Math.abs(cross - centerCross) <= 1 || bridgeTransition) && signed >= rampStartSigned && signed <= 1) {
          tile.elevation = signed - rampStartSigned;
          tile.rampDirection = highSide > 0 ? (elevationAxis === "horizontal" ? "east" : "south") : (elevationAxis === "horizontal" ? "west" : "north");
          tile.traversable = true;
          addTileFeature(column, row, "ramp");
          if (tile.features?.includes("bridge")) {
            addTileFeature(column, row, "bridge-ramp");
            tile.junction = "bridge-ramp";
          }
          rampTiles.push({ column, row, level: tile.elevation });
          rampTileKeys.add(`${column}:${row}`);
        }
      }
      // A bridge can include bank/threshold cells just outside the room's
      // interior. Normalize those cells to the same elevation function and
      // register every stepped lane, otherwise a valid bridge can hide an
      // untagged vertical ledge at its endpoint.
      for (const { column, row } of bridgeTiles) {
        const tile = tileAt(column, row);
        const coordinate = elevationAxis === "horizontal" ? column : row;
        const signed = (coordinate - transition) * highSide;
        if (signed > 1) tile.elevation = room.elevation;
        else if (signed < rampStartSigned) tile.elevation = 0;
        else {
          tile.elevation = signed - rampStartSigned;
          tile.rampDirection = highSide > 0 ? (elevationAxis === "horizontal" ? "east" : "south") : (elevationAxis === "horizontal" ? "west" : "north");
          tile.traversable = true;
          addTileFeature(column, row, "ramp");
          addTileFeature(column, row, "bridge-ramp");
          tile.junction = "bridge-ramp";
          if (!rampTileKeys.has(`${column}:${row}`)) {
            rampTiles.push({ column, row, level: tile.elevation });
            rampTileKeys.add(`${column}:${row}`);
          }
        }
      }
      if (cliffTiles.length) features.cliff.push({ id: `${room.id}:cliff`, roomId: room.id, axis: elevationAxis, height: room.elevation, tiles: cliffTiles });
      if (rampTiles.length) features.ramp.push({ id: `${room.id}:double-ramp`, roomId: room.id, axis: elevationAxis, levels: [0, room.elevation], tiles: rampTiles });
    }

    const towerEligible = room.final || room.miniBoss || roomIndex === Math.min(2, rooms.length - 1);
    if (towerEligible) {
      const tower = {
        id: `${room.id}:tower`,
        type: grammar.tower,
        feature: "tower",
        roomId: room.id,
        x: (room.left + 1.5) * tileWidth,
        y: (room.top + 1.5) * tileHeight,
        radius: room.final ? 28 : 22,
        variant: hash32(`${run.seed}:${profile.layer}:${room.id}:tower`) % 6,
        animation: "tower-signal-cycle",
        state: "idle",
      };
      objects.push(tower);
      features.tower.push(tower.id);
    }

    if (room.role !== "entry") {
      const foliageCount = 3 + (hash32(`${run.seed}:${profile.layer}:${room.id}:foliage-count`) % 4);
      const perimeter = [
        [room.left + 1, room.top + 1],
        [room.left + room.width - 2, room.top + 1],
        [room.left + 1, room.top + room.height - 2],
        [room.left + room.width - 2, room.top + room.height - 2],
        [room.column - 2, room.top + 1],
        [room.column + 2, room.top + room.height - 2],
      ];
      for (let foliageIndex = 0; foliageIndex < foliageCount; foliageIndex += 1) {
        const point = perimeter[(foliageIndex + room.depth) % perimeter.length];
        if (protectedTile(point[0], point[1])) continue;
        const foliage = {
          id: `${room.id}:foliage:${foliageIndex}`,
          type: grammar.foliage[(foliageIndex + room.depth) % grammar.foliage.length],
          feature: "foliage",
          roomId: room.id,
          x: (point[0] + 0.5) * tileWidth,
          y: (point[1] + 0.5) * tileHeight,
          radius: 10 + (foliageIndex % 3) * 4,
          variant: hash32(`${run.seed}:${profile.layer}:${room.id}:foliage:${foliageIndex}`) % 8,
          animation: foliageIndex % 2 ? "foliage-breathe" : "foliage-sway",
          state: "idle",
        };
        objects.push(foliage);
        features.foliage.push(foliage.id);
      }
    }
  }
  const objectCell = (object) => `${Math.floor(object.x / tileWidth)},${Math.floor(object.y / tileHeight)}`;
  const reservedSpawnCells = new Set(rooms.flatMap((room) => room.spawnSockets.map((socket) => `${Math.floor(socket.x / tileWidth)},${Math.floor(socket.y / tileHeight)}`)));
  const occupiedObjectCells = new Set();
  const rejectedObjectIds = new Set();
  for (const object of objects) {
    const room = rooms.find((candidate) => candidate.id === object.roomId);
    if (!room) continue;
    const semantic = ["cache", "relay", "puzzle-node"].includes(object.type);
    const currentCell = objectCell(object);
    const currentTile = (() => {
      const [column, row] = currentCell.split(",").map(Number);
      return tileAt(column, row);
    })();
    const validCurrent = !occupiedObjectCells.has(currentCell)
      && !reservedSpawnCells.has(currentCell)
      && currentTile?.kind !== "wall"
      && currentTile?.kind !== "door"
      && (semantic || (currentTile?.terrain ?? "dry") === "dry")
      && (semantic || !currentTile?.features?.some((feature) => ["bridge", "dynamic-bridge", "ramp", "cliff"].includes(feature)));
    if (!validCurrent) {
      const candidates = [];
      for (let row = room.top + 1; row < room.top + room.height - 1; row += 1) {
        for (let column = room.left + 1; column < room.left + room.width - 1; column += 1) {
          const key = `${column},${row}`;
          const tile = tileAt(column, row);
          if (!tile || tile.kind === "wall" || tile.kind === "door" || occupiedObjectCells.has(key) || reservedSpawnCells.has(key)) continue;
          if ((tile.terrain ?? "dry") !== "dry" || tile.features?.some((feature) => ["bridge", "dynamic-bridge", "ramp", "cliff"].includes(feature))) continue;
          const centerDistance = Math.abs(column - room.column) + Math.abs(row - room.row);
          if (!semantic && centerDistance < 2) continue;
          candidates.push({
            column,
            row,
            score: centerDistance * 11 + (hash32(`${run.seed}:${profile.layer}:${object.id}:${column}:${row}:placement`) % 101),
          });
        }
      }
      candidates.sort((left, right) => right.score - left.score || left.row - right.row || left.column - right.column);
      let placement = candidates[0];
      if (!placement && object.feature === "tower") {
        const globalCandidates = [];
        for (let row = 1; row < rows - 1; row += 1) for (let column = 1; column < columns - 1; column += 1) {
          const key = `${column},${row}`;
          const tile = tileAt(column, row);
          if (!tile?.roomId || tile.kind === "wall" || tile.kind === "door" || (tile.terrain ?? "dry") !== "dry" || occupiedObjectCells.has(key) || reservedSpawnCells.has(key)) continue;
          if (tile.features?.some((feature) => ["bridge", "dynamic-bridge", "ramp", "cliff"].includes(feature))) continue;
          globalCandidates.push({ column, row, score: hash32(`${run.seed}:${profile.layer}:${object.id}:${column}:${row}:tower-fallback`) % 65536 });
        }
        globalCandidates.sort((left, right) => right.score - left.score || left.row - right.row || left.column - right.column);
        placement = globalCandidates[0];
        if (placement) object.roomId = tileAt(placement.column, placement.row).roomId;
      }
      if (placement) {
        object.x = (placement.column + 0.5) * tileWidth;
        object.y = (placement.row + 0.5) * tileHeight;
      } else {
        rejectedObjectIds.add(object.id);
        continue;
      }
    }
    occupiedObjectCells.add(objectCell(object));
  }
  if (rejectedObjectIds.size) {
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      if (rejectedObjectIds.has(objects[index].id)) objects.splice(index, 1);
    }
    for (const ids of Object.values(features)) {
      if (!Array.isArray(ids)) continue;
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        if (rejectedObjectIds.has(ids[index])) ids.splice(index, 1);
      }
    }
  }
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const motifActiveFor = (room, column, row) => {
    if (!room) return false;
    const x = column - room.left;
    const y = row - room.top;
    const dx = column - room.column;
    const dy = row - room.row;
    const radius = Math.hypot(dx / Math.max(1, room.halfWidth), dy / Math.max(1, room.halfHeight));
    switch (room.design) {
      case "cross-sanctum": case "reactor-cross": return Math.abs(dx) <= 1 || Math.abs(dy) <= 1;
      case "rune-hall": case "terminal-spine": return Math.abs(room.width >= room.height ? dy : dx) <= 1 || (x + y + room.depth) % 7 === 0;
      case "split-vault": return Math.abs(room.width >= room.height ? dx : dy) <= 1;
      case "relay-chapel": return Math.abs(room.width >= room.height ? dy : dx) <= 1 || (room.width >= room.height ? x > room.width - 4 : y > room.height - 4);
      case "crucible-ring": case "coil-ring": return radius >= 0.42 && radius <= 0.68;
      case "chain-gallery": return (x % 4 === 1 && y % 3 !== 0) || (y % 5 === 1 && x % 3 === 0);
      case "slag-channel": return Math.abs(dy - Math.round(Math.sin((x + room.depth) * 0.72) * 1.6)) <= 1;
      case "vent-foundry": return (Math.abs(dx) >= Math.max(2, room.halfWidth - 3) && Math.abs(dy) >= Math.max(2, room.halfHeight - 3)) || Math.abs(dx) <= 1 || Math.abs(dy) <= 1;
      case "facet-court": return Math.abs(dx - dy) <= 1 || Math.abs(dx + dy) <= 1;
      case "root-maze": return (x % 3 === 1 && y % 2 === 0) || (y % 3 === 1 && x % 4 !== 0);
      case "bloom-terrace": return Math.abs(dy) === 2 || Math.abs(dy) === Math.max(1, room.halfHeight - 2);
      case "glass-orbit": return (radius >= 0.32 && radius <= 0.48) || (radius >= 0.68 && radius <= 0.82) || Math.abs(dx) <= 1 || Math.abs(dy) <= 1;
      case "warning-grid": return x % 4 === 1 || y % 4 === 1;
      default: return (x + y + room.depth) % 6 === 0;
    }
  };
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const tile = tileAt(column, row);
    const noise = fractalNoise2D(`${run.seed}:${profile.layer}:material`, column / 13, row / 13, 4);
    tile.materialBand = Math.floor(noise * 5);
    tile.decorVariant = (tile.variant + tile.materialBand) % 6;
    tile.terrain ??= "dry";
    tile.elevation ??= 0;
    tile.traversable ??= tile.kind !== "wall";
    tile.animation ??= tile.kind === "wall" ? "static" : "material-breathe";
    const room = roomById.get(tile.roomId);
    const localColumn = room ? column - room.left : column;
    const localRow = room ? row - room.top : row;
    tile.floorPattern = room?.motifId ?? (tile.kind === "corridor" ? "corridor-threshold" : "world-boundary");
    // Floors are composed like authored rooms: one calm field, a structural
    // perimeter/threshold material, and a separate room-scale motif layer.
    // Selecting a different full-detail tile every cell creates visual noise,
    // even if it scores well on a naive repetition counter.
    const fieldCell = hash32(`${run.seed}:${profile.layer}:${tile.floorPattern}:field`) % 3;
    const trimCell = 3 + (hash32(`${run.seed}:${profile.layer}:${tile.floorPattern}:trim`) % 3);
    const edgeDistance = room
      ? Math.min(localColumn, localRow, room.width - 1 - localColumn, room.height - 1 - localRow)
      : 0;
    tile.floorZone = tile.kind === "corridor" ? "threshold" : edgeDistance <= 1 ? "trim" : "field";
    tile.floorBase = tile.floorZone === "field" ? fieldCell : trimCell;
    const macroIndex = room?.floorMacro ?? 2;
    tile.floorMacro = macroIndex;
    tile.floorMacroColumn = null;
    tile.floorMacroRow = null;
    tile.floorMacroTurns = 0;
    tile.floorMacroCollarMask = 0;
    tile.floorMacroEdgeMask = 0;
    tile.roomLocalColumn = room ? localColumn : null;
    tile.roomLocalRow = room ? localRow : null;
    tile.roomWidth = room?.width ?? null;
    tile.roomHeight = room?.height ?? null;
    if (room) {
      const stampWidth = Math.min(8, room.width);
      const stampHeight = Math.min(8, room.height);
      const destinationLeft = Math.floor((room.width - stampWidth) / 2);
      const destinationTop = Math.floor((room.height - stampHeight) / 2);
      const sourceLeft = Math.floor((8 - stampWidth) / 2);
      const sourceTop = Math.floor((8 - stampHeight) / 2);
      const destinationRight = destinationLeft + stampWidth - 1;
      const destinationBottom = destinationTop + stampHeight - 1;
      if (localColumn >= destinationLeft && localColumn < destinationLeft + stampWidth && localRow >= destinationTop && localRow < destinationTop + stampHeight) {
        if (localRow === destinationTop) tile.floorMacroEdgeMask |= 1;
        if (localColumn === destinationRight) tile.floorMacroEdgeMask |= 2;
        if (localRow === destinationBottom) tile.floorMacroEdgeMask |= 4;
        if (localColumn === destinationLeft) tile.floorMacroEdgeMask |= 8;
        let sourceColumn = sourceLeft + localColumn - destinationLeft;
        let sourceRow = sourceTop + localRow - destinationTop;
        if (room.motifTransform === "r90") {
          [sourceColumn, sourceRow] = [sourceRow, 7 - sourceColumn];
          tile.floorMacroTurns = 1;
        } else if (room.motifTransform === "r180") {
          [sourceColumn, sourceRow] = [7 - sourceColumn, 7 - sourceRow];
          tile.floorMacroTurns = 2;
        } else if (room.motifTransform === "r270") {
          [sourceColumn, sourceRow] = [7 - sourceRow, sourceColumn];
          tile.floorMacroTurns = 3;
        }
        tile.floorMacroColumn = (macroIndex % 2) * 8 + sourceColumn;
        tile.floorMacroRow = Math.floor(macroIndex / 2) * 8 + sourceRow;
      } else {
        // The first calm-field ring is a registered transition collar. Bits
        // point toward the adjacent macro edge using the shared NESW scheme.
        const withinMacroRows = localRow >= destinationTop && localRow <= destinationBottom;
        const withinMacroColumns = localColumn >= destinationLeft && localColumn <= destinationRight;
        if (withinMacroRows && localColumn === destinationLeft - 1) tile.floorMacroCollarMask |= 2;
        if (withinMacroRows && localColumn === destinationRight + 1) tile.floorMacroCollarMask |= 8;
        if (withinMacroColumns && localRow === destinationTop - 1) tile.floorMacroCollarMask |= 4;
        if (withinMacroColumns && localRow === destinationBottom + 1) tile.floorMacroCollarMask |= 1;
        if (localColumn === destinationLeft - 1 && localRow === destinationTop - 1) tile.floorMacroCollarMask = 2 | 4;
        if (localColumn === destinationRight + 1 && localRow === destinationTop - 1) tile.floorMacroCollarMask = 8 | 4;
        if (localColumn === destinationLeft - 1 && localRow === destinationBottom + 1) tile.floorMacroCollarMask = 2 | 1;
        if (localColumn === destinationRight + 1 && localRow === destinationBottom + 1) tile.floorMacroCollarMask = 8 | 1;
      }
    }
    tile.motifActive = tile.kind !== "wall" && tile.kind !== "door" && motifActiveFor(room, column, row);
    tile.motifRole = tile.motifActive ? "accent" : tile.terrain === "dry" ? "base" : "hazard";
  }
  const neighborMask = (column, row, predicate) => VAULT_CARDINAL_NEIGHBORS.reduce((mask, { dx, dy, bit }) => {
    const nextColumn = column + dx;
    const nextRow = row + dy;
    return mask | (nextColumn >= 0 && nextRow >= 0 && nextColumn < columns && nextRow < rows && predicate(tileAt(nextColumn, nextRow)) ? bit : 0);
  }, 0);
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const tile = tileAt(column, row);
    tile.adjacencyMask = neighborMask(column, row, (neighbor) => neighbor.kind === tile.kind);
    tile.walkableMask = neighborMask(column, row, (neighbor) => neighbor.kind !== "wall");
    tile.wallMask = neighborMask(column, row, (neighbor) => neighbor.kind === "wall");
    tile.exposureMask = tile.kind === "wall" ? tile.walkableMask : 0;
    tile.terrainMask = tile.kind === "wall" ? 0 : neighborMask(column, row, (neighbor) => neighbor.kind !== "wall" && neighbor.terrain === tile.terrain);
    tile.shoreMask = tile.terrain === "water" ? neighborMask(column, row, (neighbor) => neighbor.kind !== "wall" && neighbor.terrain !== "water") : 0;
    tile.motifMask = tile.motifActive ? neighborMask(column, row, (neighbor) => neighbor.roomId === tile.roomId && neighbor.motifActive) : 0;
    tile.autotileRole = classifyAutotileMask(tile.kind === "wall" ? tile.wallMask : tile.adjacencyMask);
    if (tile.kind === "wall") {
      tile.wallJoinRole = classifyAutotileMask(tile.exposureMask);
      tile.wallFamily = ["bulkhead", "ribbed", "conduit"][tile.materialBand % 3];
      tile.wallCornerMask = ((tile.exposureMask & 1) && (tile.exposureMask & 2) ? 1 : 0)
        | ((tile.exposureMask & 2) && (tile.exposureMask & 4) ? 2 : 0)
        | ((tile.exposureMask & 4) && (tile.exposureMask & 8) ? 4 : 0)
        | ((tile.exposureMask & 8) && (tile.exposureMask & 1) ? 8 : 0);
    }
    if (tile.kind === "door") {
      const horizontal = Boolean(tile.walkableMask & 2) && Boolean(tile.walkableMask & 8);
      const vertical = Boolean(tile.walkableMask & 1) && Boolean(tile.walkableMask & 4);
      tile.doorAxis ??= horizontal && !vertical ? "horizontal" : vertical && !horizontal ? "vertical" : (tile.walkableMask & 10) ? "horizontal" : "vertical";
    }
  }
  const spawn = { x: (rooms[0].column + 0.5) * tileWidth, y: (rooms[0].row + 0.5) * tileHeight };
  const finalRoom = rooms.find((room) => room.final);
  const exit = { roomId: finalRoom.id, x: (finalRoom.column + 0.5) * tileWidth, y: (finalRoom.row + 0.5) * tileHeight, locked: true };
  return { schema: "vault-world-graph@6", viewport: { width, height }, columns, rows, tileWidth, tileHeight, corridorWidth, worldWidth, worldHeight, tiles, rooms, connections, objects, features, spawn, exit };
}

export function createShopChoices(atlas, run, layer) {
  const rng = makeRng(`${run.seed}:shop:${layer}`);
  return seededSubset(atlas.shop.upgrades, rng, atlas.shop.choices, atlas.shop.choices);
}

export function deterministicFingerprint(value) {
  return hash32(JSON.stringify(value)).toString(16).padStart(8, "0");
}

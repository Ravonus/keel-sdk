const decoder = new TextDecoder("utf-8", { fatal: true });

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

export function parseSemiBoneRig(source) {
  const rig = JSON.parse(
    typeof source === "string" ? source : decoder.decode(source),
  );
  if (rig.schema !== "keel-semi-bone-rig@1")
    throw new TypeError("Unsupported semi-bone rig schema.");
  if (!Array.isArray(rig.bones) || rig.bones.length < 1)
    throw new TypeError("A semi-bone rig requires bones.");
  const ids = new Set();
  for (const bone of rig.bones) {
    if (typeof bone.id !== "string" || bone.id.length === 0)
      throw new TypeError("Every bone requires an id.");
    if (ids.has(bone.id)) throw new TypeError(`Duplicate bone ${bone.id}.`);
    if (bone.parent !== null && !ids.has(bone.parent))
      throw new TypeError(`Bone ${bone.id} has an unresolved parent.`);
    ids.add(bone.id);
    finite(bone.length, `${bone.id}.length`);
    finite(bone.restAngle, `${bone.id}.restAngle`);
    if (!Array.isArray(bone.anchor) || bone.anchor.length !== 2)
      throw new TypeError(`Bone ${bone.id} requires a two-value anchor.`);
    bone.anchor.forEach((value, index) =>
      finite(value, `${bone.id}.anchor[${index}]`),
    );
  }
  for (const animation of Object.values(rig.animations ?? {})) {
    if (!Array.isArray(animation.keyframes) || animation.keyframes.length < 2)
      throw new TypeError("Every animation requires at least two keyframes.");
    let prior = -1;
    for (const keyframe of animation.keyframes) {
      finite(keyframe.at, "keyframe.at");
      if (keyframe.at < prior || keyframe.at < 0 || keyframe.at > 1)
        throw new TypeError("Animation keyframes must be ordered from 0 to 1.");
      prior = keyframe.at;
      for (const [boneId, angle] of Object.entries(keyframe.angles ?? {})) {
        if (!ids.has(boneId))
          throw new TypeError(`Animation targets unknown bone ${boneId}.`);
        finite(angle, `${boneId} keyframe angle`);
      }
    }
  }
  return rig;
}

function interpolate(left, right, amount) {
  return left + (right - left) * amount;
}

export function sampleSemiBoneAnimation(rig, animationId, progress) {
  const animation = rig.animations[animationId];
  if (!animation) throw new TypeError(`Unknown animation ${animationId}.`);
  const time = Math.max(0, Math.min(1, finite(progress, "progress")));
  let rightIndex = animation.keyframes.findIndex((frame) => frame.at >= time);
  if (rightIndex < 0) rightIndex = animation.keyframes.length - 1;
  const right = animation.keyframes[rightIndex];
  const left = animation.keyframes[Math.max(0, rightIndex - 1)];
  const span = right.at - left.at;
  const amount = span === 0 ? 0 : (time - left.at) / span;
  const angles = {};
  for (const bone of rig.bones) {
    const from = left.angles?.[bone.id] ?? 0;
    const to = right.angles?.[bone.id] ?? from;
    angles[bone.id] = bone.restAngle + interpolate(from, to, amount);
  }
  return { animationId, progress: time, angles };
}

export function solveSemiBonePose(rig, sample, direction = "east") {
  const solved = new Map();
  for (const bone of rig.bones) {
    const parent = bone.parent === null ? undefined : solved.get(bone.parent);
    const angle = (parent?.angle ?? 0) + sample.angles[bone.id];
    let x;
    let y;
    if (!parent) {
      x = rig.origin[0];
      y = rig.origin[1];
    } else {
      const along = bone.anchor[0] * parent.length;
      const across = bone.anchor[1];
      x =
        parent.x +
        Math.cos(parent.angle) * along -
        Math.sin(parent.angle) * across;
      y =
        parent.y +
        Math.sin(parent.angle) * along +
        Math.cos(parent.angle) * across;
    }
    solved.set(bone.id, {
      id: bone.id,
      parent: bone.parent,
      x,
      y,
      endX: x + Math.cos(angle) * bone.length,
      endY: y + Math.sin(angle) * bone.length,
      angle,
      length: bone.length,
      socket: bone.socket ?? null,
      side: bone.side ?? "center",
    });
  }
  if (direction === "west") {
    const axis = rig.origin[0] * 2;
    for (const bone of solved.values()) {
      bone.x = axis - bone.x;
      bone.endX = axis - bone.endX;
      bone.angle = Math.atan2(bone.endY - bone.y, bone.endX - bone.x);
    }
  }
  return solved;
}

/** Framework-free orbit-camera matrices for lightweight 3D artwork. MIT. */
export function orbitPosition({ target = [0, 0, 0], yaw = 0, pitch = 0, distance = 5 }) {
  const safePitch = Math.min(Math.max(pitch, -Math.PI / 2 + 0.001), Math.PI / 2 - 0.001);
  const radius = Math.max(Number(distance), 0.001);
  const horizontal = Math.cos(safePitch) * radius;
  return [
    target[0] + Math.sin(yaw) * horizontal,
    target[1] + Math.sin(safePitch) * radius,
    target[2] + Math.cos(yaw) * horizontal,
  ];
}

export function perspectiveMatrix(fieldOfView, aspect, near = 0.1, far = 1_000) {
  if (!(fieldOfView > 0 && fieldOfView < Math.PI) || !(aspect > 0) || !(near > 0) || !(far > near)) throw new RangeError("Invalid perspective parameters.");
  const f = 1 / Math.tan(fieldOfView / 2);
  const range = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (near + far) * range, -1, 0, 0, 2 * near * far * range, 0]);
}

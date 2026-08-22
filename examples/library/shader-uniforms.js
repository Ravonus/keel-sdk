/** WebGL uniform discovery and strict typed updates without eval or hidden globals. MIT. */
export function createUniformWriter(gl, program) {
  const entries = new Map();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let index = 0; index < count; index += 1) {
    const info = gl.getActiveUniform(program, index);
    if (info !== null) entries.set(info.name.replace(/\[0\]$/u, ""), { info, location: gl.getUniformLocation(program, info.name) });
  }
  return function setUniform(name, value) {
    const entry = entries.get(name);
    if (entry === undefined || entry.location === null) throw new Error(`Unknown uniform ${name}.`);
    const { type } = entry.info;
    if (type === gl.FLOAT) gl.uniform1f(entry.location, Number(value));
    else if (type === gl.FLOAT_VEC2) gl.uniform2fv(entry.location, value);
    else if (type === gl.FLOAT_VEC3) gl.uniform3fv(entry.location, value);
    else if (type === gl.FLOAT_VEC4) gl.uniform4fv(entry.location, value);
    else if (type === gl.INT || type === gl.BOOL || type === gl.SAMPLER_2D) gl.uniform1i(entry.location, Number(value));
    else if (type === gl.FLOAT_MAT4) gl.uniformMatrix4fv(entry.location, false, value);
    else throw new TypeError(`Uniform ${name} uses an unsupported WebGL type ${type}.`);
  };
}

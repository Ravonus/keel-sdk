function start(libraries) {

  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');

  // Create a WebGL program with shaders
  const vs = `
  attribute vec2 position;
  uniform float t;
  void main() {
    float r = position.x;
    float theta = position.y * t;
    float x = r * sin(theta);
    float y = r * cos(theta);
    gl_Position = vec4(x, y, 0, 1);
    gl_PointSize = 3.0;
  }
`;

  const fs = `
  precision mediump float;
  void main() {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
`;

  let deltaT = 0.01; // Starting speed
  const decayFactor = 0.98; // Decay factor less than 1

  // Define the range of speed changes
  const maxDeltaT = 0.01;
  const minDeltaT = 0.0000001;

  let isDecaying = true; // Whether we're currently slowing down or not

  const programInfo = twgl.createProgramInfo(gl, [vs, fs]);

  let maxSpread = 5000;
  // const spreadIncrement = 0.1; // Control this for spread speed


  let spreadIncrement = -  1.0;
  let points = [];
  const n = 999;
  let p = new Array(n).fill(0);
  let t = 1;
  for (let i = 2; i < n; i++) {
    if (p[i] === 0) {
      for (let j = i + i; j < n; j += i) {
        p[j] = i;
      }
    }
  }

  function computePoints() {
    points = [];
    for (let i = 2; i < n; i++) {
      if (p[i] === 0) {
        const r = i / Math.max(maxSpread, 0.05); // Ensure maxSpread doesn't go too low
        const theta = i;
        points.push([r, theta]);
      }
    }
    return {
      position: { numComponents: 2, data: points.flat() }
    };
  }

  let arrays = computePoints();
  let bufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);

  function render() {

    maxSpread += spreadIncrement;
    maxSpread = Math.max(maxSpread, 0.05);

    // Recompute point positions with new maxSpread
    arrays = computePoints();
    bufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(programInfo.program);
    twgl.setUniforms(programInfo, { t: t });
    twgl.setBuffersAndAttributes(gl, programInfo, bufferInfo);
    twgl.drawBufferInfo(gl, bufferInfo, gl.POINTS);

    if (isDecaying) {
      t += deltaT; // forward
      deltaT *= decayFactor;
    } else {
      t -= deltaT; // reverse
      deltaT /= decayFactor;
    }

    // Check bounds and switch the direction of change
    if (deltaT < minDeltaT) {
      isDecaying = false;
    } else if (deltaT > maxDeltaT) {
      isDecaying = true;
    }

    requestAnimationFrame(render);
  }
  // Clear color and initialize rendering
  gl.clearColor(0, 0, 0, 1);
  render();

}
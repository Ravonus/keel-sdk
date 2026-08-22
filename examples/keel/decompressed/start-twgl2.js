function start(libraries) {
  const m4 = twgl.m4;

  const canvas = document.createElement('canvas');
  canvas.id = 'c';
  canvas.width = document.body.clientWidth;
  canvas.height = document.body.clientHeight;
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl');

  const programInfo = twgl.createProgramInfo(gl, ["vs", "fs"]);

  const arrays = {
    position: [1, 1, -1, 1, 1, 1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, -1, -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1, -1, 1, -1, 1, 1, -1, 1, -1, -1, -1, -1, -1],
    normal: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1],
    texcoord: [1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1],
    indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23],
  };
  const bufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);

  const tex = twgl.createTexture(gl, {
    min: gl.NEAREST,
    mag: gl.NEAREST,
    src: [
      255, 255, 255, 255,
      192, 192, 192, 255,
      192, 192, 192, 255,
      255, 255, 255, 255,
    ],
  });

  const normalizedSeed = Number(seed) % 1000000 / 1000000;
  const floatingSpeed = 0.1 + normalizedSeed * 1.9; // this maps [0, 1) to [0.1, 2.0)

  const red = getColorComponent(seed, 0, 255) / 255;
  const green = getColorComponent(seed, 1, 255) / 255;
  const blue = getColorComponent(seed, 2, 255) / 255;

  const ambientRed = getColorComponent(seed, 3, 255) / 255;
  const ambientGreen = getColorComponent(seed, 4, 255) / 255;
  const ambientBlue = getColorComponent(seed, 5, 255) / 255;

  //get light pos based on seed 1-100
  const lightPosOne = Math.floor(normalizedSeed * 12) * 100 / 100;
  const lightPosTwo = Math.floor((normalizedSeed * 20) * 100) / 100;

  console.log(lightPosOne, lightPosTwo);

  const uniforms = {
    u_lightWorldPos: [lightPosOne, lightPosTwo, -10],
    u_lightColor: [red, green, blue, 1],
    u_ambient: [ambientRed, ambientGreen, ambientBlue, 1],
    u_specular: [1, 1, 1, 1],
    u_shininess: 50,
    u_specularFactor: 1,
    u_diffuse: tex,
  };

  function render(time) {
    time *= 0.001 * floatingSpeed; // using floatingSpeed to affect rotation speed
    twgl.resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const fov = 30 * Math.PI / 180;
    const aspect = gl.canvas.clientWidth / gl.canvas.clientHeight;
    const zNear = 0.5;
    const zFar = 10;
    const projection = m4.perspective(fov, aspect, zNear, zFar);
    const eye = [1, 4, -6];
    const target = [0, 0, 0];
    const up = [0, 1, 0];

    const camera = m4.lookAt(eye, target, up);
    const view = m4.inverse(camera);
    const viewProjection = m4.multiply(projection, view);
    const world = m4.rotationY(time);

    uniforms.u_viewInverse = camera;
    uniforms.u_world = world;
    uniforms.u_worldInverseTranspose = m4.transpose(m4.inverse(world));
    uniforms.u_worldViewProjection = m4.multiply(viewProjection, world);

    gl.useProgram(programInfo.program);
    twgl.setBuffersAndAttributes(gl, programInfo, bufferInfo);
    twgl.setUniforms(programInfo, uniforms);
    gl.drawElements(gl.TRIANGLES, bufferInfo.numElements, gl.UNSIGNED_SHORT, 0);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}
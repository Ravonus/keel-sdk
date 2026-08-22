const colorThemes = ['rainbow', 'pastel', 'earthTones', 'neon', 'grunge'];


function generateColorTheme(theme, seed, index) {
  seed = Number(seed)

  const colorThemes = {
    rainbow: [
      [1, 0, 0], // Red
      [1, 0.16, 0], // Red-Orange
      [1, 0.32, 0], // Orange-Red
      [1, 0.5, 0], // Orange
      [1, 0.66, 0], // Orange-Yellow
      [1, 0.83, 0], // Yellow-Orange
      [1, 1, 0], // Yellow
      [0.66, 1, 0], // Yellow-Green
      [0.33, 1, 0], // Green-Yellow
      [0, 1, 0], // Green
      [0, 1, 0.33], // Green-Cyan
      [0, 1, 0.66], // Cyan-Green
      [0, 1, 1], // Cyan
      [0, 0.66, 1], // Cyan-Blue
      [0, 0.33, 1], // Blue-Cyan
      [0, 0, 1], // Blue
      [0.33, 0, 1], // Blue-Indigo
      [0.66, 0, 1], // Indigo-Blue
      [0.83, 0, 1], // Indigo
      [1, 0, 0.83], // Indigo-Violet
      [1, 0, 0.66], // Violet-Indigo
      [1, 0, 0.5], // Violet
    ],
    pastel: [
      [1, 0.7, 0.8], // Pastel Pink
      [0.8, 1, 0.8], // Pastel Green
      [0.8, 0.8, 1], // Pastel Blue
      [1, 1, 0.8], // Pastel Yellow
      [1, 0.8, 0.7], // Pastel Orange
      [0.9, 0.7, 1], // Pastel Purple
      [1, 0.9, 1], // Pastel Violet
      [0.7, 1, 1], // Pastel Cyan
      [0.9, 1, 0.9], // Soft Green
    ],
    neon: [
      [1, 0, 0], // Red
      [1, 0.5, 0], // Orange
      [1, 1, 0], // Yellow
      [0.5, 1, 0], // Lime
      [0, 1, 0], // Green
      [0, 1, 0.5], // Mint
      [0, 1, 1], // Cyan
      [0, 0.5, 1], // Sky blue
      [0, 0, 1], // Blue
      [0.5, 0, 1], // Purple
      [1, 0, 1], // Magenta
      [1, 0, 0.5], // Hot pink
    ],
    earthTones: [
      [0.4, 0.26, 0.13], // Brown
      [0.6, 0.33, 0.22], // Darker Brown
      [0.45, 0.37, 0.22], // Olive
      [0.3, 0.4, 0.28], // Moss Green
      [0.63, 0.44, 0.28], // Mud Brown
      [0.4, 0.5, 0.3], // Forest Green
      [0.5, 0.35, 0.25], // Sepia
      [0.7, 0.52, 0.25], // Golden Brown
      [0.4, 0.4, 0.2], // Dark Olive
    ],

    grunge: [
      [0.33, 0.33, 0.33], // Dark Gray
      [0.4, 0.4, 0.4], // Gray
      [0.28, 0.28, 0.28], // Darker Gray
      [0.5, 0.5, 0.5], // Medium Gray
      [0.6, 0.6, 0.6], // Lighter Gray
      [0.44, 0.44, 0.44], // Steel Gray
      [0.3, 0.3, 0.3], // Graphite
      [0.55, 0.47, 0.42], // Stone
      [0.46, 0.46, 0.42], // Cement Gray
    ],
  };

  let seedFactor = (seed * index) + (seed / (index + 1));
  let randomIndex = Math.floor(Math.abs(Math.sin(seedFactor) * colorThemes[theme].length));
  return colorThemes[theme][randomIndex];
}


function start(libraries) {

  THREE.VRButton = libraries.ARButton;
  THREE.OrbitControls = libraries.OrbitControls;

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    10000
  );
  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  let n = (Number(seed) % 1000000)

  var p = new Array(n).fill(0);
  var i, j;
  var t = (Number(seed) + 69) % 2500;
  var maxRadius = Number(seed) % 1000000 / 1000000 * 0.5 + 0.5;
  var ar = false;

  for (i = 2; i < n; i++) {
    if (p[i] == 0) {
      for (j = i + i; j < n; j += i) {
        p[j] = i;
      }
    }
  }

  var vertices2D = [];
  var vertices3D = [];
  var colors = [];

  var sumX = 0,
    sumY = 0,
    sumZ = 0;
  var count = 0;

  for (i = 2; i < n; i++) {
    if (p[i] == 0) {
      var theta = 2 * Math.PI * Math.random();
      var phi = Math.PI * Math.random();
      var x3D = maxRadius * Math.sin(phi) * Math.cos(theta);
      var y3D = maxRadius * Math.sin(phi) * Math.sin(theta);
      var z3D = maxRadius * Math.cos(phi);

      sumX += x3D;
      sumY += y3D;
      sumZ += z3D;
      count++;

      vertices3D.push(x3D, y3D, z3D - maxRadius / 2);

      var x2D = (i * Math.sin(i * t)) / 99;
      var y2D = (i * Math.cos(i * t)) / 93;
      vertices2D.push(x2D, y2D, 0);

      const theme = colorThemes[Number(seed) % colorThemes.length];

      colors.push(...generateColorTheme(theme, Number(seed), i));
    }
  }

  var avgX = sumX / count;
  var avgY = sumY / count;
  var avgZ = sumZ / count;

  for (i = 0; i < vertices3D.length; i += 3) {
    vertices3D[i] -= avgX;
    vertices3D[i + 1] -= avgY;
    vertices3D[i + 2] -= avgZ;
  }

  var geometry2D = new THREE.BufferGeometry();
  geometry2D.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(vertices2D, 3)
  );
  geometry2D.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  var geometry3D = new THREE.BufferGeometry();
  geometry3D.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(vertices3D, 3)
  );
  geometry3D.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  //size 0.01 - 0.1
  const size = Number(seed) % 1000000 / 1000000 * 0.09 + 0.01;
  var material = new THREE.PointsMaterial({ size, vertexColors: true });

  var points = new THREE.Points(geometry2D, material);
  scene.add(points);

  camera.position.z = 5;

  var controls = new THREE.OrbitControls(camera, renderer.domElement);

  renderer.xr.enabled = true;
  document.body.appendChild(THREE.VRButton.createButton(renderer));

  renderer.xr.addEventListener('sessionstart', function () {
    ar = true;
    camera.position.set(0, 0, 0); // set camera position here

    n = n * 5;

    renderer.setClearColor(0x000000, 0);
    scene.remove(points);
    points = new THREE.Points(geometry3D, material);
    scene.add(points);
    var theta = 0;
    var deltaTheta = (2 * Math.PI) / vertices3D.length;
    for (var i = 0; i < vertices3D.length; i += 3) {
      var radius = Math.sqrt(
        vertices3D[i] * vertices3D[i] + vertices3D[i + 1] * vertices3D[i + 1]
      );
      vertices3D[i] = radius * Math.cos(theta);
      vertices3D[i + 1] = radius * Math.sin(theta);
      theta += deltaTheta;
    }
    geometry3D.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices3D, 3)
    );
  });

  renderer.xr.addEventListener('sessionend', function () {
    ar = false;
    n = n / 5;
    camera.position.z = 5;
    renderer.setClearColor(0x000000, 1);
    scene.remove(points);
    points = new THREE.Points(geometry2D, material);
    scene.add(points);
  });

  var speed = Number(seed) % 1000000 / 1000000 * 0.0001 + 0.0001;

  renderer.setAnimationLoop(function () {
    var time = performance.now() * speed;

    for (i = 2, j = 0; i < n; i++) {
      if (p[i] == 0) {
        //set xOff and yOff 20-200
        var xOff = Number(seed) % 1000000 / 1000000 * 180 + 20;
        var yOff = (Number(seed) + 69) % 1000000 / 1000000 * 180 + 20;
        var x = (i * Math.sin(i * t + time)) / xOff;
        var y = (i * Math.cos(i * t + time)) / yOff;
        vertices2D[j++] = x;
        vertices2D[j++] = y;
        vertices2D[j++] = 0;
      }
    }

    geometry2D.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices2D, 3)
    );
    geometry3D.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices3D, 3)
    );

    scene.position.set(
      -camera.position.x,
      -camera.position.y,
      -camera.position.z
    );
    if (ar)
      points.rotation.y += 0.01; // rotate the points around their center

    t += 1e-5 * speed;
    renderer.render(scene, camera);
  });

  function onWindowResize() {
    // Update renderer size
    renderer.setSize(window.innerWidth, window.innerHeight);

    // Update camera properties
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', onWindowResize, false);
}
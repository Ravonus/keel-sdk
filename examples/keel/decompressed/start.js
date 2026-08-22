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

  var n = 500000;
  var p = new Array(n).fill(0);
  var i, j;
  var t = 33333123;
  var maxRadius = 1000;

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

      colors.push(Math.random(), Math.random(), Math.random());
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

  var material = new THREE.PointsMaterial({ size: 0.1, vertexColors: true });

  var points = new THREE.Points(geometry2D, material);
  scene.add(points);

  camera.position.z = 5;

  var controls = new THREE.OrbitControls(camera, renderer.domElement);

  renderer.xr.enabled = true;
  document.body.appendChild(THREE.VRButton.createButton(renderer));

  renderer.xr.addEventListener('sessionstart', function () {
    camera.position.set(0, 0, 0); // set camera position here
    // camera.position.z = maxRadius / 2;
    // camera.position.x = maxRadius / 2;
    // camera.position.y = maxRadius / 2;
    //camera.lookAt(0, 0, 0);
    n = 500000;

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
    n = 5000000;
    camera.position.z = 5;
    renderer.setClearColor(0x000000, 1);
    scene.remove(points);
    points = new THREE.Points(geometry2D, material);
    scene.add(points);
  });

  var speed = 0.5;

  renderer.setAnimationLoop(function () {
    var time = performance.now() * speed;

    for (i = 2, j = 0; i < n; i++) {
      if (p[i] == 0) {
        var x = (i * Math.sin(i * t + time)) / 99;
        var y = (i * Math.cos(i * t + time)) / 93;
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

    points.rotation.y += 0.01; // rotate the points around their center

    t += 1e-15 * -speed;
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

function start(libraries) {


  //create totalDistance div that display in the moddle of page (middle of commet)

  const td = document.createElement('div');
  td.style.position = 'absolute';
  td.style.top = '50%';
  td.style.left = '50%';
  td.style.color = 'white';
  td.style.fontFamily = 'monospace';
  td.style.display = 'flex';
  td.style.flexDirection = 'column';
  td.id = 'td';
  document.body.appendChild(td);


  new p5((p) => {
    let angleOffset = Number(seed) % 360 + 15;
    let angleStep = p.TWO_PI / angleOffset
    let streaks = [];
    let colors = [];
    let rotationSpeeds = [];
    let rotationDirections = [];
    let lineCount = Number(seed) % 200 + 75;
    let circleCount = Number(seed) % 10 + 2;
    let gravity = Number(seed) % 2.0 + 0.5;

    let timeStart = 1694151372588;

    let distance = 0;

    //calculate distance from start time and gravity
    distance = (Date.now() - timeStart) * (gravity * 3)

    //set totalDistance div to distance
    document.getElementById('td').innerHTML = distance;

    //set textsize based on length of distance

    td.style.fontSize = (distance.toString().length / 0.475) + 'px';

    p.setup = () => {
      p.createCanvas(p.windowWidth, p.windowHeight);

      // Initialize the colors array with random colors
      for (let i = 0; i < circleCount; i++) {
        //set r,g,b float based on seed
        let r = getColorComponent(seed, i, 255);
        let g = getColorComponent(seed, i + 1, 255);
        let b = getColorComponent(seed, i + 2, 255);

        colors.push(p.color(r, g, b));
      }

      for (let i = 0; i < lineCount; i++) {
        createStreak(i % colors.length);
      }
    };

    function createStreak(colorIndex) {
      let angle = p.random(p.PI)
      let radiusWidth = Number(seed) % 100 + 25;
      let radius = radiusWidth + colorIndex * 10;
      let x = p.windowWidth / 2 + radius * p.cos(angle);
      let y = p.windowHeight / 1.92 - radius * p.sin(angle);

      //make speed higher depending on gravity and seed so its always the same
      let speed = ((Number(seed) % 25) + 5) * (gravity * 3)
      let lowLength = ((Number(seed) % 10) + 5) * (gravity * 2.5)
      let highLength = ((Number(seed) % 250) + 5) * (gravity * 3.5) + 250

      distance += gravity;

      //set totalDistance div to distance

      //round up
      distance = Math.round(distance);

      document.getElementById('td').innerHTML = distance;

      let streak = {
        x,
        y,
        length: p.random(lowLength, highLength),
        speed,
        color: colors[colorIndex],
        weight: p.random(0.01, 0.5)
      };
      streaks.push(streak);
    }

    p.draw = () => {
      p.background(0);

      // Adding a bobbing effect to the circles
      let bobbingEffect = 20 * p.sin(p.frameCount / 25);

      //give td dive the bobbineffect as well so it moves with comet

      td.style.transform = 'translate(-50%, -50%)' + 'translate(0px, ' + bobbingEffect + 'px)';




      // Update the rotation speeds at the beginning of a new cycle
      if (p.frameCount % colors.length === 0) {
        for (let i = 0; i < colors.length; i++) {
          rotationSpeeds[i] = p.random(0.01, 0.03);
          rotationDirections[i] = p.random([-1, 1]);
        }
      }

      // Drawing and updating the streaks
      for (let i = streaks.length - 1; i >= 0; i--) {
        let s = streaks[i];
        p.stroke(s.color);
        p.strokeWeight(s.weight);

        let waveFactor = p.noise(p.frameCount / 50 + i) * 50; // Adding waviness to the streaks
        //change 15,152 to change tail speed
        let angleOffset = p.map(p.sin(p.frameCount / 25), -1, 1, -p.PI / 100, p.PI / 100);
        let x2 = s.x - (s.length + waveFactor) * p.cos(p.radians(75) + angleOffset);
        let y2 = s.y - (s.length + waveFactor) * p.sin(p.radians(75) + angleOffset) + bobbingEffect;

        p.line(s.x, s.y + bobbingEffect, x2, y2);

        // Updating streak properties
        s.length += s.speed;

        // Resetting streaks that have grown too long
        if (s.length > 600) {
          streaks.splice(i, 1);
          createStreak(colors.indexOf(s.color));
        }
      }

      // Drawing a pseudo-circle in the center with the background color
      p.noStroke();
      p.fill(0);
      p.beginShape();
      let lastIdx = (p.frameCount + colors.length - 1) % colors.length;
      for (let i = 0; i <= p.TWO_PI; i += angleStep) {
        let radiusCloseness = (Number(seed) % 75) + 5;
        const radiusOffset = Number(seed) % 100 + lastIdx * 0.6 + radiusCloseness * p.noise(p.frameCount / 50 + i * 10 + lastIdx * 10);
        let radius = radiusOffset + lastIdx * 0.6 + radiusCloseness * p.noise(p.frameCount / 50 + i * 10 + lastIdx * 10);
        let x = p.windowWidth / 2 + radius * p.cos(i);
        let y = p.windowHeight / 2 - radius * p.sin(i) + bobbingEffect;
        p.vertex(x, y);
      }
      p.endShape(p.CLOSE);

      // Drawing the central wavy circles with colored segments
      let startIdx = p.frameCount % colors.length;
      for (let j = 0; j < colors.length; j++) {
        let idx = (startIdx + j) % colors.length;

        p.strokeWeight(2);
        p.noFill();
        p.stroke(colors[idx]);
        let rotationAngle = p.frameCount * rotationSpeeds[j] * rotationDirections[j];

        p.beginShape();
        for (let i = 0; i <= p.TWO_PI; i += angleStep) {
          let radiusCloseness = (Number(seed) % 75) + 5;
          const radiusOffset = Number(seed) % 100 + idx * 0.6 + radiusCloseness * p.noise(p.frameCount / 50 + i * 10 + idx * 10);
          let radius = radiusOffset + idx * 0.6 + radiusCloseness * p.noise(p.frameCount / 50 + i * 10 + idx * 10); // Referencing the new index
          let x = p.windowWidth / 2 + radius * p.cos(i + rotationAngle);
          let y = p.windowHeight / 2 - radius * p.sin(i + rotationAngle) + bobbingEffect;
          p.vertex(x, y);
        }
        p.endShape(p.CLOSE);
      }
    };
  });
}
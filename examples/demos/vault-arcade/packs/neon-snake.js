// Full replacement Keel map runtime. It intentionally shares only the
// verified map seed, canvas contract, and score protocol with Vault Arcade.
export const descriptor = Object.freeze({
  schema: "keel-map-runtime@1",
  id: "neon-snake",
  name: "Neon Snake",
  replacesBaseGame: true,
  inputs: ["mapSeed", "mapRevision"],
  score: "length*100 + pickups*wave",
  controls: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"],
});

function seedHash(value) {
  let state = 0x811c9dc5;
  for (const character of String(value)) state = Math.imul(state ^ character.charCodeAt(0), 0x01000193);
  return state >>> 0;
}

export function createMapGame({ canvas, mapSeed, onScore = () => {} }) {
  const context = canvas.getContext("2d");
  const cells = 24;
  const state = {
    snake: [{ x: 12, y: 12 }, { x: 11, y: 12 }, { x: 10, y: 12 }],
    direction: { x: 1, y: 0 },
    queued: { x: 1, y: 0 },
    food: { x: 18, y: 12 },
    score: 0,
    step: 0,
    running: true,
  };
  const nextFood = () => {
    const hash = seedHash(`${mapSeed}:${state.step}:${state.score}`);
    state.food = { x: hash % cells, y: (hash >>> 8) % cells };
  };
  const keydown = (event) => {
    const direction = {
      ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
      ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
    }[event.code];
    if (direction && (direction[0] !== -state.direction.x || direction[1] !== -state.direction.y)) {
      state.queued = { x: direction[0], y: direction[1] };
      event.preventDefault();
    }
  };
  window.addEventListener("keydown", keydown);
  const tick = () => {
    if (!state.running) return;
    state.direction = state.queued;
    const head = state.snake[0];
    const next = {
      x: (head.x + state.direction.x + cells) % cells,
      y: (head.y + state.direction.y + cells) % cells,
    };
    if (state.snake.some((cell) => cell.x === next.x && cell.y === next.y)) state.running = false;
    else {
      state.snake.unshift(next);
      if (next.x === state.food.x && next.y === state.food.y) {
        state.score += state.snake.length * 100;
        onScore(state.score);
        nextFood();
      } else state.snake.pop();
      state.step += 1;
    }
    draw();
  };
  const draw = () => {
    const size = Math.min(canvas.width, canvas.height) / cells;
    context.fillStyle = "#05050b";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ff42cc";
    context.fillRect(state.food.x * size, state.food.y * size, size, size);
    state.snake.forEach((cell, index) => {
      context.fillStyle = index === 0 ? "#dffff8" : `hsl(${175 + index * 3} 86% ${58 - Math.min(index, 20)}%)`;
      context.fillRect(cell.x * size + 1, cell.y * size + 1, size - 2, size - 2);
    });
  };
  draw();
  const timer = setInterval(tick, 92);
  return { descriptor, state, destroy() { clearInterval(timer); window.removeEventListener("keydown", keydown); } };
}

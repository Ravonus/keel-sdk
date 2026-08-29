const errors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...values) => {
  errors.push(values.map((value) => String(value)).join(" "));
  originalConsoleError(...values);
};
addEventListener("error", (event) => errors.push(event.message || "window error"));
addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
globalThis.__keelThreeR180Harness = { errors };

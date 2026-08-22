/** Scoped, removable keyboard-command map for opaque artwork documents. MIT. */
export function createHotkeys(bindings, { target = window, ignoreInputs = true } = {}) {
  const normalized = new Map(Object.entries(bindings).map(([key, handler]) => [key.toLowerCase(), handler]));
  const listener = (event) => {
    if (ignoreInputs && event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]")) return;
    const chord = [event.metaKey || event.ctrlKey ? "mod" : "", event.altKey ? "alt" : "", event.shiftKey ? "shift" : "", event.key.toLowerCase()].filter(Boolean).join("+");
    const handler = normalized.get(chord) ?? normalized.get(event.key.toLowerCase());
    if (handler === undefined) return;
    event.preventDefault();
    handler(event);
  };
  target.addEventListener("keydown", listener);
  return { destroy() { target.removeEventListener("keydown", listener); } };
}

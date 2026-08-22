export const VAULT_INPUT_STORAGE_KEY = "vault:input-bindings:v1";

export const VAULT_INPUT_ACTIONS = Object.freeze([
  Object.freeze({ id: "moveUp", label: "Move up", defaultCode: "KeyW" }),
  Object.freeze({ id: "moveDown", label: "Move down", defaultCode: "KeyS" }),
  Object.freeze({ id: "moveLeft", label: "Move left", defaultCode: "KeyA" }),
  Object.freeze({ id: "moveRight", label: "Move right", defaultCode: "KeyD" }),
  Object.freeze({ id: "boost", label: "Boost", defaultCode: "ShiftLeft" }),
  Object.freeze({ id: "escape", label: "Escape", defaultCode: "Space" }),
  Object.freeze({ id: "pulse", label: "Core Flare", defaultCode: "KeyQ" }),
  Object.freeze({ id: "block", label: "Block", defaultCode: "KeyE" }),
  Object.freeze({ id: "fire", label: "Fire / charge", defaultCode: "KeyF" }),
]);

export const VAULT_DEFAULT_BINDINGS = Object.freeze(Object.fromEntries(VAULT_INPUT_ACTIONS.map((action) => [action.id, action.defaultCode])));

export function sanitizeVaultBindings(value) {
  const input = value && typeof value === "object" ? value : {};
  return Object.freeze(Object.fromEntries(VAULT_INPUT_ACTIONS.map((action) => {
    const code = typeof input[action.id] === "string" && input[action.id].length <= 24 ? input[action.id] : action.defaultCode;
    return [action.id, code];
  })));
}

export function vaultActionForCode(bindings, code) {
  return VAULT_INPUT_ACTIONS.find((action) => bindings[action.id] === code)?.id ?? null;
}

export function vaultBindingLabel(code) {
  return String(code ?? "").replace(/^Key/u, "").replace(/^Digit/u, "").replace("Arrow", "").replace("ShiftLeft", "L Shift").replace("ShiftRight", "R Shift").replace("Space", "Space");
}

function vaultStick(value, deadzone = .18) {
  const number = Math.max(-1, Math.min(1, Number(value) || 0));
  if (Math.abs(number) <= deadzone) return 0;
  return Math.sign(number) * (Math.abs(number) - deadzone) / (1 - deadzone);
}

export function readVaultGamepad(gamepads = []) {
  const pad = Array.from(gamepads ?? []).find((entry) => entry?.connected && (entry.mapping === "standard" || entry.axes?.length >= 4));
  if (!pad) return Object.freeze({ connected: false, id: "", moveX: 0, moveY: 0, aimX: 0, aimY: 0, fire: false, block: false, boost: false, escape: false, pulse: false, settings: false });
  const button = (index) => Boolean(pad.buttons?.[index]?.pressed || (pad.buttons?.[index]?.value ?? 0) > .45);
  return Object.freeze({
    connected: true,
    id: String(pad.id ?? "Gamepad"),
    moveX: vaultStick(pad.axes?.[0]),
    moveY: vaultStick(pad.axes?.[1]),
    aimX: vaultStick(pad.axes?.[2]),
    aimY: vaultStick(pad.axes?.[3]),
    escape: button(0),
    pulse: button(2),
    block: button(6),
    fire: button(7),
    boost: button(10),
    settings: button(9),
  });
}

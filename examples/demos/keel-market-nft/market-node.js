const state = document.querySelector("#state");
const log = document.querySelector("#log");
const price = document.querySelector("#price");
const bidder = document.querySelector("#bidder");
let session;

function request(intentId) {
  if (!session) {
    parent.postMessage({ protocol: "keel-plugin-handshake@1", plugin: "keel-market" }, "*");
    log.textContent = "Open the verified host market panel first.";
    return;
  }
  parent.postMessage({
    protocol: "keel-wallet-intent@1",
    session,
    plugin: "keel-market",
    intentId,
    proposal: { priceEth: price.value, bidder: bidder.value },
  }, "*");
}

for (const button of document.querySelectorAll("button[data-intent]")) {
  button.addEventListener("click", () => request(button.dataset.intent));
}

addEventListener("message", event => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.protocol === "keel-wallet-session@1" && message.plugin === "keel-market") {
    session = message.session;
    state.classList.add("ready");
    state.textContent = `Verified ${message.status} plugin · graph v${message.graphVersion} · ${message.account || "wallet not connected"}`;
    for (const button of document.querySelectorAll("button[data-intent]")) button.disabled = false;
  }
  if (message.protocol === "keel-wallet-result@1" && message.plugin === "keel-market") {
    log.textContent = message.ok ? `${message.intentId}: ${message.transactionHash}` : `${message.intentId}: ${message.error}`;
  }
});

const hotkeys = { l: "market.list", b: "market.buy", o: "market.bid", a: "market.accept-bid", x: "market.cancel" };
addEventListener("keydown", event => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key.toLowerCase() === "m") {
    parent.postMessage({ protocol: "keel-plugin-handshake@1", plugin: "keel-market" }, "*");
    return;
  }
  const intent = hotkeys[event.key.toLowerCase()];
  if (intent) request(intent);
});

parent.postMessage({ protocol: "keel-plugin-handshake@1", plugin: "keel-market" }, "*");

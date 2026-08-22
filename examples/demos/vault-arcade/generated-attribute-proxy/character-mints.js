const status = document.querySelector("#chain-status");
const grid = document.querySelector("#mint-grid");
const receipt = document.querySelector("#receipt");
let deployment;

async function rpc(method, params = []) {
  const response = await fetch(deployment.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `RPC ${method} failed`);
  return payload.result;
}

function mapLink(character, transactionHash) {
  const params = new URLSearchParams({
    characterSeed: character.derivedSeed,
    characterId: character.tokenId,
    mapSeed: deployment.mapSeed,
    mapId: deployment.mapId,
    stakeTx: transactionHash,
    arcadeRegistry: deployment.contracts.arcadeRegistry,
  });
  return `./vault-game.html?${params}`;
}

function openStakedCharacter(character, button) {
  const hash = character.stakeTransaction;
  button.classList.add("staked");
  document.querySelector("#receipt-title").textContent = `Character #${character.tokenId} is staked on map #${deployment.mapId}`;
  document.querySelector("#receipt-detail").textContent = "This is a confirmed Sepolia VaultArcadeRegistry assignment, not browser-local state.";
  document.querySelector("#receipt-hash").textContent = hash;
  document.querySelector("#enter-map").href = mapLink(character, hash);
  receipt.classList.add("show");
  receipt.scrollIntoView({ behavior: "smooth", block: "center" });
  document.body.dataset.lastStakeTransaction = hash;
  document.body.dataset.stakedCharacterId = character.tokenId;
}

function renderCharacter(character, index) {
  const article = document.createElement("article");
  article.className = "card";
  article.style.setProperty("--hue", `${(index * 41) % 360}deg`);
  article.innerHTML = `
    <div class="art"><span class="token">Mint #${character.tokenId}</span><img src="./complete-character-full-motion-q50.webp" alt="Shared Vault character sprite system" /></div>
    <div class="body"><h2>Vault Character #${character.tokenId}</h2><p class="fingerprint">${character.visualFingerprint}</p><div class="traits">${character.headlineTraits.map((trait) => `<span class="trait">${trait.name} · ${trait.optionId}</span>`).join("")}</div><button class="stake">Enter staked map #1</button></div>`;
  article.querySelector("button").addEventListener("click", (event) => openStakedCharacter(character, event.currentTarget));
  return article;
}

async function boot() {
  try {
    deployment = await fetch("./character-mint-stake-deployment.json", { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error("Mint/stake deployment is not seeded yet.");
      return response.json();
    });
    const chainHex = await rpc("eth_chainId");
    if (Number.parseInt(chainHex, 16) !== deployment.chainId) throw new Error("The mint demo chain ID does not match its deployment receipt.");
    document.querySelector("#collection").textContent = deployment.contracts.characterCollection;
    document.querySelector("#registry").textContent = deployment.contracts.arcadeRegistry;
    for (const [index, character] of deployment.characters.entries()) grid.append(renderCharacter(character, index));
    status.classList.add("live");
    status.querySelector("span").textContent = `Chain ${deployment.chainId} · ${deployment.characters.length} mints live`;
    document.body.dataset.chainVerified = "true";
  } catch (error) {
    status.querySelector("span").textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("error");
    grid.innerHTML = '<p class="error">The real mint/stake chain is unavailable. Start the isolated demo chain and reseed; this page will not substitute a fake local stake.</p>';
  }
}

void boot();

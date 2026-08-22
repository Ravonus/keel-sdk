const input = document.querySelector("#auto");
chrome.storage.sync.get({ autoOpen: true }, ({ autoOpen }) => { input.checked = Boolean(autoOpen); });
input.addEventListener("change", () => chrome.storage.sync.set({ autoOpen: input.checked }));

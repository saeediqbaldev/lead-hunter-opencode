const DEFAULT_BACKEND_URL = "__BACKEND_URL__";
const DEFAULT_API_KEY = "__API_KEY__";

const backendUrlInput = document.getElementById("backend-url");
const apiKeyInput = document.getElementById("api-key");
const statusEl = document.getElementById("status");

async function load() {
  const { backendUrl, apiKey } = await chrome.storage.sync.get(["backendUrl", "apiKey"]);
  backendUrlInput.value = backendUrl || DEFAULT_BACKEND_URL;
  apiKeyInput.value = apiKey || DEFAULT_API_KEY;
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const backendUrl = backendUrlInput.value.trim().replace(/\/$/, "");
  const apiKey = apiKeyInput.value.trim();

  await chrome.storage.sync.set({ backendUrl, apiKey });
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

load();

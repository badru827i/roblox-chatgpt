const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const status = document.getElementById("status");
const login = document.getElementById("login");
const wrap = document.getElementById("wrap");
const googleButton = document.getElementById("googleButton");
const userbox = document.getElementById("userbox");
const preview = document.getElementById("preview");
const previewImg = document.getElementById("previewImg");
const previewName = document.getElementById("previewName");
const removeImage = document.getElementById("removeImage");
let pendingImage = null;
let sessionId = null;

function add(role, text, imageDataUrl = null) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (imageDataUrl) {
    const img = document.createElement("img");
    img.className = "image";
    img.src = imageDataUrl;
    img.alt = "Gambar dihantar";
    el.appendChild(img);
  }
  if (text) {
    const span = document.createElement("div");
    span.textContent = text;
    el.appendChild(span);
  }
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function setImage(dataUrl, name = "Gambar siap dihantar") {
  pendingImage = dataUrl;
  previewImg.src = dataUrl;
  previewName.textContent = name;
  preview.style.display = "flex";
}

function clearImage() {
  pendingImage = null;
  previewImg.removeAttribute("src");
  preview.style.display = "none";
}

function waitForGoogle() {
  if (globalThis.google && google.accounts && google.accounts.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (globalThis.google && google.accounts && google.accounts.id) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error("Google Sign-In belum tersedia."));
      }
    }, 100);
  });
}

async function setupGoogleLogin() {
  try {
    const configResponse = await fetch("/auth/config", { cache: "no-store" });
    const config = await configResponse.json();
    if (!config.clientId) {
      googleButton.innerHTML = "<span style='color:#ffb4b4'>Tetapkan GOOGLE_CLIENT_ID di Railway.</span>";
      return;
    }

    await waitForGoogle();
    google.accounts.id.initialize({
      client_id: config.clientId,
      callback: handleGoogleCredential,
      auto_select: false,
      ux_mode: "popup",
      use_fedcm_for_button: true
    });

    googleButton.innerHTML = "";
    google.accounts.id.renderButton(googleButton, {
      theme: "filled_black",
      size: "large",
      shape: "rectangular",
      text: "signin_with"
    });
  } catch (error) {
    googleButton.textContent = error.message;
  }
}

async function handleGoogleCredential(response) {
  try {
    const r = await fetch("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Google login gagal");
    sessionId = data.sessionId || null;
    showLoggedIn(data.user, data.database);
  } catch (error) {
    googleButton.innerHTML = `<span style="color:#ffb4b4">${error.message}</span>`;
  }
}

function showLoggedIn(user, database = false) {
  login.style.display = "none";
  wrap.style.display = "flex";
  status.textContent = database ? `Online • ${user.email} • Data disimpan` : `Online • ${user.email}`;
  userbox.innerHTML = "";

  if (user.picture) {
    const img = document.createElement("img");
    img.src = user.picture;
    img.alt = user.name;
    userbox.appendChild(img);
  }

  const name = document.createElement("span");
  name.textContent = user.name;
  userbox.appendChild(name);

  const logout = document.createElement("button");
  logout.textContent = "Logout / Akaun lain";
  logout.onclick = async () => {
    try {
      await fetch("/auth/logout", { method: "POST" });
      if (globalThis.google?.accounts?.id) google.accounts.id.disableAutoSelect();
    } finally {
      location.reload();
    }
  };
  userbox.appendChild(logout);
}

async function checkSession() {
  try {
    const r = await fetch("/me", { cache: "no-store" });
    if (!r.ok) throw new Error("Not logged in");
    const data = await r.json();
    sessionId = data.sessionId || null;
    showLoggedIn(data.user, data.database);
  } catch (_) {
    login.style.display = "block";
    wrap.style.display = "none";
    setupGoogleLogin();
  }
}

input.addEventListener("paste", async (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find(item => item.type && item.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  if (file.size > 7 * 1024 * 1024) {
    add("assistant", "Gambar terlalu besar. Sila gunakan gambar di bawah 7 MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result, "Gambar dari clipboard");
  reader.readAsDataURL(file);
});

removeImage.addEventListener("click", clearImage);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message && !pendingImage) return;

  const sentImage = pendingImage;
  input.value = "";
  clearImage();
  add("user", message, sentImage);
  status.textContent = "AI sedang berfikir...";

  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId, imageDataUrl: sentImage })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Request gagal");
    const clean = (data.reply || "").replace(/<ROBLOX_COMMANDS>[\s\S]*?<\/ROBLOX_COMMANDS>/g, "").trim();
    add("assistant", clean || `Arahan dihantar ke Roblox Studio (${data.queued || 0}).`);
    status.textContent = data.queued ? `${data.queued} arahan menunggu Roblox Studio` : `Online • ${data.provider || "AI"}`;
  } catch (err) {
    add("assistant", `Error: ${err.message}`);
    status.textContent = "Error";
  }
});

checkSession();

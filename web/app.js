const sessionId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString();
const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const status = document.getElementById("status");

function add(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

status.textContent = "Online";

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  add("user", message);
  status.textContent = "AI sedang berfikir...";

  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Request gagal");

    const clean = data.reply.replace(/<ROBLOX_COMMANDS>[\s\S]*?<\/ROBLOX_COMMANDS>/g, "").trim();
    add("assistant", clean || `Arahan dihantar ke Roblox Studio (${data.queued || 0}).`);
    status.textContent = data.queued ? `${data.queued} arahan menunggu Roblox Studio` : "Online";
  } catch (err) {
    add("assistant", `Error: ${err.message}`);
    status.textContent = "Error";
  }
});

document.getElementById("clear").onclick = () => {
  chat.innerHTML = "";
  add("assistant", "Chat dibersihkan.");
};

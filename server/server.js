const express = require("express");
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "web")));

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const sessions = new Map();
const commandQueue = [];
const rateLimit = new Map();

const SYSTEM = `You are Roblox Builder AI. Help users create and debug Roblox games with Luau.
When a requested change should happen inside Roblox Studio, emit a command block using exactly:
<ROBLOX_COMMANDS>{"commands":[...]}</ROBLOX_COMMANDS>
Supported actions:
create_instance: {action,className,parent,name,properties}
set_property: {action,path,property,value}
set_source: {action,path,source}
delete_instance: {action,path}
Paths use / separators, e.g. ServerScriptService/MyScript. Vector3 values use [x,y,z]. Color3 values use [r,g,b] from 0 to 1.
Do not include secrets. Explain what you changed outside the command block.`;

function rateLimitChat(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const bucket = rateLimit.get(ip) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
  bucket.count++;
  rateLimit.set(ip, bucket);
  if (bucket.count > 30) return res.status(429).json({ error: "Terlalu banyak request. Cuba lagi kemudian." });
  next();
}

function requireBridge(req, res, next) {
  if (!BRIDGE_TOKEN || req.get("x-bridge-token") !== BRIDGE_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function askGemini(history) {
  const contents = history.slice(-20).map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));
  const result = await gemini.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction: SYSTEM }
  });
  return result.text || "Tiada jawapan.";
}

async function askOpenAI(history) {
  const response = await openai.responses.create({ model: process.env.OPENAI_MODEL || "gpt-5-mini", instructions: SYSTEM, input: history.slice(-20) });
  return response.output_text || "Tiada jawapan.";
}

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "web", "index.html")));
app.get("/health", (_req, res) => res.json({ status: "ok", provider: gemini ? "gemini" : openai ? "openai" : "none", queuedCommands: commandQueue.length }));

app.post("/chat", rateLimitChat, async (req, res) => {
  try {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    const sessionId = typeof req.body.sessionId === "string" && req.body.sessionId ? req.body.sessionId : crypto.randomUUID();
    if (!message) return res.status(400).json({ error: "Message diperlukan" });
    if (message.length > 12000) return res.status(413).json({ error: "Message terlalu panjang" });
    if (!gemini && !openai) return res.status(503).json({ error: "GEMINI_API_KEY belum dikonfigurasi" });

    const history = sessions.get(sessionId) || [];
    history.push({ role: "user", content: message });

    let reply;
    if (gemini) reply = await askGemini(history);
    else reply = await askOpenAI(history);

    history.push({ role: "assistant", content: reply });
    sessions.set(sessionId, history.slice(-20));

    const match = reply.match(/<ROBLOX_COMMANDS>([\s\S]*?)<\/ROBLOX_COMMANDS>/);
    let queued = 0;
    if (match) {
      const parsed = JSON.parse(match[1]);
      for (const command of parsed.commands || []) {
        commandQueue.push({ id: command.id || crypto.randomUUID(), command, createdAt: Date.now() });
        queued++;
      }
    }
    res.json({ sessionId, reply, queued, provider: gemini ? "gemini" : "openai" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Server error" });
  }
});

app.get("/bridge/poll", requireBridge, (_req, res) => res.json({ commands: commandQueue.splice(0, 25) }));
app.post("/bridge/result", requireBridge, (req, res) => { console.log("Studio result:", req.body); res.json({ ok: true }); });

app.listen(PORT, "0.0.0.0", () => console.log(`Roblox ChatGPT server listening on ${PORT}`));

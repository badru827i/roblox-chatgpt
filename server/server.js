const express = require("express");
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const path = require("path");
const {
  initDb,
  upsertUser,
  createSession,
  getUserBySession,
  deleteSession,
  cleanupExpiredSessions,
  isEnabled: isDbEnabled
} = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "..", "web")));

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
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
If the user sends an image, inspect it and use it as context for the Roblox task.
Do not include secrets. Explain what you changed outside the command block.`;

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const item of header.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setSessionCookie(res, sessionId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `rbx_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "rbx_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

async function requireLogin(req, res, next) {
  try {
    const sessionId = getCookie(req, "rbx_session");
    if (!sessionId) return res.status(401).json({ error: "Sila login dengan Google dahulu." });

    if (isDbEnabled()) {
      const user = await getUserBySession(sessionId);
      if (!user) return res.status(401).json({ error: "Session tamat. Sila login semula." });
      req.userSession = { user, history: sessions.get(sessionId)?.history || [] };
    } else {
      const session = sessions.get(sessionId);
      if (!session) return res.status(401).json({ error: "Sila login dengan Google dahulu." });
      req.userSession = session;
    }

    req.sessionId = sessionId;
    next();
  } catch (error) {
    console.error("Auth lookup error:", error);
    res.status(500).json({ error: "Database authentication error." });
  }
}

function requireBridge(req, res, next) {
  if (!BRIDGE_TOKEN || req.get("x-bridge-token") !== BRIDGE_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function rateLimitChat(req, res, next) {
  const key = req.userSession?.user?.id || req.ip || "unknown";
  const now = Date.now();
  const bucket = rateLimit.get(key) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
  bucket.count++;
  rateLimit.set(key, bucket);
  if (bucket.count > 30) return res.status(429).json({ error: "Terlalu banyak request. Cuba lagi kemudian." });
  next();
}

async function askGemini(history, image) {
  const contents = history.slice(-20).map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));
  if (image) {
    const comma = image.indexOf(",");
    if (comma > 0) {
      const header = image.slice(0, comma);
      const data = image.slice(comma + 1);
      const mimeMatch = header.match(/^data:([^;]+);base64$/);
      if (mimeMatch && data.length < 10_000_000 && contents.length) {
        contents[contents.length - 1].parts.push({ inlineData: { mimeType: mimeMatch[1], data } });
      }
    }
  }
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
app.get("/auth/config", (_req, res) => res.json({ clientId: GOOGLE_CLIENT_ID || null, database: isDbEnabled() }));

app.get("/me", async (req, res) => {
  try {
    const sessionId = getCookie(req, "rbx_session");
    if (!sessionId) return res.status(401).json({ authenticated: false });

    let user = null;
    if (isDbEnabled()) user = await getUserBySession(sessionId);
    else user = sessions.get(sessionId)?.user || null;

    if (!user) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, user, database: isDbEnabled() });
  } catch (error) {
    console.error("/me error:", error);
    res.status(500).json({ authenticated: false, error: "Database error." });
  }
});

app.post("/auth/google", async (req, res) => {
  try {
    if (!googleClient) return res.status(503).json({ error: "GOOGLE_CLIENT_ID belum dikonfigurasi di Railway." });
    const credential = typeof req.body.credential === "string" ? req.body.credential : "";
    if (!credential) return res.status(400).json({ error: "Google credential diperlukan." });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) return res.status(401).json({ error: "Google account tidak sah." });

    const baseUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture || null
    };

    const user = await upsertUser(baseUser);
    const sessionId = crypto.randomUUID();

    if (isDbEnabled()) {
      await createSession(sessionId, user.id);
    }

    // History chat kekal ringkas dan hanya di memory; data profil/session disimpan dalam Postgres.
    sessions.set(sessionId, { user, history: [], createdAt: Date.now() });
    setSessionCookie(res, sessionId);
    res.json({ ok: true, user, database: isDbEnabled() });
  } catch (error) {
    console.error("Google login error:", error);
    res.status(401).json({ error: "Google login gagal." });
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    const sessionId = getCookie(req, "rbx_session");
    if (sessionId) {
      await deleteSession(sessionId);
      sessions.delete(sessionId);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    console.error("Logout error:", error);
    clearSessionCookie(res);
    res.json({ ok: true });
  }
});

app.get("/health", (_req, res) => res.json({
  status: "ok",
  provider: gemini ? "gemini" : openai ? "openai" : "none",
  googleLogin: !!googleClient,
  database: isDbEnabled(),
  queuedCommands: commandQueue.length
}));

app.post("/chat", requireLogin, rateLimitChat, async (req, res) => {
  try {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    const imageDataUrl = typeof req.body.imageDataUrl === "string" ? req.body.imageDataUrl : null;
    if (!message && !imageDataUrl) return res.status(400).json({ error: "Mesej atau gambar diperlukan." });
    if (message.length > 12000) return res.status(413).json({ error: "Message terlalu panjang." });
    if (imageDataUrl && imageDataUrl.length > 10_000_000) return res.status(413).json({ error: "Gambar terlalu besar." });
    if (!gemini && !openai) return res.status(503).json({ error: "Tiada AI provider dikonfigurasi." });

    const session = sessions.get(req.sessionId) || { history: [] };
    const history = session.history;
    history.push({ role: "user", content: message || "[Gambar dihantar]" });

    let reply;
    if (gemini) reply = await askGemini(history, imageDataUrl);
    else reply = await askOpenAI(history);

    history.push({ role: "assistant", content: reply });
    sessions.set(req.sessionId, {
      ...session,
      user: req.userSession.user,
      history: history.slice(-20),
      createdAt: session.createdAt || Date.now()
    });

    const match = reply.match(/<ROBLOX_COMMANDS>([\s\S]*?)<\/ROBLOX_COMMANDS>/);
    let queued = 0;
    if (match) {
      const parsed = JSON.parse(match[1]);
      for (const command of parsed.commands || []) {
        commandQueue.push({ id: command.id || crypto.randomUUID(), command, userId: req.userSession.user.id, createdAt: Date.now() });
        queued++;
      }
    }
    res.json({ sessionId: req.sessionId, reply, queued, provider: gemini ? "gemini" : "openai" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Server error" });
  }
});

app.get("/bridge/poll", requireBridge, (_req, res) => res.json({ commands: commandQueue.splice(0, 25) }));
app.post("/bridge/result", requireBridge, (req, res) => { console.log("Studio result:", req.body); res.json({ ok: true }); });

async function start() {
  try {
    await initDb();
    console.log(`PostgreSQL: ${isDbEnabled() ? "enabled" : "disabled"}`);
    if (isDbEnabled()) {
      setInterval(() => cleanupExpiredSessions().catch(err => console.error("Session cleanup error:", err)), 60 * 60 * 1000);
    }
    app.listen(PORT, "0.0.0.0", () => console.log(`Roblox ChatGPT server listening on ${PORT}`));
  } catch (error) {
    console.error("Database initialization failed:", error);
    process.exit(1);
  }
}

start();

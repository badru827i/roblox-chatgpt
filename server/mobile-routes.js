const express = require("express");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { GoogleGenAI } = require("@google/genai");
const { URL } = require("url");

const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite").split(",").map(s => s.trim()).filter(Boolean);
const GEMINI_RETRIES = 2;
const MAX_MESSAGE = 12000;
const MAX_HISTORY = 30;
const rateLimit = new Map();

const pool = DATABASE_URL
  ? new (require("pg").Pool)({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

let dbPromise = null;

async function ensureDb() {
  if (!pool) throw new Error("DATABASE_URL belum dikonfigurasi di Railway.");
  if (!dbPromise) {
    dbPromise = pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS mobile_chats (
        id UUID PRIMARY KEY,
        device_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Chat baru',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS mobile_chats_device_updated_idx
        ON mobile_chats(device_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS mobile_chat_messages (
        id BIGSERIAL PRIMARY KEY,
        chat_id UUID NOT NULL REFERENCES mobile_chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS mobile_chat_messages_chat_idx
        ON mobile_chat_messages(chat_id, created_at);
    `);
  }
  await dbPromise;
}

function deviceId(req) {
  const id = String(req.get("x-device-id") || "").trim();
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id)) return null;
  return id;
}

function safeTitle(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "Chat baru";
  return value.length > 48 ? value.slice(0, 48).trimEnd() + "…" : value;
}

function needsWeb(message) {
  const q = String(message || "").toLowerCase();
  return [
    "cari", "carikan", "search", "google", "web", "internet", "terkini",
    "terbaru", "latest", "today", "hari ini", "sekarang", "harga", "price",
    "berita", "news", "update", "spesifikasi", "spec", "sumber", "siapa",
    "berapa", "2026", "malaysia"
  ].some(term => q.includes(term));
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return htmlDecode(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function fetchText(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error("Too many redirects"));
    let parsed;
    try { parsed = new URL(target); } catch { return reject(new Error("URL web tidak sah")); }
    if (!["http:", "https:"].includes(parsed.protocol)) return reject(new Error("Protocol tidak disokong"));

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(parsed, {
      headers: {
        "User-Agent": "AI-Fusion/1.0 (Android; +https://railway.app)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7"
      },
      timeout: 8000
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, target).toString();
        return fetchText(next, redirects + 1).then(resolve).catch(reject);
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(new Error("HTTP " + status));
      }

      let data = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        data += chunk;
        if (data.length > 500000) req.destroy();
      });
      response.on("end", () => resolve(data.slice(0, 500000)));
    });
    req.on("timeout", () => req.destroy(new Error("Web timeout")));
    req.on("error", reject);
  });
}

async function webResearch(query) {
  const encoded = encodeURIComponent(String(query || ""));
  const searchHtml = await fetchText("https://html.duckduckgo.com/html/?q=" + encoded);
  const linkRe = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
  const results = [];
  let match;
  while ((match = linkRe.exec(searchHtml)) && results.length < 4) {
    let url = htmlDecode(match[1]);
    const title = stripTags(match[2]);
    if (url.includes("uddg=")) {
      try {
        const u = new URL(url, "https://duckduckgo.com");
        url = decodeURIComponent(u.searchParams.get("uddg") || url);
      } catch (_) {}
    }
    if (!url.startsWith("http")) continue;
    results.push({ title, url, snippet: "" });
  }
  const snippets = [];
  while ((match = snippetRe.exec(searchHtml)) && snippets.length < 4) snippets.push(stripTags(match[1]));
  results.forEach((r, i) => { r.snippet = snippets[i] || ""; });

  const pages = await Promise.all(results.slice(0, 3).map(async r => {
    try {
      const html = await fetchText(r.url);
      return { ...r, page: stripTags(html).slice(0, 6500) };
    } catch (_) {
      return { ...r, page: "" };
    }
  }));

  return pages.filter(r => r.title || r.page);
}

async function askGemini(history, webContext) {
  if (!gemini) throw new Error("GEMINI_API_KEY belum dikonfigurasi di Railway.");

  const contents = history.slice(-MAX_HISTORY).map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content || "" }]
  }));

  const system = `You are AI Fusion Assistant, a capable personal chat assistant.
Understand Malay (Bahasa Melayu), English, mixed Malay-English, slang, and normal conversational language.
Answer the user's actual request directly. Keep context from the conversation. For complex questions, reason carefully and explain assumptions when needed.
When web research is supplied, treat it as source material, synthesize it, and prefer the freshest relevant facts. Mention source names/URLs briefly when useful.
Do not pretend you accessed private accounts or private user data. Do not invent facts or sources.
If the user asks for current information and web research is absent, say that current verification is unavailable instead of pretending.
${webContext ? "\nWEB RESEARCH (public pages):\\n" + webContext : ""}`;

  let lastError = null;
  for (const model of MODELS) {
    for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt++) {
      try {
        const result = await gemini.models.generateContent({
          model,
          contents,
          config: { systemInstruction: system }
        });
        return result.text || "Tiada jawapan.";
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || "");
        const transient = /\b(429|500|502|503|504)\b|UNAVAILABLE|high demand|overloaded|temporar/i.test(message);
        if (!transient || attempt >= GEMINI_RETRIES) break;
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  const error = new Error("AI sementara sibuk. Semua model Gemini sedang tidak tersedia. Cuba lagi sebentar.");
  error.code = "AI_UNAVAILABLE";
  error.retryable = true;
  error.cause = lastError;
  throw error;
}

function rateLimitMobile(req, res, next) {
  const key = deviceId(req) || req.ip || "unknown";
  const now = Date.now();
  const bucket = rateLimit.get(key) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60000;
  }
  bucket.count++;
  rateLimit.set(key, bucket);
  if (bucket.count > 40) {
    return res.status(429).json({ error: "Terlalu banyak request. Cuba lagi kemudian." });
  }
  next();
}

module.exports = function registerMobileRoutes(app) {
  app.get("/mobile/chats", rateLimitMobile, async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });
      await ensureDb();
      const result = await pool.query(
        `SELECT id, title, created_at, updated_at
         FROM mobile_chats WHERE device_id = $1
         ORDER BY updated_at DESC LIMIT 100`,
        [owner]
      );
      res.json({ chats: result.rows });
    } catch (error) {
      console.error("mobile list chats:", error);
      res.status(503).json({ error: error.message || "Chat database belum tersedia." });
    }
  });

  app.post("/mobile/chats", rateLimitMobile, async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });
      await ensureDb();
      const id = crypto.randomUUID();
      const title = safeTitle(req.body?.title);
      const result = await pool.query(
        `INSERT INTO mobile_chats (id, device_id, title)
         VALUES ($1, $2, $3)
         RETURNING id, title, created_at, updated_at`,
        [id, owner, title]
      );
      res.json({ chat: result.rows[0] });
    } catch (error) {
      console.error("mobile create chat:", error);
      res.status(503).json({ error: error.message || "Chat database belum tersedia." });
    }
  });

  app.get("/mobile/chats/:id", rateLimitMobile, async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });
      await ensureDb();
      const chat = await pool.query(
        "SELECT id, title, created_at, updated_at FROM mobile_chats WHERE id = $1 AND device_id = $2 LIMIT 1",
        [req.params.id, owner]
      );
      if (!chat.rows[0]) return res.status(404).json({ error: "Chat tidak dijumpai." });
      const messages = await pool.query(
        `SELECT role, content, created_at FROM mobile_chat_messages
         WHERE chat_id = $1 ORDER BY created_at ASC, id ASC`,
        [req.params.id]
      );
      res.json({ chat: chat.rows[0], messages: messages.rows });
    } catch (error) {
      console.error("mobile get chat:", error);
      res.status(503).json({ error: error.message || "Chat database belum tersedia." });
    }
  });

  app.delete("/mobile/chats/:id", rateLimitMobile, async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });
      await ensureDb();
      const result = await pool.query(
        "DELETE FROM mobile_chats WHERE id = $1 AND device_id = $2 RETURNING id",
        [req.params.id, owner]
      );
      if (!result.rows[0]) return res.status(404).json({ error: "Chat tidak dijumpai." });
      res.json({ ok: true });
    } catch (error) {
      console.error("mobile delete chat:", error);
      res.status(503).json({ error: error.message || "Chat database belum tersedia." });
    }
  });

  app.post("/mobile/chat", rateLimitMobile, async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });

      const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
      if (!message) return res.status(400).json({ error: "Mesej diperlukan." });
      if (message.length > MAX_MESSAGE) return res.status(413).json({ error: "Mesej terlalu panjang." });

      await ensureDb();

      let chatId = String(req.body?.chatId || "").trim();
      if (!/^[0-9a-fA-F-]{36}$/.test(chatId)) chatId = crypto.randomUUID();

      const exists = await pool.query(
        "SELECT id, title FROM mobile_chats WHERE id = $1 AND device_id = $2 LIMIT 1",
        [chatId, owner]
      );
      if (!exists.rows[0]) {
        await pool.query(
          `INSERT INTO mobile_chats (id, device_id, title)
           VALUES ($1, $2, $3)`,
          [chatId, owner, safeTitle(message)]
        );
      } else if (!exists.rows[0].title || exists.rows[0].title === "Chat baru") {
        await pool.query(
          "UPDATE mobile_chats SET title = $1, updated_at = NOW() WHERE id = $2 AND device_id = $3",
          [safeTitle(message), chatId, owner]
        );
      }

      const before = await pool.query(
        `SELECT role, content FROM mobile_chat_messages
         WHERE chat_id = $1 ORDER BY created_at ASC, id ASC`,
        [chatId]
      );

      await pool.query(
        "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'user', $2)",
        [chatId, message]
      );
      await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);

      const history = before.rows.concat([{ role: "user", content: message }]).slice(-MAX_HISTORY);
      let webSources = [];
      let webContext = "";

      if (needsWeb(message)) {
        try {
          webSources = await webResearch(message);
          webContext = webSources.map((s, i) =>
            "[SOURCE " + (i + 1) + "] " + s.title + "\nURL: " + s.url + "\nSNIPPET: " + s.snippet + "\nCONTENT: " + s.page
          ).join("\n\n");
        } catch (error) {
          console.warn("web research failed:", error.message);
        }
      }

      const reply = await askGemini(history, webContext);

      await pool.query(
        "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'assistant', $2)",
        [chatId, reply]
      );
      await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);

      res.json({
        chatId,
        reply,
        webUsed: webSources.length > 0,
        sources: webSources.map(s => ({ title: s.title, url: s.url }))
      });
    } catch (error) {
      console.error("mobile chat:", error);
      const status = error?.code === "AI_UNAVAILABLE" ? 503 : 500;
      res.status(status).json({ error: error?.message || "AI server error.", code: error?.code || "AI_SERVER_ERROR", retryable: Boolean(error?.retryable) });
    }
  });
};

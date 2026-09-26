const express = require("express");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { GoogleGenAI } = require("@google/genai");
const { URL } = require("url");
const sharp = require("sharp");
const { optimizeFile, MAX_FILE_BYTES } = require("./file-tools");

const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite").split(",").map(s => s.trim()).filter(Boolean).slice(0, 5);
const MAX_RESEARCH_QUERIES = 5;
const MAX_RESEARCH_RESULTS = 10;
const MAX_PAGE_TEXT = 6000;
const MAX_TOTAL_WEB_CONTEXT = 28000;
const GEMINI_RETRIES = 1;
const MAX_MESSAGE = 12000;
const MAX_HISTORY = 16;
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

function detectSkill(message) {
  const q = String(message || "").toLowerCase().trim();
  if (!q) return "chat_core";
  if (/\b(3d|model 3d|obj|stl|gltf|glb|blender|mesh|low poly|3d design|reka bentuk 3d|modelkan)\b/.test(q)) return "3d_design";
  if (/\b(gambar|image|foto|picture|vision|screenshot|tengok gambar|lihat gambar|analisis gambar)\b/.test(q)) return "vision";
  if (/\b(generate image|buatkan gambar|hasilkan gambar|jana gambar|lukis|poster|logo|ilustrasi)\b/.test(q)) return "image_generation";
  if (/\b(convert|compress|compressor|kecilkan|ringankan|optimize|optimise|saiz file|saiz fail|kurangkan saiz|tanpa hilang quality|tanpa hilang kualiti|lossless|webp|avif|png)\b/.test(q)) return "file";
  if (/\b(kod|code|coding|program|javascript|typescript|java|kotlin|python|html|css|sql|api|debug|bug|repository|repo)\b/.test(q)) return "code";
  if (/\b(file|fail|dokumen|document|pdf|txt|json|csv|xlsx|docx|baca fail|analisis fail)\b/.test(q)) return "file";
  if (needsWeb(q)) return "multi_research";
  return "chat_core";
}

function skillInstruction(skill) {
  const instructions = {
    chat_core: "Route: Chat Core. Answer directly and stay on topic.",
    multi_research: "Route: Multi-Research. For fresh or evidence-sensitive questions, research multiple independent sources when possible, compare evidence, then synthesize. Do not invent sources.",
    vision: "Route: Vision. If an image is supplied, inspect only visible evidence and explain uncertainty.",
    image_generation: "Route: Image Generation. Treat image creation as a separate generation task; do not pretend an image was generated if the image tool fails.",
    "3d_design": "Route: 3D Design Skill. Design 3D objects/scenes procedurally with dimensions, topology/parts, materials and export format. Prefer lightweight procedural instructions/code over loading a large 3D model into Railway.",
    code: "Route: Code Skill. Produce practical, runnable code, explain important assumptions, and keep changes focused.",
    file: "Route: File Skill. Analyze, convert or optimize files. For size reduction without quality/data loss, use lossless methods and clearly report if a smaller file is not guaranteed."
  };
  return instructions[skill] || instructions.chat_core;
}

function needsWeb(message) {
  const q = String(message || "").toLowerCase().trim();
  if (!q) return false;
  // A direct URL means the user wants the AI to inspect that website/page.
  if (/https?:\/\/[^\s]+/i.test(message)) return true;
  const explicit = [
    "cari", "carikan", "search", "google", "web", "internet", "online",
    "terkini", "terbaru", "latest", "today", "hari ini", "sekarang",
    "harga semasa", "harga terkini", "price today", "berita", "news",
    "update terbaru", "sumber", "link", "rujukan", "release terbaru",
    "versi terbaru", "spesifikasi terbaru", "jadual hari ini",
    "cuaca", "weather", "lokasi", "alamat", "2026"
  ];
  if (explicit.some(term => q.includes(term))) return true;
  return /\b(vs|versus|bandingkan|perbandingan|compare)\b/.test(q) &&
         /\b(harga|spec|spesifikasi|telefon|phone|laptop|produk|model)\b/.test(q);
}

function buildSearchQueries(message) {
  const original = String(message || "").replace(/\s+/g, " ").trim();
  const q = original.toLowerCase();
  const queries = [original];
  if (/\b(harga|price|berapa)\b/.test(q)) queries.push(original + " Malaysia current price");
  if (/\b(spec|spesifikasi|model|telefon|phone|laptop|gpu|cpu)\b/.test(q)) queries.push(original + " official specifications");
  if (/\b(latest|terkini|terbaru|sekarang|hari ini|2026)\b/.test(q)) queries.push(original + " latest 2026");
  if (/\b(cara|macam mana|how|tutorial|fix|baiki)\b/.test(q)) queries.push(original + " official documentation guide");
  return [...new Set(queries)].slice(0, 4);
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


async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); } catch (_) { results[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function compactResearchContext(sources) {
  let used = 0;
  const chunks = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const block = "[SOURCE " + (i + 1) + "] " + String(s.title || "Untitled").slice(0, 180) +
      "\nURL: " + String(s.url || "") +
      "\nSNIPPET: " + String(s.snippet || "").slice(0, 700) +
      "\nCONTENT: " + String(s.page || "").slice(0, MAX_PAGE_TEXT);
    if (used + block.length > MAX_TOTAL_WEB_CONTEXT) break;
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("\n\n");
}

async function webResearch(query) {
  const directUrls = [...String(query || "").matchAll(/https?:\/\/[^\s<>"')]+/gi)]
    .map(m => m[0].replace(/[.,!?;:]+$/, ""))
    .filter((url, i, a) => a.indexOf(url) === i).slice(0, 2);

  const directPages = await mapWithConcurrency(directUrls, 2, async url => {
    try {
      const html = await fetchText(url);
      return { title: new URL(url).hostname, url, snippet: "Direct page requested by the user.", page: stripTags(html).slice(0, MAX_PAGE_TEXT) };
    } catch (_) { return null; }
  });

  const queries = buildSearchQueries(query);
  const batches = await mapWithConcurrency(queries, 3, async currentQuery => {
    try { return await fetchText("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(currentQuery)); }
    catch (_) { return ""; }
  });

  const candidates = [];
  const seen = new Set();
  for (const html of batches) {
    const linkRe = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
    const snippets = [];
    let m;
    while ((m = snippetRe.exec(html)) && snippets.length < 8) snippets.push(stripTags(m[1]));
    let si = 0;
    while ((m = linkRe.exec(html)) && candidates.length < MAX_RESEARCH_RESULTS * 2) {
      let url = htmlDecode(m[1]);
      if (url.includes("uddg=")) {
        try { const u = new URL(url, "https://duckduckgo.com"); url = decodeURIComponent(u.searchParams.get("uddg") || url); } catch (_) {}
      }
      if (!url.startsWith("http")) continue;
      try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        if (seen.has(url) || seen.has(host)) continue;
        seen.add(url); seen.add(host);
      } catch (_) { continue; }
      candidates.push({ title: stripTags(m[2]), url, snippet: snippets[si++] || "" });
    }
  }

  const pages = await mapWithConcurrency(candidates.slice(0, MAX_RESEARCH_RESULTS), 3, async r => {
    try { return { ...r, page: stripTags(await fetchText(r.url)).slice(0, MAX_PAGE_TEXT) }; }
    catch (_) { return { ...r, page: "" }; }
  });

  const merged = [...directPages.filter(Boolean), ...pages.filter(Boolean)];
  const seenUrls = new Set();
  return merged.filter(r => {
    if (!r?.url || seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return Boolean(r.title || r.page || r.snippet);
  }).slice(0, MAX_RESEARCH_RESULTS);
}

async function askGemini(history, webContext, useGoogleSearch = false, skill = "chat_core") {
  if (!gemini) throw new Error("GEMINI_API_KEY belum dikonfigurasi di Railway.");

  const contents = history.slice(-MAX_HISTORY).map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content || "" }]
  }));

  const system = `You are AI Fusion Assistant, a fast and accurate personal chat assistant.
Understand Bahasa Melayu, English, mixed Malay-English and slang.
Answer the user's actual request directly and stay on topic.
${skillInstruction(skill)}\nFor factual/current questions, prefer verified evidence over guessing.
When Google Search grounding is enabled, use it for fresh facts and base claims on the retrieved sources.
Do not invent facts, citations, URLs, or private information.
Keep answers concise unless the user asks for detail.
${webContext ? "\\nWEB RESEARCH (fallback source material):\\n" + webContext : ""}`;

  let lastError = null;
  for (const model of MODELS) {
    for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt++) {
      try {
        const config = { systemInstruction: system };
        if (useGoogleSearch) config.tools = [{ googleSearch: {} }];

        const result = await gemini.models.generateContent({
          model,
          contents,
          config
        });

        const sources = extractGoogleSources(result);
        return { text: result.text || "Tiada jawapan.", sources };
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || "");
        const transient = /\\b(429|500|502|503|504)\\b|UNAVAILABLE|high demand|overloaded|temporar/i.test(message);
        if (!transient || attempt >= GEMINI_RETRIES) break;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  const error = new Error("AI sementara sibuk. Cuba lagi sebentar.");
  error.code = "AI_UNAVAILABLE";
  error.retryable = true;
  error.cause = lastError;
  throw error;
}

function extractGoogleSources(result) {
  const chunks = result?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks
    .map(chunk => chunk?.web)
    .filter(web => web?.uri)
    .map(web => ({ title: web.title || web.uri, url: web.uri }));
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

  const fileOptimizeHandler = async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });
      const base64 = typeof req.body?.fileBase64 === "string" ? req.body.fileBase64.trim() : "";
      const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType.trim() : "";
      const format = typeof req.body?.format === "string" ? req.body.format.trim() : "";
      if (!base64) return res.status(400).json({ error: "fileBase64 diperlukan." });

      const result = await optimizeFile({ base64, mimeType, format });
      res.json({
        ok: true,
        skill: "file",
        operation: "lossless_optimize",
        ...result,
        dataUrl: "data:" + result.mimeType + ";base64," + result.dataBase64
      });
    } catch (error) {
      console.error("mobile file optimize:", error);
      res.status(400).json({ error: error?.message || "File optimization gagal.", lossless: true });
    }
  };

  app.get("/mobile/file/optimize", (_req, res) => {
    res.json({ ok: true, method: "POST", endpoint: "/mobile/file/optimize", maxBytes: MAX_FILE_BYTES, lossless: true });
  });
  app.post("/mobile/file/optimize", rateLimitMobile, fileOptimizeHandler);
  app.post("/mobile/file/optimize/", rateLimitMobile, fileOptimizeHandler);
  app.post("/api/mobile/file/optimize", rateLimitMobile, fileOptimizeHandler);

  const imageChatHandler = async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });

      const message = typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "Fahami gambar ini dan terangkan apa yang pengguna mahu tahu.";
      const mimeType = typeof req.body?.mimeType === "string"
        ? req.body.mimeType.trim()
        : "image/jpeg";
      const imageBase64 = typeof req.body?.imageBase64 === "string"
        ? req.body.imageBase64.trim()
        : "";

      if (!imageBase64) return res.status(400).json({ error: "imageBase64 diperlukan." });
      if (!/^image\/(jpeg|jpg|png|webp|gif)$/i.test(mimeType)) {
        return res.status(415).json({ error: "Format gambar tidak disokong." });
      }
      if (imageBase64.length > 12 * 1024 * 1024) {
        return res.status(413).json({ error: "Gambar terlalu besar. Maksimum 8 MB." });
      }
      if (!gemini) return res.status(503).json({ error: "GEMINI_API_KEY belum dikonfigurasi di Railway." });

      const prompt = `You are AI Fusion Vision Assistant.
Understand Bahasa Melayu, English, mixed Malay-English and slang.
Look carefully at the supplied image and answer the user's instruction about it.
Identify visible objects, UI, code, diagrams, text and relevant details when possible.
If the user asks how to build or recreate something shown in the image (for example Roblox Studio), give practical step-by-step instructions.
Do not claim to see details that are not visible.
User instruction: ${message}`;

      let lastError = null;
      for (const model of MODELS) {
        try {
          const result = await gemini.models.generateContent({
            model,
            contents: [{
              role: "user",
              parts: [
                { inlineData: { mimeType, data: imageBase64 } },
                { text: prompt }
              ]
            }],
            config: {
              systemInstruction: "You are a multimodal assistant. Analyze images accurately and stay on the user's actual request."
            }
          });
          const reply = String(result?.text || "").trim();
          if (reply) return res.json({ ok: true, reply, model });
        } catch (error) {
          lastError = error;
          const msg = String(error?.message || error || "");
          const transient = /\\b(429|500|502|503|504)\\b|UNAVAILABLE|overloaded|temporar/i.test(msg);
          if (!transient) break;
        }
      }
      throw lastError || new Error("Model vision tidak menghasilkan jawapan.");
    } catch (error) {
      console.error("mobile image chat:", error);
      res.status(500).json({ error: error?.message || "Image understanding gagal." });
    }
  };

  const multiFileChatHandler = async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });
      if (!gemini) return res.status(503).json({ error: "GEMINI_API_KEY belum dikonfigurasi di Railway." });

      const message = typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "Analisis semua fail yang dilampirkan dan jawab soalan pengguna.";
      const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 6) : [];
      if (!files.length) return res.status(400).json({ error: "Sekurang-kurangnya satu fail diperlukan." });

      const MAX_ONE = 8 * 1024 * 1024;
      const MAX_TOTAL = 24 * 1024 * 1024;
      let totalBytes = 0;
      const parts = [{
        text:
          "You are AI Fusion Multi-File Assistant.\n" +
          "Understand Bahasa Melayu, English, mixed Malay-English and slang.\n" +
          "Analyze every supplied file that the model can read. Keep evidence separated by filename.\n" +
          "Do not invent content that is not present. If a format is unsupported, say so clearly.\n" +
          "User instruction: " + message
      }];

      for (let i = 0; i < files.length; i++) {
        const item = files[i] || {};
        const mimeType = String(item.mimeType || "application/octet-stream").toLowerCase().split(";")[0].trim();
        const name = String(item.name || ("file-" + (i + 1))).slice(0, 180);
        const data = typeof item.base64 === "string" ? item.base64.replace(/^data:[^,]+,/, "").trim() : "";
        if (!data) continue;
        const bytes = Math.floor(data.length * 0.75);
        if (bytes > MAX_ONE) return res.status(413).json({ error: name + " terlalu besar. Maksimum 8 MB setiap fail." });
        totalBytes += bytes;
        if (totalBytes > MAX_TOTAL) return res.status(413).json({ error: "Jumlah fail terlalu besar. Maksimum 24 MB setiap request." });

        parts.push({ text: "\n\n[FILE " + (i + 1) + ": " + name + "]\nMIME: " + mimeType });
        parts.push({ inlineData: { mimeType, data } });
      }

      if (parts.length <= 1) return res.status(400).json({ error: "Fail tidak mengandungi data yang boleh dibaca." });

      let lastError = null;
      for (const model of MODELS) {
        try {
          const result = await gemini.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: {
              systemInstruction:
                "You are a careful multimodal file analyst. Compare and synthesize evidence across all attached files. " +
                "For PDFs/documents, use both text and visual structure when available. Return a useful answer in the user's language."
            }
          });
          const reply = String(result?.text || "").trim();
          if (reply) return res.json({ ok: true, reply, model, fileCount: files.length });
        } catch (error) {
          lastError = error;
          const msg = String(error?.message || error || "");
          const transient = /\\b(429|500|502|503|504)\\b|UNAVAILABLE|overloaded|temporar/i.test(msg);
          if (!transient) break;
        }
      }
      throw lastError || new Error("Model multi-file tidak menghasilkan jawapan.");
    } catch (error) {
      console.error("mobile multi-file chat:", error);
      res.status(500).json({ error: error?.message || "Multi-file analysis gagal." });
    }
  };

  app.post("/mobile/chat/files", rateLimitMobile, multiFileChatHandler);
  app.post("/mobile/chat/files/", rateLimitMobile, multiFileChatHandler);
  app.post("/api/mobile/chat/files", rateLimitMobile, multiFileChatHandler);

  // Multimodal image understanding endpoint + aliases for older APKs/proxies.
  app.post("/mobile/chat/image", rateLimitMobile, imageChatHandler);
  app.post("/mobile/chat/image/", rateLimitMobile, imageChatHandler);
  app.post("/api/mobile/chat/image", rateLimitMobile, imageChatHandler);
  app.post("/chat/image", rateLimitMobile, imageChatHandler);

  const IMAGE_FORMATS = {
    png: { mime: "image/png", ext: "png" },
    jpg: { mime: "image/jpeg", ext: "jpg" },
    jpeg: { mime: "image/jpeg", ext: "jpg" },
    webp: { mime: "image/webp", ext: "webp" },
    avif: { mime: "image/avif", ext: "avif" }
  };

  function normalizeImageFormat(value) {
    const key = String(value || "").toLowerCase().replace(/^\./, "").trim();
    return IMAGE_FORMATS[key] ? (key === "jpeg" ? "jpg" : key) : null;
  }

  function requestedImageFormat(message) {
    const q = String(message || "").toLowerCase();
    if (/\b(jpe?g|\.jpe?g)\b/.test(q)) return "jpg";
    if (/\bwebp\b/.test(q)) return "webp";
    if (/\bavif\b/.test(q)) return "avif";
    if (/\bpng\b/.test(q)) return "png";
    return null;
  }

  function imageGenerationIntent(message) {
    const q = String(message || "").toLowerCase().trim();
    if (!q) return false;
    if (/\b(cara|macam mana|how|tutorial|buat|edit|ubah|tukar|convert|compress|resize)\b/.test(q) &&
        /\b(gambar|image|picture|poster|logo|ilustrasi|illustration)\b/.test(q) &&
        !/\b(buatkan|hasilkan|generate|create|lukis|lukiskan|hasilkanlah|jana)\b/.test(q)) {
      return false;
    }
    return /\b(buatkan|hasilkan|generate|create|lukis|lukiskan|jana|hasilkanlah)\b/.test(q) &&
      /\b(gambar|image|picture|poster|logo|ilustrasi|illustration|artwork)\b/.test(q);
  }

  async function generateImageData(prompt, requestedFormat) {
    if (!gemini) throw new Error("GEMINI_API_KEY belum dikonfigurasi di Railway.");
    const format = normalizeImageFormat(requestedFormat) || "png";
    const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
    const result = await gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ["IMAGE"],
        responseFormat: {
          image: {
            aspectRatio: "1:1",
            imageSize: "1K"
          }
        }
      }
    });

    const parts = result?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part?.inlineData?.data);
    if (!imagePart) {
      const text = parts.find(part => part?.text)?.text || "Model tidak menghasilkan gambar.";
      throw new Error(text);
    }

    const inputMime = imagePart.inlineData.mimeType || "image/png";
    const inputBuffer = Buffer.from(imagePart.inlineData.data, "base64");
    let outputBuffer = inputBuffer;
    let outputMime = inputMime;

    if (format !== "png" || !/^image\/png$/i.test(inputMime)) {
      const pipeline = sharp(inputBuffer);
      if (format === "jpg") outputBuffer = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      else if (format === "webp") outputBuffer = await pipeline.webp({ quality: 92 }).toBuffer();
      else if (format === "avif") outputBuffer = await pipeline.avif({ quality: 85 }).toBuffer();
      else outputBuffer = await pipeline.png().toBuffer();
      outputMime = IMAGE_FORMATS[format].mime;
    }

    return {
      model,
      format,
      mime: outputMime,
      imageDataUrl: "data:" + outputMime + ";base64," + outputBuffer.toString("base64")
    };
  }

  const generateImageHandler = async (req, res) => {
    try {
      const owner = deviceId(req);
      if (!owner) return res.status(400).json({ error: "X-Device-Id diperlukan." });

      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) return res.status(400).json({ error: "Prompt gambar diperlukan." });
      if (prompt.length > 4000) return res.status(413).json({ error: "Prompt terlalu panjang." });
      const format = normalizeImageFormat(req.body?.format) || "png";
      const image = await generateImageData(prompt, format);

      res.json({
        ok: true,
        model: image.model,
        format: image.format,
        imageUrl: image.imageDataUrl,
        imageDataUrl: image.imageDataUrl,
        prompt
      });
    } catch (error) {
      console.error("mobile generate image:", error);
      res.status(500).json({ error: error?.message || "Image generation gagal." });
    }
  };

  // Primary endpoint + compatibility aliases so older APKs/proxies do not hit 404.
  app.get("/mobile/generate-image", (_req, res) => {
    res.json({ ok: true, method: "POST", endpoint: "/mobile/generate-image" });
  });
  app.post("/mobile/generate-image", rateLimitMobile, generateImageHandler);
  app.post("/mobile/generate-image/", rateLimitMobile, generateImageHandler);
  app.post("/api/mobile/generate-image", rateLimitMobile, generateImageHandler);
  app.post("/generate-image", rateLimitMobile, generateImageHandler);
  app.post("/mobile/ai-gene", rateLimitMobile, generateImageHandler);

  app.post("/mobile/chat/stream", rateLimitMobile, async (req, res) => {
    let streamStarted = false;
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
          "INSERT INTO mobile_chats (id, device_id, title) VALUES ($1, $2, $3)",
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

      const history = before.rows.concat([{ role: "user", content: message }])
        .slice(-Math.min(MAX_HISTORY, 16));
      const useSearch = req.body?.research === true || req.body?.evidenceFirst === true || needsWeb(message);
      const skill = detectSkill(message);
      const imageIntent = imageGenerationIntent(message);
      const currentFormat = requestedImageFormat(message);
      const previousUserMessages = before.rows.filter(item => item.role === "user").map(item => item.content);
      const previousImageRequest = [...previousUserMessages].reverse().find(item => imageGenerationIntent(item));
      const formatSelection = currentFormat && previousImageRequest ? currentFormat : null;
      const shouldGenerateImage = Boolean(previousImageRequest && currentFormat);
      const needsImageFormatChoice = Boolean(imageIntent && !previousImageRequest);

      if (!gemini) throw new Error("GEMINI_API_KEY belum dikonfigurasi di Railway.");

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      streamStarted = true;

      const sendEvent = payload => {
        try {
          res.write("data: " + JSON.stringify(payload) + "\n\n");
        } catch (_) {}
      };

      // Expose the chat id immediately so the client can reconnect/restore a pending response.
      sendEvent({ type: "chat", chatId });

      if (needsImageFormatChoice) {
        const clarification = "Boleh 👍 Sebelum saya generate, nak file gambar jenis apa? **PNG, JPG/JPEG, WebP atau AVIF?**";
        await pool.query(
          "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'assistant', $2)",
          [chatId, clarification]
        );
        await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);
        sendEvent({ type: "skill", skill: "image_generate", status: "needs_format" });
        sendEvent({ type: "delta", text: clarification });
        sendEvent({ type: "done", chatId, skill: "image_generate", needsFormat: true, webUsed: false, sources: [] });
        return res.end();
      }

      if (shouldGenerateImage) {
        const generationPrompt = previousImageRequest || message;
        sendEvent({ type: "skill", skill: "image_generate", status: "generating", format: formatSelection || currentFormat });
        try {
          const image = await generateImageData(generationPrompt, formatSelection || currentFormat);
          await pool.query(
            "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'assistant', $2)",
            [chatId, "[AI Gene " + image.format.toUpperCase() + "] " + image.imageDataUrl]
          );
          await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);
          sendEvent({ type: "image", format: image.format, mime: image.mime, imageDataUrl: image.imageDataUrl });
          sendEvent({ type: "done", chatId, skill: "image_generate", format: image.format, webUsed: false, sources: [] });
          return res.end();
        } catch (imageError) {
          console.error("skill image generation:", imageError);
          sendEvent({ type: "error", message: imageError?.message || "Image generation gagal.", code: "IMAGE_GENERATION_ERROR", retryable: true });
          return res.end();
        }
      }

      const pendingReplyMarker = "⏳ AI sedang berfikir…";
      const pendingRow = await pool.query(
        "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
        [chatId, pendingReplyMarker]
      );
      const pendingMessageId = pendingRow.rows[0]?.id;
      await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);

      sendEvent({ type: "skill", skill, status: "selected" });
      sendEvent({ type: "status", message: useSearch ? "Web semak diperlukan…" : "AI streaming bermula…" });

      const contents = history.map(item => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ text: String(item.content || "").slice(-6000) }]
      }));
      const system = `You are AI Fusion Assistant, a fast and accurate personal chat assistant.
Understand Bahasa Melayu, English, mixed Malay-English and slang.
Answer the user's actual request directly and stay on topic.
Use previous messages as conversation context.
${skillInstruction(skill)}
For factual/current questions, prefer verified evidence over guessing.
When Google Search grounding is enabled, use it for fresh facts and base claims on retrieved sources.
Do not invent facts, citations, URLs, or private information.
Keep answers concise unless the user asks for detail.`;
      const config = { systemInstruction: system };
      if (useSearch) config.tools = [{ googleSearch: {} }];

      let lastError = null;
      let finalText = "";
      let usedModel = null;
      let sources = [];

      for (const model of MODELS) {
        try {
          usedModel = model;
          const stream = await gemini.models.generateContentStream({
            model,
            contents,
            config
          });
          for await (const chunk of stream) {
            const delta = chunk?.text || "";
            if (delta) {
              finalText += delta;
              sendEvent({ type: "delta", text: delta });
            }
            const found = extractGoogleSources(chunk);
            if (found.length) sources = found;
          }
          if (finalText.trim()) break;
        } catch (error) {
          lastError = error;
          const msg = String(error?.message || error || "");
          const transient = /\\b(429|500|502|503|504)\\b|UNAVAILABLE|high demand|overloaded|temporar/i.test(msg);
          if (!transient) break;
        }
      }

      if (!finalText.trim()) {
        const error = new Error("AI sementara sibuk. Cuba lagi sebentar.");
        error.code = "AI_UNAVAILABLE";
        error.retryable = true;
        error.cause = lastError;
        throw error;
      }

      const reply = finalText.trim();
      if (pendingMessageId) {
        await pool.query(
          "UPDATE mobile_chat_messages SET content = $1 WHERE id = $2 AND chat_id = $3",
          [reply, pendingMessageId, chatId]
        );
      } else {
        await pool.query(
          "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'assistant', $2)",
          [chatId, reply]
        );
      }
      await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);

      sendEvent({
        type: "done",
        chatId,
        model: usedModel,
        webUsed: sources.length > 0 || useSearch,
        sources: sources.slice(0, 8)
      });
      res.end();
    } catch (error) {
      console.error("mobile chat stream:", error);
      const payload = {
        type: "error",
        message: error?.message || "AI server error.",
        code: error?.code || "AI_SERVER_ERROR",
        retryable: Boolean(error?.retryable)
      };
      if (streamStarted) {
        try { res.write("data: " + JSON.stringify(payload) + "\n\n"); res.end(); } catch (_) {}
      } else {
        res.status(error?.code === "AI_UNAVAILABLE" ? 503 : 500).json(payload);
      }
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

      const history = before.rows.concat([{ role: "user", content: message }]).slice(-MAX_HISTORY).map(item => ({ ...item, content: String(item.content || "").slice(-6000) }));
      let webSources = [];
      let webContext = "";
      let googleSources = [];
      const useSearch = req.body?.research === true || req.body?.evidenceFirst === true || needsWeb(message);
      const skill = detectSkill(message);

      let replyResult;
      try {
        // Fast path: one Gemini request with native Google Search grounding.
        replyResult = await askGemini(history, "", useSearch, skill);
        googleSources = replyResult.sources || [];
      } catch (googleError) {
        if (!useSearch) throw googleError;
        console.warn("Google Search grounding failed, using one fallback web lookup:", googleError.message);
        try {
          webSources = await webResearch(message);
          webContext = compactResearchContext(webSources);
        } catch (fallbackError) {
          console.warn("fallback web research failed:", fallbackError.message);
        }
        replyResult = await askGemini(history, webContext, false, skill);
      }

      const reply = replyResult.text;

      await pool.query(
        "INSERT INTO mobile_chat_messages (chat_id, role, content) VALUES ($1, 'assistant', $2)",
        [chatId, reply]
      );
      await pool.query("UPDATE mobile_chats SET updated_at = NOW() WHERE id = $1", [chatId]);

      res.json({
        chatId,
        reply,
        webUsed: googleSources.length > 0 || webSources.length > 0,
        searchProvider: googleSources.length > 0 ? "google" : (webSources.length > 0 ? "fallback" : "none"),
        sources: [...googleSources, ...webSources]
          .filter((s, i, arr) => s?.url && arr.findIndex(x => x.url === s.url) === i)
          .slice(0, 8)
          .map(s => ({ title: s.title, url: s.url }))
      });
    } catch (error) {
      console.error("mobile chat:", error);
      const status = error?.code === "AI_UNAVAILABLE" ? 503 : 500;
      res.status(status).json({ error: error?.message || "AI server error.", code: error?.code || "AI_SERVER_ERROR", retryable: Boolean(error?.retryable) });
    }
  });
};

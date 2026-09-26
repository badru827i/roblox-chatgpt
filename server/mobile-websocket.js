const https = require("https");
const http = require("http");
const { URL } = require("url");

const rateLimit = new Map();

function getDeviceId(request) {
  const value = String(request.headers["x-device-id"] || "").trim();
  return /^[a-zA-Z0-9_-]{16,128}$/.test(value) ? value : null;
}

function needsWeb(message) {
  const q = String(message || "").toLowerCase().trim();
  if (!q) return false;
  return [
    "cari", "carikan", "search", "google", "web", "internet", "online",
    "terkini", "terbaru", "latest", "today", "hari ini", "sekarang",
    "harga", "price", "berita", "news", "update", "spesifikasi", "spec",
    "sumber", "siapa", "berapa", "2026", "malaysia", "release", "rujukan",
    "current", "semasa", "manufacturer", "official", "datasheet"
  ].some(term => q.includes(term)) ||
    /\b(vs|versus|bandingkan|compare)\b/.test(q);
}

function buildSearchQueries(message) {
  const original = String(message || "").replace(/\s+/g, " ").trim();
  const q = original.toLowerCase();
  const queries = [original];
  if (/\b(harga|price|berapa)\b/.test(q)) queries.push(original + " Malaysia current price");
  if (/\b(spec|spesifikasi|model|telefon|phone|laptop|gpu|cpu)\b/.test(q)) queries.push(original + " official specifications");
  if (/\b(latest|terkini|terbaru|sekarang|hari ini|2026)\b/.test(q)) queries.push(original + " latest 2026");
  if (/\b(cara|macam mana|how|tutorial|fix|baiki)\b/.test(q)) queries.push(original + " official documentation guide");
  if (/\b(berita|news|release|update)\b/.test(q)) queries.push(original + " latest news source");
  if (/\b(harga|price|produk|telefon|phone|laptop)\b/.test(q)) queries.push(original + " current Malaysia");
  if (/\b(spesifikasi|spec|cpu|gpu|model)\b/.test(q)) queries.push(original + " manufacturer datasheet");
  if (/\b(terkini|terbaru|latest|sekarang|hari ini|2026)\b/.test(q)) queries.push(original + " current official");
  return [...new Set(queries)].slice(0, 8);
}

function fetchText(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error("Too many redirects"));

    let parsed;
    try { parsed = new URL(target); }
    catch { return reject(new Error("URL web tidak sah")); }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return reject(new Error("Protocol tidak disokong"));
    }

    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, {
      headers: {
        "User-Agent": "AI-Fusion/1.0 Android WebSocket Research",
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
        if (data.length > 500000) request.destroy();
      });
      response.on("end", () => resolve(data.slice(0, 500000)));
    });

    request.on("timeout", () => request.destroy(new Error("Web timeout")));
    request.on("error", reject);
  });
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
  return htmlDecode(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function webResearch(query) {
  const queries = buildSearchQueries(query);
  const batches = await Promise.all(queries.map(async currentQuery => {
    try {
      return await fetchText(
        "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(currentQuery)
      );
    } catch (_) {
      return "";
    }
  }));
  const searchHtml = batches.join("\n");

  const linkRe = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;

  const results = [];
  let match;

  const seen = new Set();
  while ((match = linkRe.exec(searchHtml)) && results.length < 8) {
    let url = htmlDecode(match[1]);
    const title = stripTags(match[2]);

    if (url.includes("uddg=")) {
      try {
        const u = new URL(url, "https://duckduckgo.com");
        url = decodeURIComponent(u.searchParams.get("uddg") || url);
      } catch (_) {}
    }

    if (url.startsWith("http")) {
      try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        if (seen.has(url) || seen.has(host)) continue;
        seen.add(url); seen.add(host);
      } catch (_) { continue; }
      results.push({ title, url, snippet: "" });
    }
  }

  const snippets = [];
  while ((match = snippetRe.exec(searchHtml)) && snippets.length < 8) {
    snippets.push(stripTags(match[1]));
  }

  results.forEach((result, index) => {
    result.snippet = snippets[index] || "";
  });

  const pages = await Promise.all(results.slice(0, 6).map(async result => {
    try {
      const html = await fetchText(result.url);
      return { ...result, page: stripTags(html).slice(0, 9000) };
    } catch (_) {
      return { ...result, page: "" };
    }
  }));

  return pages.filter(result => result.title || result.page);
}

function allowRequest(deviceId) {
  const key = deviceId || "unknown";
  const now = Date.now();
  const bucket = rateLimit.get(key) || { count: 0, reset: now + 60000 };

  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60000;
  }

  bucket.count++;
  rateLimit.set(key, bucket);
  return bucket.count <= 20;
}

module.exports = function attachMobileWebSocket(wss) {
  // Keep long-lived Android/OkHttp connections alive through Railway's proxy.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 25000);

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws, request) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("error", error => console.error("Mobile WebSocket error:", error?.message || error));
    const deviceId = getDeviceId(request);
    console.log("Mobile WebSocket connected:", deviceId || "invalid-device");
    if (!deviceId) {
      ws.close(1008, "X-Device-Id diperlukan.");
      return;
    }

    ws.send(JSON.stringify({
      type: "status",
      requestId: "",
      percent: 1,
      message: "WebSocket connected"
    }));

    ws.on("close", () => console.log("Mobile WebSocket closed:", deviceId));

    ws.on("message", async raw => {
      let body;
      try {
        body = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({
          type: "error",
          requestId: "",
          message: "JSON tidak sah."
        }));
        return;
      }

      if (body.type !== "research_request") return;

      const requestId = String(body.requestId || "").trim();
      const message = String(body.message || "").trim();

      if (!requestId || !message) {
        ws.send(JSON.stringify({
          type: "error",
          requestId,
          message: "Research request tidak lengkap."
        }));
        return;
      }

      if (!allowRequest(deviceId)) {
        ws.send(JSON.stringify({
          type: "error",
          requestId,
          message: "Terlalu banyak research request. Cuba lagi kemudian."
        }));
        return;
      }

      ws.send(JSON.stringify({
        type: "status",
        requestId,
        percent: 5,
        message: "Research bermula melalui WebSocket"
      }));

      if (!needsWeb(message)) {
        ws.send(JSON.stringify({
          type: "research",
          requestId,
          used: false,
          context: ""
        }));
        ws.send(JSON.stringify({ type: "done", requestId }));
        return;
      }

      try {
        ws.send(JSON.stringify({
          type: "status",
          requestId,
          percent: 12,
          message: "Mencari sumber web…"
        }));

        const sources = await webResearch(message);
        const context = sources.map((source, index) =>
          "[SOURCE " + (index + 1) + "] " + source.title +
          "\nURL: " + source.url +
          "\nSNIPPET: " + source.snippet +
          "\nCONTENT: " + source.page
        ).join("\n\n");

        ws.send(JSON.stringify({
          type: "status",
          requestId,
          percent: 72,
          message: sources.length + " sumber dikumpul • menghantar research"
        }));

        ws.send(JSON.stringify({
          type: "research",
          requestId,
          used: sources.length > 0,
          context
        }));

        ws.send(JSON.stringify({
          type: "status",
          requestId,
          percent: 95,
          message: "Research siap • local 5-model fusion bermula"
        }));

        ws.send(JSON.stringify({
          type: "done",
          requestId
        }));
      } catch (error) {
        ws.send(JSON.stringify({
          type: "error",
          requestId,
          message: error?.message || "Research gagal."
        }));
      }
    });
  });
};

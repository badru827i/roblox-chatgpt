const sharp = require("sharp");
const zlib = require("zlib");

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "text/plain": "txt",
  "application/json": "json",
  "text/css": "css",
  "text/javascript": "js",
  "application/javascript": "js",
  "text/html": "html"
};

function normalizeMime(value) {
  return String(value || "").toLowerCase().split(";")[0].trim();
}

function isImageMime(mime) {
  return /^image\/(png|jpe?g|webp|avif)$/i.test(mime);
}

async function optimizeImage(input, mime, format) {
  const source = sharp(input, { failOn: "none" });
  const target = String(format || "").toLowerCase().replace(/^\./, "");
  let outputMime = mime;
  let output;

  if (target === "png" || (!target && mime === "image/png")) {
    output = await source.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer();
    outputMime = "image/png";
  } else if (target === "webp") {
    output = await source.webp({ lossless: true, effort: 6 }).toBuffer();
    outputMime = "image/webp";
  } else if (target === "avif") {
    output = await source.avif({ lossless: true, effort: 6 }).toBuffer();
    outputMime = "image/avif";
  } else if (target === "jpg" || target === "jpeg") {
    // JPEG cannot preserve pixels losslessly. Refuse instead of silently reducing quality.
    throw new Error("JPG/JPEG tidak disokong untuk mod tanpa kehilangan quality. Guna PNG, WebP Lossless atau AVIF Lossless.");
  } else if (mime === "image/jpeg") {
    // JPEG -> JPEG would require re-encoding and can lose quality, so keep original.
    output = input;
    outputMime = "image/jpeg";
  } else {
    output = input;
  }

  return { output, outputMime };
}

async function optimizeFile({ base64, mimeType, format }) {
  const mime = normalizeMime(mimeType);
  if (!base64 || typeof base64 !== "string") throw new Error("base64 diperlukan.");

  const input = Buffer.from(base64.replace(/^data:[^,]+,/, ""), "base64");
  if (!input.length) throw new Error("Fail kosong atau base64 tidak sah.");
  if (input.length > MAX_FILE_BYTES) throw new Error("Fail terlalu besar. Maksimum 8 MB.");

  let output = input;
  let outputMime = mime;

  if (isImageMime(mime)) {
    ({ output, outputMime } = await optimizeImage(input, mime, format));
  } else if (/^(text\/|application\/(json|javascript))/.test(mime)) {
    // Brotli is lossless for text/code/JSON. The original content is recoverable exactly.
    output = await new Promise((resolve, reject) =>
      zlib.brotliCompress(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, (err, data) =>
        err ? reject(err) : resolve(data)
      )
    );
    outputMime = "application/brotli";
  } else {
    throw new Error("Format ini belum ada optimizer lossless. Fail asal dikekalkan untuk elak kehilangan data.");
  }

  const originalBytes = input.length;
  const outputBytes = output.length;
  return {
    mimeType: outputMime,
    extension: MIME_EXT[outputMime] || (outputMime === "application/brotli" ? "br" : "bin"),
    originalBytes,
    outputBytes,
    savedBytes: Math.max(0, originalBytes - outputBytes),
    savedPercent: originalBytes ? Math.max(0, ((originalBytes - outputBytes) / originalBytes) * 100) : 0,
    smaller: outputBytes < originalBytes,
    lossless: true,
    dataBase64: output.toString("base64")
  };
}

module.exports = { optimizeFile, MAX_FILE_BYTES };

const express = require("express");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
    console.warn("WARNING: API_KEY belum ditetapkan.");
}

if (!OPENAI_API_KEY) {
    console.warn("WARNING: OPENAI_API_KEY belum ditetapkan.");
}

const openai = OPENAI_API_KEY
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Roblox ChatGPT Server"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        openai: Boolean(openai)
    });
});

app.post("/chat", async (req, res) => {
    try {
        if (!API_KEY || req.get("x-api-key") !== API_KEY) {
            return res.status(401).json({
                error: "Unauthorized"
            });
        }

        const message = typeof req.body.message === "string"
            ? req.body.message.trim()
            : "";

        if (!message) {
            return res.status(400).json({
                error: "Message diperlukan"
            });
        }

        if (message.length > 2000) {
            return res.status(413).json({
                error: "Message terlalu panjang"
            });
        }

        if (!openai) {
            return res.status(503).json({
                error: "OpenAI belum dikonfigurasi di server"
            });
        }

        const response = await openai.responses.create({
            model: process.env.OPENAI_MODEL || "gpt-5-mini",
            input: message
        });

        res.json({
            reply: response.output_text
        });
    } catch (error) {
        console.error("Chat error:", error);

        res.status(500).json({
            error: "Server error"
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server berjalan pada port ${PORT}`);
});

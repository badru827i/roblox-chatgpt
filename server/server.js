const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Roblox ChatGPT Server"
    });
});

app.post("/chat", async (req, res) => {
    try {
        const message = req.body.message;

        if (!message) {
            return res.status(400).json({
                error: "Message diperlukan"
            });
        }

        // OpenAI API akan kita sambungkan selepas ini.
        res.json({
            reply: `Saya terima mesej: ${message}`
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Server error"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server berjalan pada port ${PORT}`);
});

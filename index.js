const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── STORAGE ────────────────────────────────────────────────────────────────
const MAX_MESSAGES = 50;
const ONLINE_TTL   = 300; // seconds — 5 minutes

let messages         = [];
let msgIdCounter     = 0;
let onlineSeen       = {}; // playerId → unix timestamp last seen
let profiles         = {}; // playerId → { playerName, description, imageId }
let translateCache   = {}; // "msgId:targetLang" → translatedText

function cleanOnline() {
    const cutoff = Math.floor(Date.now() / 1000) - ONLINE_TTL;
    for (const id in onlineSeen) {
        if (onlineSeen[id] < cutoff) delete onlineSeen[id];
    }
}

function getOnlineCount() {
    cleanOnline();
    return Object.keys(onlineSeen).length;
}

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// ─── POST /api/chat/send ─────────────────────────────────────────────────────
app.post("/api/chat/send", (req, res) => {
    const { playerName, playerId, message, lang } = req.body || {};

    if (!playerName || !playerId || !message) {
        return res.json({ success: false, error: "missing fields" });
    }

    const now = Math.floor(Date.now() / 1000);

    // Track online
    onlineSeen[String(playerId)] = now;

    // Store message
    msgIdCounter++;
    messages.push({
        id:         msgIdCounter,
        playerName: String(playerName),
        playerId:   String(playerId),
        message:    String(message),
        lang:       String(lang || "es"),
        timestamp:  now,
    });

    // Keep only last 50
    if (messages.length > MAX_MESSAGES) {
        messages = messages.slice(messages.length - MAX_MESSAGES);
    }

    console.log(`[ChatGlobal] New message from ${playerName} (${playerId}): ${message}`);

    res.json({ success: true });
});

// ─── GET /api/chat/messages ──────────────────────────────────────────────────
app.get("/api/chat/messages", (req, res) => {
    res.json({
        messages:    messages, // already oldest → newest
        onlineCount: getOnlineCount(),
    });
});

// ─── POST /api/heartbeat ─────────────────────────────────────────────────────
app.post("/api/heartbeat", (req, res) => {
    const { playerId } = req.body || {};
    if (!playerId) return res.json({ ok: false, error: "missing playerId" });
    onlineSeen[String(playerId)] = Math.floor(Date.now() / 1000);
    res.json({ ok: true });
});

// ─── POST /api/translate ─────────────────────────────────────────────────────
// Uses LibreTranslate public API. Language pair comes from the client —
// no auto-detection needed. Results cached by "msgId:targetLang".
// Falls back to a secondary server if the primary fails.
const LIBRE_SERVERS = [
    "https://libretranslate.com",
    "https://translate.argosopentech.com",
];

async function translateText(text, from, to) {
    for (const server of LIBRE_SERVERS) {
        try {
            const response = await fetch(`${server}/translate`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ q: text, source: from, target: to, format: "text" }),
                signal:  AbortSignal.timeout(8000),
            });
            const data = await response.json();
            if (data?.translatedText) {
                console.log(`[Translate] OK via ${server} (${from}→${to})`);
                return data.translatedText;
            }
        } catch (err) {
            console.warn(`[Translate] ${server} failed: ${err.message} — trying next`);
        }
    }
    return null;
}

app.post("/api/translate", async (req, res) => {
    const { text, from, to, msgId } = req.body || {};

    if (!text || !from || !to) {
        return res.json({ success: false, error: "missing fields" });
    }

    // Same language — nothing to do
    if (from === to) {
        return res.json({ success: false, error: "already in target language", from, to });
    }

    // Cache check
    const cacheKey = msgId ? `${msgId}:${to}` : null;
    if (cacheKey && translateCache[cacheKey]) {
        console.log(`[Translate] Cache hit for ${cacheKey}`);
        return res.json({
            success:    true,
            translated: translateCache[cacheKey].translated,
            from:       from,
            to:         to,
            cached:     true,
        });
    }

    try {
        const translated = await translateText(text, from, to);

        if (!translated) {
            return res.json({ success: false, error: "translation failed on all servers" });
        }

        if (cacheKey) {
            translateCache[cacheKey] = { translated, from };
            console.log(`[Translate] Cached ${cacheKey} (${from}→${to})`);
        }

        console.log(`[Translate] ${from}→${to}: "${text.slice(0, 40)}" → "${translated.slice(0, 40)}"`);

        res.json({
            success:    true,
            translated: translated,
            from:       from,
            to:         to,
            cached:     false,
        });

    } catch (err) {
        console.warn("[Translate] Error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

// ─── POST /api/profile/save ──────────────────────────────────────────────────
app.post("/api/profile/save", (req, res) => {
    const { playerId, playerName, description, imageId } = req.body || {};

    if (!playerId) {
        return res.json({ success: false, error: "missing playerId" });
    }

    profiles[String(playerId)] = {
        playerName:  String(playerName  || ""),
        description: String(description || ""),
        imageId:     String(imageId     || ""),
    };

    console.log(`[Profile] Saved profile for ${playerId}`);
    res.json({ success: true });
});

// ─── GET /api/profile/:playerId ──────────────────────────────────────────────
app.get("/api/profile/:playerId", (req, res) => {
    const profile = profiles[String(req.params.playerId)];

    if (!profile) {
        return res.json({ success: false, error: "profile not found" });
    }

    res.json({ success: true, profile });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[ChatGlobal] Backend running on port ${PORT}`);
});

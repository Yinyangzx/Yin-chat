const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── STORAGE ────────────────────────────────────────────────────────────────
const MAX_MESSAGES = 50;
const ONLINE_TTL   = 300; // seconds — 5 minutes

let messages      = [];
let msgIdCounter  = 0;
let onlineSeen    = {}; // playerId → unix timestamp last seen
let profiles      = {}; // playerId → { playerName, description, imageId }

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
    const { playerName, playerId, message } = req.body || {};

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
app.post("/api/translate", async (req, res) => {
    const { text, to } = req.body || {};

    if (!text || !to) {
        return res.json({ success: false, error: "missing fields" });
    }

    try {
        const encoded  = encodeURIComponent(text);
        const url      = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=auto|${to}`;
        const response = await fetch(url);
        const data     = await response.json();

        const translated = data?.responseData?.translatedText;
        const from       = data?.matches?.[0]?.source_segment_language || "auto";

        if (!translated) {
            return res.json({ success: false, error: "empty translation" });
        }

        res.json({
            success:    true,
            translated: translated,
            from:       from,
            to:         to,
        });
    } catch (err) {
        console.warn("[ChatGlobal] Translation error:", err.message);
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

// ─── BUILDER STORAGE ────────────────────────────────────────────────────────
const MAX_PARTS  = 500;
let builderParts = [];   // { id, shape, x, y, z, sx, sy, sz, rx, ry, rz, r, g, b, material, placedBy }
let partIdCounter = 0;

// ─── POST /api/builder/place ─────────────────────────────────────────────────
app.post("/api/builder/place", (req, res) => {
    const { shape, x, y, z, sx, sy, sz, rx, ry, rz, r, g, b, material, placedBy } = req.body || {};

    if (x === undefined || y === undefined || z === undefined) {
        return res.json({ success: false, error: "missing position" });
    }

    partIdCounter++;
    const part = {
        id:        partIdCounter,
        shape:     String(shape     || "Part"),
        x:         Number(x),
        y:         Number(y),
        z:         Number(z),
        sx:        Number(sx        || 4),
        sy:        Number(sy        || 1),
        sz:        Number(sz        || 4),
        rx:        Number(rx        || 0),
        ry:        Number(ry        || 0),
        rz:        Number(rz        || 0),
        r:         Number(r         || 163),
        g:         Number(g         || 162),
        b:         Number(b         || 165),
        material:  String(material  || "SmoothPlastic"),
        placedBy:  String(placedBy  || "unknown"),
        timestamp: Math.floor(Date.now() / 1000),
    };

    builderParts.push(part);

    if (builderParts.length > MAX_PARTS) {
        builderParts = builderParts.slice(builderParts.length - MAX_PARTS);
    }

    console.log(`[Builder] Part placed by ${part.placedBy} at (${part.x}, ${part.y}, ${part.z})`);
    res.json({ success: true, id: part.id });
});

// ─── POST /api/builder/delete ────────────────────────────────────────────────
app.post("/api/builder/delete", (req, res) => {
    const { id } = req.body || {};

    if (!id) return res.json({ success: false, error: "missing id" });

    const before = builderParts.length;
    builderParts = builderParts.filter(p => p.id !== Number(id));

    if (builderParts.length < before) {
        console.log(`[Builder] Part ${id} deleted`);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: "part not found" });
    }
});

// ─── GET /api/builder/parts ──────────────────────────────────────────────────
app.get("/api/builder/parts", (req, res) => {
    res.json({ success: true, parts: builderParts });
});

// ─── POST /api/builder/clear ─────────────────────────────────────────────────
// Limpia todas las partes (útil para empezar una sesión nueva)
app.post("/api/builder/clear", (req, res) => {
    const { confirm } = req.body || {};
    if (confirm !== "yes") return res.json({ success: false, error: "send confirm: yes" });
    builderParts = [];
    console.log("[Builder] All parts cleared");
    res.json({ success: true });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[ChatGlobal] Backend running on port ${PORT}`);
});
                              

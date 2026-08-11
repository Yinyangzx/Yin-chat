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
let pendingKeys   = {}; // username → { key, generatedAt, ip } — set by LootLabs postback

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

// ─── GET /api/key/postback ────────────────────────────────────────────────────
// Called by LootLabs when user completes tasks.
// Params: click_id (username), ip, unique_id
app.get("/api/key/postback", (req, res) => {
    const { click_id, ip, unique_id } = req.query;

    if (!click_id) {
        console.warn("[KeySystem] Postback received without click_id");
        return res.sendStatus(400);
    }

    // Generate key: YY- + 12 random hex chars
    const key = "YY-" + Array.from({ length: 12 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join("");

    pendingKeys[String(click_id).toLowerCase()] = {
        key,
        generatedAt: Math.floor(Date.now() / 1000),
        ip: ip || "unknown",
    };

    console.log(`[KeySystem] Key generated for "${click_id}" — ${key} (ip: ${ip})`);
    res.sendStatus(200);
});

// ─── GET /api/key/claim ───────────────────────────────────────────────────────
// Called by the Lua script after the user completes LootLabs.
// Param: username
app.get("/api/key/claim", (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.json({ success: false, error: "missing username" });
    }

    const entry = pendingKeys[String(username).toLowerCase()];

    if (!entry) {
        return res.json({ success: false, error: "no key found — complete LootLabs first" });
    }

    // Key expires after 10 minutes if not claimed
    const age = Math.floor(Date.now() / 1000) - entry.generatedAt;
    if (age > 600) {
        delete pendingKeys[String(username).toLowerCase()];
        return res.json({ success: false, error: "key expired — complete LootLabs again" });
    }

    console.log(`[KeySystem] Key claimed by "${username}" — ${entry.key}`);
    res.json({ success: true, key: entry.key });
});

// ─── GET /api/key/validate ────────────────────────────────────────────────────
// Called by the Lua script to validate if a stored key is still valid.
// Params: username, key
app.get("/api/key/validate", (req, res) => {
    const { username, key } = req.query;

    if (!username || !key) {
        return res.json({ success: false, error: "missing username or key" });
    }

    const entry = pendingKeys[String(username).toLowerCase()];

    if (!entry) {
        return res.json({ success: false, error: "no pending key found — complete LootLabs first" });
    }

    // Key expires after 24 hours from generation
    const age = Math.floor(Date.now() / 1000) - entry.generatedAt;
    if (age > 86400) { // 86400 seconds = 24 hours
        delete pendingKeys[String(username).toLowerCase()];
        return res.json({ success: false, error: "key expired — complete LootLabs again" });
    }

    // Verify the key matches
    if (entry.key !== String(key)) {
        return res.json({ success: false, error: "invalid key" });
    }

    console.log(`[KeySystem] Key validated for "${username}" — valid for ${Math.floor((86400 - age) / 3600)} more hours`);
    res.json({ 
        success: true, 
        key: entry.key,
        expiresIn: 86400 - age, // seconds until expiration
        expiresAt: entry.generatedAt + 86400 // unix timestamp of expiration
    });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[ChatGlobal] Backend running on port ${PORT}`);
});
                              

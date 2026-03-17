const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config');
const { authenticate } = require('../middleware/auth');

// POST /api/auth/login
// Verifies the player's Minecraft access token with Mojang's profile API
router.post('/login', async (req, res) => {
    try {
        const { username, accessToken } = req.body;
        if (!username || !accessToken)
            return res.status(400).json({ error: 'username and accessToken are required' });

        let profileResp;
        try {
            profileResp = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 8000
            });
        } catch (e) {
            if (e.response?.status === 401)
                return res.status(401).json({ error: 'Invalid or expired access token' });
            return res.status(503).json({ error: 'Could not reach Mojang auth servers' });
        }

        if (!profileResp.data?.id)
            return res.status(401).json({ error: 'Mojang profile verification failed' });

        const uuid = formatUuid(profileResp.data.id);
        const verifiedUsername = profileResp.data.name;

        db.prepare(`
            INSERT INTO users (uuid, username, last_seen)
            VALUES (?, ?, strftime('%s', 'now'))
            ON CONFLICT(uuid) DO UPDATE SET username = excluded.username, last_seen = strftime('%s', 'now')
        `).run(uuid, verifiedUsername);

        const expiresAt = Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN;
        const token = jwt.sign({ uuid, username: verifiedUsername }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        db.prepare('INSERT INTO sessions (token, uuid, expires_at) VALUES (?, ?, ?)').run(token, uuid, expiresAt);

        return res.json({ token, uuid, username: verifiedUsername, expiresAt });
    } catch (e) {
        console.error('Auth error:', e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
    const token = req.headers['authorization'].slice(7);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.json({ success: true });
});

function formatUuid(id) {
    if (id.includes('-')) return id;
    return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

module.exports = router;

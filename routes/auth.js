const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const db      = require('../db/database');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config');
const { authenticate } = require('../middleware/auth');

router.post('/login', async (req, res) => {
    try {
        const { username, accessToken } = req.body;
        if (!username || !accessToken) return res.status(400).json({ error: 'username and accessToken required' });
        let profileResp;
        try {
            profileResp = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
                headers: { Authorization: `Bearer ${accessToken}` }, timeout: 8000 });
        } catch (e) {
            if (e.response?.status === 401) return res.status(401).json({ error: 'Invalid or expired access token' });
            return res.status(503).json({ error: 'Could not reach Mojang' });
        }
        if (!profileResp.data?.id) return res.status(401).json({ error: 'Mojang verification failed' });
        const uuid  = formatUuid(profileResp.data.id);
        const uname = profileResp.data.name;
        db.prepare("INSERT INTO users(uuid,username,last_seen) VALUES(?,?,strftime('%s','now')) ON CONFLICT(uuid) DO UPDATE SET username=excluded.username,last_seen=strftime('%s','now')").run(uuid, uname);
        const expiresAt = Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN;
        const token = jwt.sign({ uuid, username: uname }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        db.prepare('INSERT INTO sessions(token,uuid,expires_at) VALUES(?,?,?)').run(token, uuid, expiresAt);
        return res.json({ token, uuid, username: uname, expiresAt });
    } catch (e) { console.error('Auth:', e); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/logout', authenticate, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token=?').run(req.headers['authorization'].slice(7));
    return res.json({ success: true });
});

function formatUuid(id) {
    if (id.includes('-')) return id;
    return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

module.exports = router;

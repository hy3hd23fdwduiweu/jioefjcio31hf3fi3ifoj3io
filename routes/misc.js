const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { MAX_STEALTH_DURATION, MAX_SHARE_DURATION } = require('../config');

router.use(authenticate);

router.post('/stealth', (req, res) => {
    const { uuid } = req.player;
    const { durationSeconds, active } = req.body;
    if (!active) {
        db.prepare('UPDATE users SET stealth_until=0 WHERE uuid=?').run(uuid);
        return res.json({ success: true, stealthUntil: 0 });
    }
    if (!durationSeconds || durationSeconds < 1 || durationSeconds > MAX_STEALTH_DURATION)
        return res.status(400).json({ error: `Duration must be 1–${MAX_STEALTH_DURATION} seconds` });
    const stealthUntil = Math.floor(Date.now() / 1000) + durationSeconds;
    db.prepare('UPDATE users SET stealth_until=? WHERE uuid=?').run(stealthUntil, uuid);
    return res.json({ success: true, stealthUntil });
});

router.post('/location/share', (req, res) => {
    const { uuid } = req.player;
    const { targetUuid, durationSeconds } = req.body;
    if (targetUuid === uuid) return res.status(400).json({ error: 'Cannot share with yourself' });
    if (!durationSeconds || durationSeconds < 1 || durationSeconds > MAX_SHARE_DURATION)
        return res.status(400).json({ error: `Duration must be 1–${MAX_SHARE_DURATION} seconds` });
    if (db.prepare('SELECT * FROM ignores WHERE uuid=? AND ignored_uuid=?').get(targetUuid, uuid))
        return res.status(403).json({ error: 'That player is ignoring you' });
    const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;
    const id = uuidv4();
    db.prepare('INSERT INTO location_shares (id, from_uuid, to_uuid, expires_at) VALUES (?, ?, ?, ?)').run(id, uuid, targetUuid, expiresAt);
    return res.json({ success: true, shareId: id, expiresAt });
});

router.post('/location/request', (req, res) => {
    const { uuid } = req.player;
    const { targetUuid } = req.body;
    if (db.prepare('SELECT * FROM ignores WHERE uuid=? AND ignored_uuid=?').get(targetUuid, uuid))
        return res.status(403).json({ error: 'That player is ignoring you' });
    const id = uuidv4();
    db.prepare('INSERT INTO location_requests (id, from_uuid, to_uuid) VALUES (?, ?, ?)').run(id, uuid, targetUuid);
    return res.json({ success: true, requestId: id });
});

router.get('/ignores', (req, res) => {
    const ignores = db.prepare(`
        SELECT i.ignored_uuid, u.username FROM ignores i JOIN users u ON u.uuid=i.ignored_uuid WHERE i.uuid=?
    `).all(req.player.uuid);
    return res.json({ ignores });
});

router.post('/ignores/add', (req, res) => {
    const { uuid } = req.player;
    const { targetUuid } = req.body;
    if (targetUuid === uuid) return res.status(400).json({ error: 'Cannot ignore yourself' });
    db.prepare('INSERT OR IGNORE INTO ignores (uuid, ignored_uuid) VALUES (?, ?)').run(uuid, targetUuid);
    return res.json({ success: true });
});

router.post('/ignores/remove', (req, res) => {
    db.prepare('DELETE FROM ignores WHERE uuid=? AND ignored_uuid=?').run(req.player.uuid, req.body.targetUuid);
    return res.json({ success: true });
});

router.get('/broadcasts', (req, res) => {
    const broadcasts = db.prepare('SELECT slot, message, target FROM broadcasts WHERE uuid=? ORDER BY slot').all(req.player.uuid);
    return res.json({ broadcasts });
});

router.post('/broadcasts/save', (req, res) => {
    const { uuid } = req.player;
    const { slot, message, target } = req.body;
    if (slot < 0 || slot > 2) return res.status(400).json({ error: 'Slot must be 0–2' });
    if (!message || message.length > 20) return res.status(400).json({ error: 'Message max 20 characters' });
    if (!['group','friends','both'].includes(target)) return res.status(400).json({ error: 'Invalid target' });
    db.prepare('INSERT OR REPLACE INTO broadcasts (uuid, slot, message, target) VALUES (?, ?, ?, ?)').run(uuid, slot, message, target);
    return res.json({ success: true });
});

router.post('/ping-target', (req, res) => {
    const { target } = req.body;
    if (!['group','friends','both'].includes(target)) return res.status(400).json({ error: 'Invalid target' });
    db.prepare('UPDATE users SET ping_target=? WHERE uuid=?').run(target, req.player.uuid);
    return res.json({ success: true });
});

router.get('/player/:username', (req, res) => {
    const user = db.prepare('SELECT uuid, username, last_seen FROM users WHERE LOWER(username)=LOWER(?)').get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Player not found' });
    return res.json({ user });
});

module.exports = router;

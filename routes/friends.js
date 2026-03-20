const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { MAX_FRIENDS } = require('../config');

router.use(authenticate);

router.get('/', (req, res) => {
    const { uuid } = req.player;
    const friends = db.prepare("SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as friend_uuid, CASE WHEN uuid1=? THEN color_for_1 ELSE color_for_2 END as my_color, u.username FROM friends f JOIN users u ON u.uuid=(CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END) WHERE uuid1=? OR uuid2=?").all(uuid,uuid,uuid,uuid,uuid);
    return res.json({ friends });
});

router.post('/request', (req, res) => {
    const { uuid } = req.player; const { targetUuid } = req.body;
    if (targetUuid === uuid) return res.status(400).json({ error: 'Cannot add yourself' });
    if (!db.prepare('SELECT 1 FROM users WHERE uuid=?').get(targetUuid)) return res.status(404).json({ error: 'Player not found' });
    if (db.prepare('SELECT 1 FROM ignores WHERE uuid=? AND ignored_uuid=?').get(targetUuid, uuid)) return res.status(403).json({ error: 'Player not accepting requests' });
    if (db.prepare('SELECT 1 FROM friends WHERE (uuid1=?AND uuid2=?)OR(uuid1=?AND uuid2=?)').get(uuid,targetUuid,targetUuid,uuid)) return res.status(409).json({ error: 'Already friends' });
    if (db.prepare('SELECT COUNT(*) as c FROM friends WHERE uuid1=? OR uuid2=?').get(uuid,uuid).c >= MAX_FRIENDS) return res.status(400).json({ error: `Max ${MAX_FRIENDS} friends` });
    if (db.prepare("SELECT 1 FROM friend_requests WHERE from_uuid=? AND to_uuid=? AND status='pending'").get(uuid,targetUuid)) return res.status(409).json({ error: 'Request already sent' });
    const id = uuidv4();
    db.prepare('INSERT INTO friend_requests(id,from_uuid,to_uuid) VALUES(?,?,?)').run(id, uuid, targetUuid);
    return res.json({ success: true, requestId: id });
});

router.post('/respond', (req, res) => {
    const { uuid } = req.player; const { requestId, accept } = req.body;
    const request = db.prepare("SELECT * FROM friend_requests WHERE id=? AND to_uuid=? AND status='pending'").get(requestId, uuid);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    db.transaction(() => {
        db.prepare("UPDATE friend_requests SET status=? WHERE id=?").run(accept ? 'accepted' : 'rejected', requestId);
        if (accept) {
            const u1 = request.from_uuid < uuid ? request.from_uuid : uuid;
            const u2 = request.from_uuid < uuid ? uuid : request.from_uuid;
            db.prepare('INSERT OR IGNORE INTO friends(uuid1,uuid2) VALUES(?,?)').run(u1, u2);
        }
    })();
    return res.json({ success: true });
});

router.get('/requests', (req, res) => {
    const reqs = db.prepare("SELECT fr.id,fr.from_uuid,u.username,fr.created_at FROM friend_requests fr JOIN users u ON u.uuid=fr.from_uuid WHERE fr.to_uuid=? AND fr.status='pending' ORDER BY fr.created_at DESC").all(req.player.uuid);
    return res.json({ requests: reqs });
});

router.post('/remove', (req, res) => {
    const { uuid } = req.player; const { friendUuid } = req.body;
    db.prepare('DELETE FROM friends WHERE (uuid1=?AND uuid2=?)OR(uuid1=?AND uuid2=?)').run(uuid,friendUuid,friendUuid,uuid);
    return res.json({ success: true });
});

router.post('/color', (req, res) => {
    const { uuid } = req.player; const { friendUuid, color } = req.body;
    const row = db.prepare('SELECT * FROM friends WHERE (uuid1=?AND uuid2=?)OR(uuid1=?AND uuid2=?)').get(uuid,friendUuid,friendUuid,uuid);
    if (!row) return res.status(404).json({ error: 'Not friends' });
    if (row.uuid1 === uuid) db.prepare('UPDATE friends SET color_for_1=? WHERE uuid1=? AND uuid2=?').run(color, uuid, friendUuid);
    else db.prepare('UPDATE friends SET color_for_2=? WHERE uuid1=? AND uuid2=?').run(color, friendUuid, uuid);
    return res.json({ success: true });
});

module.exports = router;

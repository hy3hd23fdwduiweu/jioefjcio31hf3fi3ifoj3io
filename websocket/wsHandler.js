const jwt = require('jsonwebtoken');
const db  = require('../db/database');
const { JWT_SECRET } = require('../config');

const connections = new Map(); // uuid → ws

function setupWebSocketServer(wss) {
    wss.on('connection', ws => {
        ws.isAlive = true; ws.authenticated = false;
        ws.uuid = null; ws.username = null; ws.serverId = null;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', raw => {
            let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (!ws.authenticated && msg.type !== 'AUTH') return;
            handle(ws, msg);
        });
        ws.on('close', () => {
            if (ws.uuid) {
                connections.delete(ws.uuid);
                notifyTrackers(ws.uuid, { type: 'PLAYER_OFFLINE', uuid: ws.uuid, username: ws.username });
            }
        });
        ws.on('error', e => console.error('WS:', e.message));
    });
    setInterval(() => {
        wss.clients.forEach(ws => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive = false; ws.ping(); });
    }, 30000);
}

function handle(ws, msg) {
    switch (msg.type) {
        case 'AUTH': {
            try {
                const payload = jwt.verify(msg.token, JWT_SECRET);
                const session = db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires_at>?').get(msg.token, Math.floor(Date.now() / 1000));
                if (!session) return send(ws, { type: 'ERROR', code: 'AUTH_FAILED', message: 'Session expired' });
                ws.authenticated = true; ws.uuid = payload.uuid; ws.username = payload.username;
                ws.serverId = msg.serverId || 'unknown';
                const old = connections.get(payload.uuid);
                if (old && old !== ws) { send(old, { type: 'KICKED', reason: 'New connection' }); old.terminate(); }
                connections.set(payload.uuid, ws);
                db.prepare("UPDATE users SET last_seen=strftime('%s','now') WHERE uuid=?").run(payload.uuid);
                db.prepare("UPDATE group_members SET last_active=strftime('%s','now') WHERE uuid=?").run(payload.uuid);
                send(ws, { type: 'AUTH_OK', uuid: payload.uuid, username: payload.username });
                notifyTrackersSameServer(payload.uuid, ws.serverId, { type: 'PLAYER_ONLINE', uuid: payload.uuid, username: payload.username });
            } catch { send(ws, { type: 'ERROR', code: 'AUTH_FAILED', message: 'Invalid token' }); }
            break;
        }
        case 'LOCATION_UPDATE': {
            const now  = Math.floor(Date.now() / 1000);
            const user = db.prepare('SELECT stealth_until FROM users WHERE uuid=?').get(ws.uuid);
            if (user && user.stealth_until > now) break;
            broadcastPosition(ws.uuid, ws.username, ws.serverId, { x: msg.x, y: msg.y, z: msg.z, dimension: msg.dimension });
            break;
        }
        case 'PING_LOCATION': {
            const user    = db.prepare('SELECT ping_target FROM users WHERE uuid=?').get(ws.uuid);
            const payload = { type: 'PING_INCOMING', fromUuid: ws.uuid, fromUsername: ws.username, x: msg.x, y: msg.y, z: msg.z, dimension: msg.dimension };
            getPingRecipients(ws.uuid, user?.ping_target || 'both', ws.serverId)
                .forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
            break;
        }
        case 'GROUP_CHAT': {
            if (!msg.message || msg.message.length > 200) break;
            const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(ws.uuid);
            if (!m) break;
            const payload = { type: 'GROUP_CHAT', groupId: m.group_id, fromUuid: ws.uuid, fromUsername: ws.username, message: msg.message, ts: Date.now() };
            db.prepare('SELECT uuid FROM group_members WHERE group_id=?').all(m.group_id)
                .forEach(r => { const c = connections.get(r.uuid); if (c && c !== ws) send(c, payload); });
            break;
        }
        case 'GROUP_ANNOUNCEMENT': {
            const m = db.prepare("SELECT group_id,role FROM group_members WHERE uuid=?").get(ws.uuid);
            if (!m || !['leader','co-leader'].includes(m.role)) break;
            const group = db.prepare('SELECT * FROM groups WHERE id=?').get(m.group_id);
            const now   = Math.floor(Date.now() / 1000);
            if (now - (group.announcement_at || 0) < 60) break;
            if (!msg.message || msg.message.length > 50) break;
            db.prepare('UPDATE groups SET announcement=?,announcement_at=? WHERE id=?').run(msg.message, now, m.group_id);
            const payload = { type: 'GROUP_ANNOUNCEMENT', groupId: m.group_id, fromUuid: ws.uuid, fromUsername: ws.username, message: msg.message };
            // Send to all OTHER members (sender already shows it client-side immediately)
            db.prepare('SELECT uuid FROM group_members WHERE group_id=?').all(m.group_id)
                .forEach(r => { const c = connections.get(r.uuid); if (c && c !== ws) send(c, payload); });
            break;
        }
        case 'BROADCAST': {
            const bc = db.prepare('SELECT * FROM broadcasts WHERE uuid=? AND slot=?').get(ws.uuid, msg.slot);
            if (!bc) break;
            const payload = { type: 'BROADCAST_INCOMING', fromUuid: ws.uuid, fromUsername: ws.username, message: bc.message, target: bc.target };
            getPingRecipients(ws.uuid, bc.target, ws.serverId)
                .forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
            break;
        }
        case 'STEALTH_UPDATE':
            notifyTrackers(ws.uuid, { type: 'STEALTH_NOTIFY', uuid: ws.uuid, username: ws.username, active: msg.active, until: msg.until });
            break;
        case 'NOTIFY_LOCATION_SHARE': {
            const c = connections.get(msg.toUuid);
            if (c) send(c, { type: 'LOCATION_SHARE_INCOMING', shareId: msg.shareId, fromUuid: ws.uuid, fromUsername: ws.username, durationSeconds: msg.durationSeconds });
            break;
        }
        case 'NOTIFY_LOCATION_REQUEST': {
            const c = connections.get(msg.toUuid);
            if (c) send(c, { type: 'LOCATION_REQUEST_INCOMING', requestId: msg.requestId, fromUuid: ws.uuid, fromUsername: ws.username });
            break;
        }
        case 'NOTIFY_FRIEND_REQUEST': {
            const c = connections.get(msg.toUuid);
            if (c) send(c, { type: 'FRIEND_REQUEST_INCOMING', requestId: msg.requestId, fromUuid: ws.uuid, fromUsername: ws.username });
            break;
        }
        case 'NOTIFY_FRIEND_RESPONSE': {
            const c = connections.get(msg.fromUuid);
            if (c) send(c, { type: 'FRIEND_REQUEST_RESPONDED', requestId: msg.requestId, byUuid: ws.uuid, byUsername: ws.username, accepted: msg.accepted });
            break;
        }
        case 'GROUP_EVENT': {
            const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(ws.uuid);
            if (!m) break;
            db.prepare('SELECT uuid FROM group_members WHERE group_id=?').all(m.group_id)
                .forEach(r => { if (r.uuid !== ws.uuid) { const c = connections.get(r.uuid); if (c) send(c, { type: 'GROUP_EVENT', event: msg.event, groupId: m.group_id, triggeredBy: ws.uuid }); } });
            break;
        }
    }
}

function broadcastPosition(senderUuid, senderUsername, serverId, pos) {
    const viewers = new Set();
    const now = Math.floor(Date.now() / 1000);
    const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(senderUuid);
    if (m) {
        db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=? AND is_blind=0').all(m.group_id, senderUuid)
            .forEach(r => { const c = connections.get(r.uuid); if (c && c.serverId === serverId) viewers.add(r.uuid); });
    }
    db.prepare('SELECT to_uuid FROM location_shares WHERE from_uuid=? AND expires_at>?').all(senderUuid, now)
        .forEach(s => { const c = connections.get(s.to_uuid); if (c && c.serverId === serverId) viewers.add(s.to_uuid); });
    db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(senderUuid, senderUuid, senderUuid)
        .forEach(f => { const c = connections.get(f.uuid); if (c && c.serverId === serverId) viewers.add(f.uuid); });
    const payload = { type: 'LOCATION_DATA', uuid: senderUuid, username: senderUsername, ...pos, ts: Date.now() };
    viewers.forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
}

function notifyTrackers(targetUuid, payload) {
    const viewers = new Set();
    const now = Math.floor(Date.now() / 1000);
    const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(targetUuid);
    if (m) db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=?').all(m.group_id, targetUuid).forEach(r => viewers.add(r.uuid));
    db.prepare('SELECT to_uuid FROM location_shares WHERE from_uuid=? AND expires_at>?').all(targetUuid, now).forEach(s => viewers.add(s.to_uuid));
    db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(targetUuid, targetUuid, targetUuid).forEach(f => viewers.add(f.uuid));
    viewers.forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
}

function notifyTrackersSameServer(targetUuid, serverId, payload) {
    const viewers = new Set();
    const now = Math.floor(Date.now() / 1000);
    const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(targetUuid);
    if (m) db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=?').all(m.group_id, targetUuid)
        .forEach(r => { const c = connections.get(r.uuid); if (c && c.serverId === serverId) viewers.add(r.uuid); });
    db.prepare('SELECT to_uuid FROM location_shares WHERE from_uuid=? AND expires_at>?').all(targetUuid, now)
        .forEach(s => { const c = connections.get(s.to_uuid); if (c && c.serverId === serverId) viewers.add(s.to_uuid); });
    db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(targetUuid, targetUuid, targetUuid)
        .forEach(f => { const c = connections.get(f.uuid); if (c && c.serverId === serverId) viewers.add(f.uuid); });
    viewers.forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
}

function getPingRecipients(senderUuid, target, serverId) {
    const out     = new Set();
    const ignored = new Set(db.prepare('SELECT uuid FROM ignores WHERE ignored_uuid=?').all(senderUuid).map(r => r.uuid));
    if (target === 'group' || target === 'both') {
        const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(senderUuid);
        if (m) db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=?').all(m.group_id, senderUuid)
            .forEach(r => { const c = connections.get(r.uuid); if (c && c.serverId === serverId && !ignored.has(r.uuid)) out.add(r.uuid); });
    }
    if (target === 'friends' || target === 'both') {
        db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(senderUuid, senderUuid, senderUuid)
            .forEach(f => { const c = connections.get(f.uuid); if (c && c.serverId === serverId && !ignored.has(f.uuid)) out.add(f.uuid); });
    }
    return out;
}

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

module.exports = { setupWebSocketServer };

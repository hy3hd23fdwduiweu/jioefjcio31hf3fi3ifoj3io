const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { JWT_SECRET } = require('../config');

const connections = new Map(); // uuid → WebSocket
const positions = new Map();   // uuid → { x, y, z, dimension, ts }
const lastMoveTimes = new Map();
const IDLE_STOP_SECONDS = 180;

function setupWebSocketServer(wss) {
    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.authenticated = false;
        ws.uuid = null;
        ws.username = null;

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (rawData) => {
            let msg;
            try { msg = JSON.parse(rawData.toString()); } catch { return; }
            if (!ws.authenticated && msg.type !== 'AUTH') return sendError(ws, 'UNAUTHORIZED', 'Authenticate first');
            handleMessage(ws, msg);
        });

        ws.on('close', () => {
            if (ws.uuid) {
                connections.delete(ws.uuid);
                positions.delete(ws.uuid);
                notifyTrackers(ws.uuid, { type: 'PLAYER_OFFLINE', uuid: ws.uuid, username: ws.username });
            }
        });

        ws.on('error', (e) => console.error('WS error:', e.message));
    });

    setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) { ws.terminate(); return; }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
}

function handleMessage(ws, msg) {
    switch (msg.type) {
        case 'AUTH': {
            try {
                const payload = jwt.verify(msg.token, JWT_SECRET);
                const session = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(msg.token, Math.floor(Date.now() / 1000));
                if (!session) return sendError(ws, 'AUTH_FAILED', 'Invalid or expired session');

                ws.authenticated = true;
                ws.uuid = payload.uuid;
                ws.username = payload.username;

                const old = connections.get(payload.uuid);
                if (old && old !== ws) { send(old, { type: 'KICKED', reason: 'New connection opened' }); old.terminate(); }
                connections.set(payload.uuid, ws);
                db.prepare("UPDATE users SET last_seen=strftime('%s','now') WHERE uuid=?").run(payload.uuid);
                send(ws, { type: 'AUTH_OK', uuid: payload.uuid, username: payload.username });
                notifyTrackers(payload.uuid, { type: 'PLAYER_ONLINE', uuid: payload.uuid, username: payload.username });
            } catch (e) { sendError(ws, 'AUTH_FAILED', 'Invalid token'); }
            break;
        }

        case 'LOCATION_UPDATE': {
            const { x, y, z, dimension, sendingEnabled } = msg;
            if (!sendingEnabled) break;
            const now = Math.floor(Date.now() / 1000);
            const prev = positions.get(ws.uuid);
            const moved = !prev || Math.abs(prev.x-x)>0.1 || Math.abs(prev.z-z)>0.1 || prev.y!==y;
            if (moved) lastMoveTimes.set(ws.uuid, now);
            const lastMove = lastMoveTimes.get(ws.uuid) || now;
            if (now - lastMove > IDLE_STOP_SECONDS && !moved) break;
            positions.set(ws.uuid, { x, y, z, dimension, ts: now });
            const user = db.prepare('SELECT stealth_until FROM users WHERE uuid=?').get(ws.uuid);
            if (user && user.stealth_until > now) break;
            broadcastPosition(ws.uuid, ws.username, { x, y, z, dimension });
            break;
        }

        case 'PING_LOCATION': {
            const { x, y, z, dimension } = msg;
            const user = db.prepare('SELECT ping_target FROM users WHERE uuid=?').get(ws.uuid);
            const target = user?.ping_target || 'both';
            const payload = { type: 'PING_INCOMING', fromUuid: ws.uuid, fromUsername: ws.username, x, y, z, dimension };
            getPingRecipients(ws.uuid, target).forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
            break;
        }

        case 'GROUP_CHAT': {
            const { message } = msg;
            if (!message || message.length > 200) break;
            const membership = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(ws.uuid);
            if (!membership) break;
            const payload = { type: 'GROUP_CHAT', groupId: membership.group_id, fromUuid: ws.uuid, fromUsername: ws.username, message, ts: Date.now() };
            db.prepare('SELECT uuid FROM group_members WHERE group_id=?').all(membership.group_id)
                .forEach(m => { const c = connections.get(m.uuid); if (c && c !== ws) send(c, payload); });
            break;
        }

        case 'GROUP_ANNOUNCEMENT': {
            const { message } = msg;
            const membership = db.prepare("SELECT group_id, role FROM group_members WHERE uuid=?").get(ws.uuid);
            if (!membership || !['leader','co-leader'].includes(membership.role)) break;
            const group = db.prepare('SELECT * FROM groups WHERE id=?').get(membership.group_id);
            const now = Math.floor(Date.now() / 1000);
            if (now - (group.announcement_at || 0) < 60) break;
            if (!message || message.length > 50) break;
            db.prepare('UPDATE groups SET announcement=?, announcement_at=? WHERE id=?').run(message, now, membership.group_id);
            const payload = { type: 'GROUP_ANNOUNCEMENT', groupId: membership.group_id, fromUuid: ws.uuid, fromUsername: ws.username, message };
            db.prepare('SELECT uuid FROM group_members WHERE group_id=?').all(membership.group_id)
                .forEach(m => { const c = connections.get(m.uuid); if (c) send(c, payload); });
            break;
        }

        case 'BROADCAST': {
            const { slot } = msg;
            const broadcast = db.prepare('SELECT * FROM broadcasts WHERE uuid=? AND slot=?').get(ws.uuid, slot);
            if (!broadcast) break;
            const payload = { type: 'BROADCAST_INCOMING', fromUuid: ws.uuid, fromUsername: ws.username, message: broadcast.message, target: broadcast.target };
            getPingRecipients(ws.uuid, broadcast.target).forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
            break;
        }

        case 'STEALTH_UPDATE': {
            const { active, until } = msg;
            notifyTrackers(ws.uuid, { type: 'STEALTH_NOTIFY', uuid: ws.uuid, username: ws.username, active, until });
            break;
        }

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
            const membership = db.prepare("SELECT group_id FROM group_members WHERE uuid=?").get(ws.uuid);
            if (!membership) break;
            const payload = { type: 'GROUP_EVENT', event: msg.event, groupId: membership.group_id, triggeredBy: ws.uuid };
            db.prepare('SELECT uuid FROM group_members WHERE group_id=?').all(membership.group_id)
                .forEach(m => { if (m.uuid !== ws.uuid) { const c = connections.get(m.uuid); if (c) send(c, payload); } });
            break;
        }
    }
}

function broadcastPosition(senderUuid, senderUsername, pos) {
    const viewers = new Set();
    const membership = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(senderUuid);
    if (membership) {
        db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=? AND is_blind=0').all(membership.group_id, senderUuid)
            .forEach(m => viewers.add(m.uuid));
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare('SELECT to_uuid FROM location_shares WHERE from_uuid=? AND expires_at>?').all(senderUuid, now)
        .forEach(s => viewers.add(s.to_uuid));
    db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(senderUuid, senderUuid, senderUuid)
        .forEach(f => viewers.add(f.uuid));
    const payload = { type: 'LOCATION_DATA', uuid: senderUuid, username: senderUsername, ...pos, ts: Date.now() };
    viewers.forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
}

function notifyTrackers(targetUuid, payload) {
    const viewers = new Set();
    const membership = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(targetUuid);
    if (membership) {
        db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=?').all(membership.group_id, targetUuid)
            .forEach(m => viewers.add(m.uuid));
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare('SELECT to_uuid FROM location_shares WHERE from_uuid=? AND expires_at>?').all(targetUuid, now)
        .forEach(s => viewers.add(s.to_uuid));
    db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(targetUuid, targetUuid, targetUuid)
        .forEach(f => viewers.add(f.uuid));
    viewers.forEach(uuid => { const c = connections.get(uuid); if (c) send(c, payload); });
}

function getPingRecipients(senderUuid, target) {
    const recipients = new Set();
    const ignored = new Set(db.prepare('SELECT ignored_uuid FROM ignores WHERE uuid!=?').all(senderUuid).map(r => r.ignored_uuid));
    if (target === 'group' || target === 'both') {
        const m = db.prepare('SELECT group_id FROM group_members WHERE uuid=?').get(senderUuid);
        if (m) db.prepare('SELECT uuid FROM group_members WHERE group_id=? AND uuid!=?').all(m.group_id, senderUuid)
            .forEach(r => { if (!ignored.has(r.uuid)) recipients.add(r.uuid); });
    }
    if (target === 'friends' || target === 'both') {
        db.prepare('SELECT CASE WHEN uuid1=? THEN uuid2 ELSE uuid1 END as uuid FROM friends WHERE uuid1=? OR uuid2=?').all(senderUuid, senderUuid, senderUuid)
            .forEach(f => { if (!ignored.has(f.uuid)) recipients.add(f.uuid); });
    }
    return recipients;
}

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function sendError(ws, code, message) { send(ws, { type: 'ERROR', code, message }); }

module.exports = { setupWebSocketServer };
```

---

That's every file. The folder structure for your repo is:
```
/
├── package.json
├── index.js
├── config.js
├── .env.example
├── db/
│   ├── schema.sql
│   └── database.js
├── middleware/
│   └── auth.js
├── routes/
│   ├── auth.js
│   ├── groups.js
│   ├── friends.js
│   └── misc.js
└── websocket/
    └── wsHandler.js

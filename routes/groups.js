const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt  = require('bcrypt');
const db      = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { MAX_GROUP_WAYPOINTS, ANNOUNCEMENT_COOLDOWN } = require('../config');

router.use(authenticate);
router.use((req, res, next) => {
    if (req.player) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare("UPDATE users SET last_seen=? WHERE uuid=?").run(now, req.player.uuid);
        db.prepare("UPDATE group_members SET last_active=? WHERE uuid=?").run(now, req.player.uuid);
    }
    next();
});

router.get('/mine', (req, res) => {
    const { uuid } = req.player;
    const serverId = req.query.serverId || '';
    const membership = db.prepare('SELECT * FROM group_members WHERE uuid=? AND server_id=?').get(uuid, serverId);
    if (!membership) return res.json({ group: null });
    const group = db.prepare('SELECT * FROM groups WHERE id=?').get(membership.group_id);
    if (!group) return res.json({ group: null });
    const members   = db.prepare('SELECT gm.uuid,gm.role,gm.icon,gm.is_blind,u.username FROM group_members gm JOIN users u ON u.uuid=gm.uuid WHERE gm.group_id=?').all(group.id);
    const waypoints = db.prepare('SELECT * FROM group_waypoints WHERE group_id=?').all(group.id);
    return res.json({ group: {
        id: group.id, name: group.name, leaderUuid: group.leader_uuid,
        joinMode: group.join_mode, announcement: group.announcement,
        members, waypoints, myRole: membership.role, isBlind: membership.is_blind === 1
    }});
});

router.post('/create', async (req, res) => {
    const { uuid } = req.player;
    const { name, joinMode, password, serverId = '' } = req.body;
    if (!name || name.length < 2 || name.length > 24) return res.status(400).json({ error: 'Name 2–24 chars' });
    if (!['invite','password'].includes(joinMode)) return res.status(400).json({ error: 'Invalid joinMode' });
    if (joinMode === 'password' && (!password || password.length < 3)) return res.status(400).json({ error: 'Password min 3 chars' });
    if (db.prepare('SELECT 1 FROM group_members WHERE uuid=? AND server_id=?').get(uuid, serverId))
        return res.status(409).json({ error: 'Already in a group on this server' });
    if (db.prepare('SELECT 1 FROM groups WHERE name=? AND server_id=?').get(name, serverId))
        return res.status(409).json({ error: 'Group name taken on this server' });
    const groupId = uuidv4();
    const hash    = joinMode === 'password' ? await bcrypt.hash(password, 10) : null;
    const now     = Math.floor(Date.now() / 1000);
    db.transaction(() => {
        db.prepare('INSERT INTO groups(id,name,server_id,leader_uuid,join_mode,password_hash) VALUES(?,?,?,?,?,?)').run(groupId, name, serverId, uuid, joinMode, hash);
        db.prepare("INSERT INTO group_members(group_id,uuid,server_id,role,last_active) VALUES(?,?,?,'leader',?)").run(groupId, uuid, serverId, now);
    })();
    return res.json({ success: true, groupId, name });
});

router.post('/join', async (req, res) => {
    const { uuid } = req.player;
    const { name, password, serverId = '' } = req.body;
    if (db.prepare('SELECT 1 FROM group_members WHERE uuid=? AND server_id=?').get(uuid, serverId))
        return res.status(409).json({ error: 'Already in a group on this server' });
    const group = db.prepare('SELECT * FROM groups WHERE name=? AND server_id=?').get(name, serverId);
    if (!group) return res.status(404).json({ error: 'Group not found on this server' });
    if (group.join_mode === 'invite') {
        const invite = db.prepare('SELECT * FROM group_invites WHERE group_id=? AND invited_uuid=?').get(group.id, uuid);
        if (!invite) return res.status(403).json({ error: 'Invite-only. You need an invite.' });
        db.prepare('DELETE FROM group_invites WHERE id=?').run(invite.id);
    } else {
        if (!password) return res.status(400).json({ error: 'Password required' });
        if (!(await bcrypt.compare(password, group.password_hash))) return res.status(403).json({ error: 'Wrong password' });
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO group_members(group_id,uuid,server_id,role,last_active) VALUES(?,?,?,'member',?)").run(group.id, uuid, serverId, now);
    return res.json({ success: true, groupId: group.id, name: group.name });
});

router.post('/leave', (req, res) => {
    const { uuid } = req.player;
    const m = db.prepare('SELECT * FROM group_members WHERE uuid=?').get(uuid);
    if (!m) return res.status(404).json({ error: 'Not in a group' });
    const count = db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id=?').get(m.group_id).c;
    if (m.role === 'leader' && count > 1) return res.status(400).json({ error: 'Transfer leadership first' });
    db.transaction(() => {
        db.prepare('DELETE FROM group_members WHERE group_id=? AND uuid=?').run(m.group_id, uuid);
        if (count === 1) db.prepare('DELETE FROM groups WHERE id=?').run(m.group_id);
    })();
    return res.json({ success: true });
});

router.post('/kick', requireLeaderOrColeader, (req, res) => {
    const { targetUuid } = req.body;
    if (targetUuid === req.player.uuid) return res.status(400).json({ error: 'Cannot kick yourself' });
    const target = db.prepare('SELECT * FROM group_members WHERE group_id=? AND uuid=?').get(req.group.id, targetUuid);
    if (!target) return res.status(404).json({ error: 'Not in group' });
    if (req.actorRole === 'co-leader' && ['leader','co-leader'].includes(target.role))
        return res.status(403).json({ error: 'Co-leaders cannot kick leaders/co-leaders' });
    if (target.role === 'leader') return res.status(403).json({ error: 'Cannot kick the leader' });
    db.prepare('DELETE FROM group_members WHERE group_id=? AND uuid=?').run(req.group.id, targetUuid);
    return res.json({ success: true });
});

router.post('/promote', requireLeader, (req, res) => {
    const { targetUuid, newRole } = req.body;
    if (!['leader','co-leader','member'].includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
    const target = db.prepare('SELECT * FROM group_members WHERE group_id=? AND uuid=?').get(req.group.id, targetUuid);
    if (!target) return res.status(404).json({ error: 'Not in group' });
    db.transaction(() => {
        db.prepare('UPDATE group_members SET role=? WHERE group_id=? AND uuid=?').run(newRole, req.group.id, targetUuid);
        if (newRole === 'leader') {
            db.prepare("UPDATE group_members SET role='member' WHERE group_id=? AND uuid=?").run(req.group.id, req.player.uuid);
            db.prepare('UPDATE groups SET leader_uuid=? WHERE id=?').run(targetUuid, req.group.id);
        }
    })();
    return res.json({ success: true });
});

router.post('/blind', requireLeaderOrColeader, (req, res) => {
    db.prepare('UPDATE group_members SET is_blind=? WHERE group_id=? AND uuid=?').run(req.body.blind ? 1 : 0, req.group.id, req.body.targetUuid);
    return res.json({ success: true });
});

router.post('/icon', requireLeaderOrColeader, (req, res) => {
    const { targetUuid, icon } = req.body;
    if (icon < 0 || icon > 8) return res.status(400).json({ error: 'Icon 0–8' });
    db.prepare('UPDATE group_members SET icon=? WHERE group_id=? AND uuid=?').run(icon, req.group.id, targetUuid);
    return res.json({ success: true });
});

router.post('/invite', requireLeaderOrColeader, (req, res) => {
    const { targetUuid } = req.body;
    if (req.group.join_mode !== 'invite') return res.status(400).json({ error: 'Not invite-only' });
    if (db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND uuid=?').get(req.group.id, targetUuid))
        return res.status(409).json({ error: 'Already a member' });
    db.prepare('INSERT OR IGNORE INTO group_invites(id,group_id,invited_uuid,invited_by) VALUES(?,?,?,?)').run(uuidv4(), req.group.id, targetUuid, req.player.uuid);
    return res.json({ success: true });
});

router.post('/waypoint/add', requireLeaderOrColeader, (req, res) => {
    const { name, x, y, z, dimension } = req.body;
    if (!name || name.length > 15) return res.status(400).json({ error: 'Name max 15 chars' });
    if (db.prepare('SELECT COUNT(*) as c FROM group_waypoints WHERE group_id=?').get(req.group.id).c >= MAX_GROUP_WAYPOINTS)
        return res.status(409).json({ error: `Max ${MAX_GROUP_WAYPOINTS} waypoints` });
    const id = uuidv4();
    db.prepare('INSERT INTO group_waypoints(id,group_id,name,x,y,z,dimension,created_by) VALUES(?,?,?,?,?,?,?,?)').run(id, req.group.id, name, x, y, z, dimension || 'minecraft:overworld', req.player.uuid);
    return res.json({ success: true, waypointId: id });
});

router.post('/waypoint/remove', requireLeaderOrColeader, (req, res) => {
    db.prepare('DELETE FROM group_waypoints WHERE id=? AND group_id=?').run(req.body.waypointId, req.group.id);
    return res.json({ success: true });
});

router.post('/announcement', requireLeaderOrColeader, (req, res) => {
    const { message } = req.body;
    if (!message || message.length > 50) return res.status(400).json({ error: 'Max 50 chars' });
    const now = Math.floor(Date.now() / 1000);
    if (now - (req.group.announcement_at || 0) < ANNOUNCEMENT_COOLDOWN)
        return res.status(429).json({ error: `Cooldown: ${ANNOUNCEMENT_COOLDOWN - (now - req.group.announcement_at)}s left` });
    db.prepare('UPDATE groups SET announcement=?,announcement_at=? WHERE id=?').run(message, now, req.group.id);
    return res.json({ success: true, message });
});

router.post('/settings', requireLeader, async (req, res) => {
    const { joinMode, password } = req.body;
    if (!['invite','password'].includes(joinMode)) return res.status(400).json({ error: 'Invalid joinMode' });
    const hash = joinMode === 'password' ? await bcrypt.hash(password, 10) : null;
    db.prepare('UPDATE groups SET join_mode=?,password_hash=? WHERE id=?').run(joinMode, hash, req.group.id);
    return res.json({ success: true });
});

router.get('/invites', (req, res) => {
    const invites = db.prepare('SELECT gi.id,gi.group_id,g.name as group_name,gi.invited_by,u.username as invited_by_name FROM group_invites gi JOIN groups g ON g.id=gi.group_id JOIN users u ON u.uuid=gi.invited_by WHERE gi.invited_uuid=?').all(req.player.uuid);
    return res.json({ invites });
});

function requireLeaderOrColeader(req, res, next) {
    const m = db.prepare('SELECT * FROM group_members WHERE uuid=?').get(req.player.uuid);
    if (!m) return res.status(403).json({ error: 'Not in a group' });
    if (!['leader','co-leader'].includes(m.role)) return res.status(403).json({ error: 'Leader or co-leader only' });
    req.group = db.prepare('SELECT * FROM groups WHERE id=?').get(m.group_id);
    req.actorRole = m.role;
    next();
}
function requireLeader(req, res, next) {
    const m = db.prepare('SELECT * FROM group_members WHERE uuid=?').get(req.player.uuid);
    if (!m || m.role !== 'leader') return res.status(403).json({ error: 'Leader only' });
    req.group = db.prepare('SELECT * FROM groups WHERE id=?').get(m.group_id);
    next();
}

module.exports = router;

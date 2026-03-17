const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { MAX_GROUP_WAYPOINTS, ANNOUNCEMENT_COOLDOWN } = require('../config');

router.use(authenticate);

router.get('/mine', (req, res) => {
    const { uuid } = req.player;
    const membership = db.prepare('SELECT * FROM group_members WHERE uuid = ?').get(uuid);
    if (!membership) return res.json({ group: null });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(membership.group_id);
    if (!group) return res.json({ group: null });

    const members = db.prepare(`
        SELECT gm.uuid, gm.role, gm.icon, gm.is_blind, u.username
        FROM group_members gm JOIN users u ON u.uuid = gm.uuid
        WHERE gm.group_id = ?
    `).all(group.id);

    const waypoints = db.prepare('SELECT * FROM group_waypoints WHERE group_id = ?').all(group.id);

    return res.json({ group: {
        id: group.id, name: group.name, leaderUuid: group.leader_uuid,
        joinMode: group.join_mode, announcement: group.announcement,
        members, waypoints, myRole: membership.role, isBlind: membership.is_blind === 1
    }});
});

router.post('/create', async (req, res) => {
    const { uuid } = req.player;
    const { name, joinMode, password } = req.body;
    if (!name || name.length < 2 || name.length > 24)
        return res.status(400).json({ error: 'Group name must be 2–24 characters' });
    if (!['invite','password'].includes(joinMode))
        return res.status(400).json({ error: 'joinMode must be invite or password' });
    if (joinMode === 'password' && (!password || password.length < 3))
        return res.status(400).json({ error: 'Password must be at least 3 characters' });
    if (db.prepare('SELECT * FROM group_members WHERE uuid = ?').get(uuid))
        return res.status(409).json({ error: 'Already in a group. Leave first.' });
    if (db.prepare('SELECT id FROM groups WHERE name = ?').get(name))
        return res.status(409).json({ error: 'Group name already taken' });

    const groupId = uuidv4();
    const passwordHash = joinMode === 'password' ? await bcrypt.hash(password, 10) : null;

    db.transaction(() => {
        db.prepare('INSERT INTO groups (id, name, leader_uuid, join_mode, password_hash) VALUES (?, ?, ?, ?, ?)').run(groupId, name, uuid, joinMode, passwordHash);
        db.prepare("INSERT INTO group_members (group_id, uuid, role) VALUES (?, ?, 'leader')").run(groupId, uuid);
    })();

    return res.json({ success: true, groupId, name });
});

router.post('/join', async (req, res) => {
    const { uuid } = req.player;
    const { name, password } = req.body;
    if (db.prepare('SELECT * FROM group_members WHERE uuid = ?').get(uuid))
        return res.status(409).json({ error: 'Already in a group. Leave first.' });

    const group = db.prepare('SELECT * FROM groups WHERE name = ?').get(name);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    if (group.join_mode === 'invite') {
        const invite = db.prepare('SELECT * FROM group_invites WHERE group_id = ? AND invited_uuid = ?').get(group.id, uuid);
        if (!invite) return res.status(403).json({ error: 'This group is invite-only.' });
        db.prepare('DELETE FROM group_invites WHERE id = ?').run(invite.id);
    } else {
        if (!password) return res.status(400).json({ error: 'Password required' });
        if (!(await bcrypt.compare(password, group.password_hash)))
            return res.status(403).json({ error: 'Wrong password' });
    }

    db.prepare("INSERT INTO group_members (group_id, uuid, role) VALUES (?, ?, 'member')").run(group.id, uuid);
    return res.json({ success: true, groupId: group.id, name: group.name });
});

router.post('/leave', (req, res) => {
    const { uuid } = req.player;
    const membership = db.prepare('SELECT * FROM group_members WHERE uuid = ?').get(uuid);
    if (!membership) return res.status(404).json({ error: 'Not in a group' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(membership.group_id);
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id = ?').get(group.id).c;

    if (membership.role === 'leader' && memberCount > 1)
        return res.status(400).json({ error: 'Transfer leadership before leaving' });

    db.transaction(() => {
        db.prepare('DELETE FROM group_members WHERE group_id = ? AND uuid = ?').run(group.id, uuid);
        if (memberCount === 1) {
            db.prepare('DELETE FROM group_waypoints WHERE group_id = ?').run(group.id);
            db.prepare('DELETE FROM group_invites WHERE group_id = ?').run(group.id);
            db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
        }
    })();

    return res.json({ success: true });
});

router.post('/kick', requireLeaderOrColeader, (req, res) => {
    const { targetUuid } = req.body;
    const group = req.group;
    if (targetUuid === req.player.uuid) return res.status(400).json({ error: 'Cannot kick yourself' });
    const target = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND uuid = ?').get(group.id, targetUuid);
    if (!target) return res.status(404).json({ error: 'Player not in group' });
    if (req.actorRole === 'co-leader' && ['leader','co-leader'].includes(target.role))
        return res.status(403).json({ error: 'Co-leaders can only kick regular members' });
    if (target.role === 'leader') return res.status(403).json({ error: 'Cannot kick the leader' });
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND uuid = ?').run(group.id, targetUuid);
    return res.json({ success: true });
});

router.post('/promote', requireLeader, (req, res) => {
    const { targetUuid, newRole } = req.body;
    const group = req.group;
    const { uuid: actorUuid } = req.player;
    if (!['leader','co-leader','member'].includes(newRole))
        return res.status(400).json({ error: 'Invalid role' });
    const target = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND uuid = ?').get(group.id, targetUuid);
    if (!target) return res.status(404).json({ error: 'Player not in group' });

    db.transaction(() => {
        db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND uuid = ?').run(newRole, group.id, targetUuid);
        if (newRole === 'leader') {
            db.prepare("UPDATE group_members SET role = 'member' WHERE group_id = ? AND uuid = ?").run(group.id, actorUuid);
            db.prepare('UPDATE groups SET leader_uuid = ? WHERE id = ?').run(targetUuid, group.id);
        }
    })();

    return res.json({ success: true });
});

router.post('/blind', requireLeaderOrColeader, (req, res) => {
    const { targetUuid, blind } = req.body;
    const group = req.group;
    const target = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND uuid = ?').get(group.id, targetUuid);
    if (!target) return res.status(404).json({ error: 'Player not in group' });
    db.prepare('UPDATE group_members SET is_blind = ? WHERE group_id = ? AND uuid = ?').run(blind ? 1 : 0, group.id, targetUuid);
    return res.json({ success: true });
});

router.post('/icon', requireLeaderOrColeader, (req, res) => {
    const { targetUuid, icon } = req.body;
    const group = req.group;
    if (icon < 0 || icon > 8) return res.status(400).json({ error: 'Icon must be 0–8' });
    const target = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND uuid = ?').get(group.id, targetUuid);
    if (!target) return res.status(404).json({ error: 'Player not in group' });
    db.prepare('UPDATE group_members SET icon = ? WHERE group_id = ? AND uuid = ?').run(icon, group.id, targetUuid);
    return res.json({ success: true });
});

router.post('/invite', requireLeaderOrColeader, (req, res) => {
    const { targetUuid } = req.body;
    const group = req.group;
    if (group.join_mode !== 'invite') return res.status(400).json({ error: 'Group is not invite-only' });
    if (db.prepare('SELECT * FROM group_members WHERE group_id = ? AND uuid = ?').get(group.id, targetUuid))
        return res.status(409).json({ error: 'Player is already a member' });
    db.prepare('INSERT INTO group_invites (id, group_id, invited_uuid, invited_by) VALUES (?, ?, ?, ?)').run(uuidv4(), group.id, targetUuid, req.player.uuid);
    return res.json({ success: true });
});

router.post('/waypoint/add', requireLeaderOrColeader, (req, res) => {
    const { name, x, y, z, dimension } = req.body;
    const group = req.group;
    if (!name || name.length > 15) return res.status(400).json({ error: 'Waypoint name max 15 characters' });
    const count = db.prepare('SELECT COUNT(*) as c FROM group_waypoints WHERE group_id = ?').get(group.id).c;
    if (count >= MAX_GROUP_WAYPOINTS) return res.status(409).json({ error: `Max ${MAX_GROUP_WAYPOINTS} waypoints` });
    const id = uuidv4();
    db.prepare('INSERT INTO group_waypoints (id, group_id, name, x, y, z, dimension, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, group.id, name, x, y, z, dimension || 'minecraft:overworld', req.player.uuid);
    return res.json({ success: true, waypointId: id });
});

router.post('/waypoint/remove', requireLeaderOrColeader, (req, res) => {
    const { waypointId } = req.body;
    db.prepare('DELETE FROM group_waypoints WHERE id = ? AND group_id = ?').run(waypointId, req.group.id);
    return res.json({ success: true });
});

router.post('/announcement', requireLeaderOrColeader, (req, res) => {
    const { message } = req.body;
    const group = req.group;
    if (!message || message.length > 50) return res.status(400).json({ error: 'Max 50 characters' });
    const now = Math.floor(Date.now() / 1000);
    if (now - (group.announcement_at || 0) < ANNOUNCEMENT_COOLDOWN) {
        const remaining = ANNOUNCEMENT_COOLDOWN - (now - group.announcement_at);
        return res.status(429).json({ error: `Cooldown: ${remaining}s remaining` });
    }
    db.prepare('UPDATE groups SET announcement = ?, announcement_at = ? WHERE id = ?').run(message, now, group.id);
    return res.json({ success: true, message });
});

router.post('/settings', requireLeader, async (req, res) => {
    const { joinMode, password } = req.body;
    const group = req.group;
    if (!['invite','password'].includes(joinMode)) return res.status(400).json({ error: 'Invalid joinMode' });
    const passwordHash = joinMode === 'password' ? await bcrypt.hash(password, 10) : null;
    db.prepare('UPDATE groups SET join_mode = ?, password_hash = ? WHERE id = ?').run(joinMode, passwordHash, group.id);
    return res.json({ success: true });
});

router.get('/invites', (req, res) => {
    const { uuid } = req.player;
    const invites = db.prepare(`
        SELECT gi.id, gi.group_id, g.name as group_name, gi.invited_by, u.username as invited_by_name
        FROM group_invites gi JOIN groups g ON g.id = gi.group_id JOIN users u ON u.uuid = gi.invited_by
        WHERE gi.invited_uuid = ?
    `).all(uuid);
    return res.json({ invites });
});

function requireLeaderOrColeader(req, res, next) {
    const membership = db.prepare('SELECT * FROM group_members WHERE uuid = ?').get(req.player.uuid);
    if (!membership) return res.status(403).json({ error: 'Not in a group' });
    if (!['leader','co-leader'].includes(membership.role)) return res.status(403).json({ error: 'Leader or co-leader only' });
    req.group = db.prepare('SELECT * FROM groups WHERE id = ?').get(membership.group_id);
    req.actorRole = membership.role;
    next();
}

function requireLeader(req, res, next) {
    const membership = db.prepare('SELECT * FROM group_members WHERE uuid = ?').get(req.player.uuid);
    if (!membership || membership.role !== 'leader') return res.status(403).json({ error: 'Group leader only' });
    req.group = db.prepare('SELECT * FROM groups WHERE id = ?').get(membership.group_id);
    next();
}

module.exports = router;

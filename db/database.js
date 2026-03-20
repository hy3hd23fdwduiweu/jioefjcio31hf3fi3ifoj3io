const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'teamtracker.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

setInterval(() => {
    const now          = Math.floor(Date.now() / 1000);
    const thirtyDays   = now - 30 * 24 * 3600;
    const fourteenDays = now - 14 * 24 * 3600;

    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM location_shares WHERE expires_at < ?').run(now);
    db.prepare("DELETE FROM friend_requests WHERE status='pending' AND created_at < ?").run(now - 7 * 24 * 3600);

    // Kick non-leader members inactive 30+ days
    db.prepare("DELETE FROM group_members WHERE role != 'leader' AND last_active < ?").run(thirtyDays);

    // Leaders inactive 30+ days: transfer or delete group
    const staleLeaders = db.prepare("SELECT uuid, group_id FROM group_members WHERE role='leader' AND last_active < ?").all(thirtyDays);
    for (const { uuid, group_id } of staleLeaders) {
        const next = db.prepare("SELECT uuid FROM group_members WHERE group_id=? AND uuid!=? ORDER BY last_active DESC LIMIT 1").get(group_id, uuid);
        if (next) {
            db.prepare("UPDATE group_members SET role='leader' WHERE group_id=? AND uuid=?").run(group_id, next.uuid);
            db.prepare("UPDATE groups SET leader_uuid=? WHERE id=?").run(next.uuid, group_id);
            db.prepare("DELETE FROM group_members WHERE group_id=? AND uuid=?").run(group_id, uuid);
        } else {
            db.prepare('DELETE FROM groups WHERE id=?').run(group_id);
        }
    }

    // Delete groups with no activity in 14 days
    for (const { id } of db.prepare('SELECT id FROM groups').all()) {
        const { c } = db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id=? AND last_active > ?').get(id, fourteenDays);
        if (c === 0) db.prepare('DELETE FROM groups WHERE id=?').run(id);
    }

    // Remove friendships where either user hasn't been seen in 30 days
    db.prepare('DELETE FROM friends WHERE uuid1 IN (SELECT uuid FROM users WHERE last_seen < ?) OR uuid2 IN (SELECT uuid FROM users WHERE last_seen < ?)').run(thirtyDays, thirtyDays);

}, 60 * 60 * 1000);

module.exports = db;

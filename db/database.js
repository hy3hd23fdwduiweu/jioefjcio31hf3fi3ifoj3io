const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'teamtracker.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM location_shares WHERE expires_at < ?').run(now);
    db.prepare("DELETE FROM friend_requests WHERE status = 'pending' AND created_at < ?").run(now - 7 * 24 * 3600);
}, 10 * 60 * 1000);

module.exports = db;

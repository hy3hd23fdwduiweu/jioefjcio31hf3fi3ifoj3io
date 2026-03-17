PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
    uuid TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    last_seen INTEGER DEFAULT 0,
    stealth_until INTEGER DEFAULT 0,
    ping_target TEXT DEFAULT 'both',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    uuid TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    leader_uuid TEXT NOT NULL,
    join_mode TEXT NOT NULL DEFAULT 'invite',
    password_hash TEXT,
    announcement TEXT DEFAULT '',
    announcement_at INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    uuid TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    icon INTEGER DEFAULT 0,
    is_blind INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (group_id, uuid),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_waypoints (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    dimension TEXT DEFAULT 'minecraft:overworld',
    created_by TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_invites (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    invited_uuid TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS friends (
    uuid1 TEXT NOT NULL,
    uuid2 TEXT NOT NULL,
    color_for_1 INTEGER DEFAULT -1,
    color_for_2 INTEGER DEFAULT -1,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (uuid1, uuid2)
);

CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_uuid TEXT NOT NULL,
    to_uuid TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS location_shares (
    id TEXT PRIMARY KEY,
    from_uuid TEXT NOT NULL,
    to_uuid TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS location_requests (
    id TEXT PRIMARY KEY,
    from_uuid TEXT NOT NULL,
    to_uuid TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS ignores (
    uuid TEXT NOT NULL,
    ignored_uuid TEXT NOT NULL,
    PRIMARY KEY (uuid, ignored_uuid)
);

CREATE TABLE IF NOT EXISTS broadcasts (
    uuid TEXT NOT NULL,
    slot INTEGER NOT NULL,
    message TEXT NOT NULL,
    target TEXT DEFAULT 'both',
    PRIMARY KEY (uuid, slot)
);

CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(uuid);
CREATE INDEX IF NOT EXISTS idx_group_members_uuid ON group_members(uuid);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_friends_uuid1 ON friends(uuid1);
CREATE INDEX IF NOT EXISTS idx_friends_uuid2 ON friends(uuid2);
CREATE INDEX IF NOT EXISTS idx_location_shares_to ON location_shares(to_uuid);
CREATE INDEX IF NOT EXISTS idx_location_shares_from ON location_shares(from_uuid);

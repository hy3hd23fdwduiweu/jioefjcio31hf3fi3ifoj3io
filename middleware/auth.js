const jwt = require('jsonwebtoken');
const db  = require('../db/database');
const { JWT_SECRET } = require('../config');

function authenticate(req, res, next) {
    const h = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
    const token = h.slice(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const session = db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires_at>?').get(token, Math.floor(Date.now() / 1000));
        if (!session) return res.status(401).json({ error: 'Session expired' });
        req.player = { uuid: payload.uuid, username: payload.username };
        next();
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

module.exports = { authenticate };

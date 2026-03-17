const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { JWT_SECRET } = require('../config');

function authenticate(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer '))
        return res.status(401).json({ error: 'Missing Authorization header' });

    const token = authHeader.slice(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
            .get(token, Math.floor(Date.now() / 1000));
        if (!session) return res.status(401).json({ error: 'Session expired or revoked' });
        req.player = { uuid: payload.uuid, username: payload.username };
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

module.exports = { authenticate };

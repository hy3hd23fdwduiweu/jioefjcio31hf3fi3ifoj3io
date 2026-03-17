require('dotenv').config();

module.exports = {
    PORT: parseInt(process.env.PORT || '3000'),
    JWT_SECRET: process.env.JWT_SECRET || 'CHANGE_THIS_IN_PRODUCTION',
    JWT_EXPIRES_IN: parseInt(process.env.JWT_EXPIRES_IN || String(24 * 60 * 60)),
    ANNOUNCEMENT_COOLDOWN: 60,
    MAX_GROUP_WAYPOINTS: 3,
    MAX_FRIENDS: 6,
    MAX_STEALTH_DURATION: 3600,
    MAX_SHARE_DURATION: 8 * 3600,
};

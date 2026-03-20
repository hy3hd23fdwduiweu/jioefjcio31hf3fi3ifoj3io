require('dotenv').config();
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const { PORT } = require('./config');
const { setupWebSocketServer } = require('./websocket/wsHandler');

const app    = express();
const server = http.createServer(app);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const limiter     = rateLimit({ windowMs: 60*1000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 5*60*1000, max: 10 });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/groups',  require('./routes/groups'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api',         require('./routes/misc'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Internal server error' }); });

const wss = new WebSocket.Server({ server, path: '/ws' });
setupWebSocketServer(wss);
server.listen(PORT, () => console.log(`TeamTracker server on port ${PORT}`));

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Paths seguros
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true }
});

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ======= Estado en memoria =======
let config = {
  min: 1,
  max: 10,            // 5 | 10 | 20
  touchesToWin: 5,    // veces que debe salir un número para ganar
  winnersPerRound: 3, // cuántos ganadores cierran la ronda
};
let counts = {};        // { numero: veces }
let drawn = [];         // historial
let presetQueue = [];   // cola pública programada por admin
let winners = [];       // ganadores de la ronda
let isRoundActive = false;

// Plan secreto (se ve aleatorio al público)
let stealthQueue = [];     // cola oculta: mezcla de null (random) y forzados
let plannedWinners = [];   // lista de ganadores planeados por admin

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// ======= Utils =======
function resetRound() {
  counts = {};
  drawn = [];
  winners = [];
  stealthQueue = [];
  // plannedWinners = []; // si quieres limpiar el plan en cada reset, descomenta
  isRoundActive = true;
  io.emit('round:reset', { config });
}

function nextRandom() {
  const { min, max } = config;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function prediction() {
  const list = [];
  for (let n = config.min; n <= config.max; n++) {
    const have = counts[n] || 0;
    const inStealth = stealthQueue.filter(x => x === n).length;
    const inPreset = presetQueue.filter(x => x === n).length;
    const remaining = Math.max(0, config.touchesToWin - (have + inStealth + inPreset));
    list.push({ number: n, have, inQueue: inStealth + inPreset, remaining, isWinner: winners.includes(n) });
  }
  list.sort((a, b) => a.remaining - b.remaining || b.have - a.have);
  return { list, queue: [...presetQueue], winners: [...winners], config };
}

function drawOne() {
  if (!isRoundActive) isRoundActive = true;

  let next = null;
  if (stealthQueue.length) {
    const token = stealthQueue.shift();
    next = (token === null) ? nextRandom() : token;
  } else if (presetQueue.length) {
    next = presetQueue.shift();
  } else {
    next = nextRandom();
  }

  const n = next;
  counts[n] = (counts[n] || 0) + 1;
  drawn.push(n);

  if (!winners.includes(n) && counts[n] >= config.touchesToWin) winners.push(n);

  const payload = { number: n, counts, drawn, winners, config, plannedWinners, stealthLeft: stealthQueue.length };
  io.emit('draw', payload);

  if (winners.length >= config.winnersPerRound) {
    isRoundActive = false;
    io.emit('round:over', { winners, config, plannedWinners });
  }
  return payload;
}

function remainingForTarget(n) {
  const have = counts[n] || 0;
  const inStealth = stealthQueue.filter(x => x === n).length;
  const inPreset = presetQueue.filter(x => x === n).length;
  return Math.max(0, config.touchesToWin - (have + inStealth + inPreset));
}

function buildStealthQueue(targets, gapMin = 1, gapMax = 4) {
  const seq = [];
  for (const t of targets) {
    const faltan = remainingForTarget(t);
    for (let i = 0; i < faltan; i++) {
      const gaps = Math.floor(Math.random() * (gapMax - gapMin + 1)) + gapMin;
      for (let g = 0; g < gaps; g++) seq.push(null); // null => random
      seq.push(t); // forzada
    }
  }
  for (let i = 0; i < 2; i++) seq.push(null); // ruido final
  return seq;
}

// ======= Auth helpers =======
function signToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
}
function authMiddleware(req, res, next) {
  const bearer = req.headers.authorization?.split(' ')[1];
  const token = bearer || req.cookies['token'];
  try {
    const data = jwt.verify(token, JWT_SECRET);
    if (data.role !== 'admin') throw new Error('forbidden');
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
}

// ======= Rutas públicas =======
app.get('/api/state', (_req, res) =>
  res.json({ config, counts, drawn, winners, isRoundActive })
);

// ======= Rutas admin =======
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || 'admin')) {
    return res.status(401).json({ ok: false, error: 'Clave incorrecta' });
  }
  const token = signToken();

  // cookie robusta (en Render es secure)
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  });

  // devolvemos el token para usarlo en Authorization
  res.json({ ok: true, token });
});

app.get('/api/admin/config', authMiddleware, (_req, res) => {
  res.json({ config, presetQueue, counts, drawn, winners, prediction: prediction() });
});

app.post('/api/admin/config', authMiddleware, (req, res) => {
  const { min, max, touchesToWin, winnersPerRound } = req.body;
  if (![5, 10, 20].includes(Number(max)) || Number(min) !== 1) {
    return res.status(400).json({ ok: false, error: 'Rango permitido: 1–5, 1–10 o 1–20' });
  }
  config = {
    min: 1,
    max: Number(max),
    touchesToWin: Math.max(1, Math.min(20, Number(touchesToWin ?? config.touchesToWin))),
    winnersPerRound: Math.max(1, Math.min(10, Number(winnersPerRound ?? config.winnersPerRound))),
  };
  resetRound();
  res.json({ ok: true, config });
});

app.post('/api/admin/preset', authMiddleware, (req, res) => {
  const { numbers } = req.body; // array
  if (!Array.isArray(numbers)) return res.status(400).json({ ok: false, error: 'numbers debe ser Array' });
  const valid = numbers.every(n => Number.isInteger(n) && n >= config.min && n <= config.max);
  if (!valid) return res.status(400).json({ ok: false, error: 'Número fuera de rango' });
  presetQueue.push(...numbers.map(Number));
  res.json({ ok: true, presetQueue, prediction: prediction() });
});

app.post('/api/admin/round/reset', authMiddleware, (_req, res) => {
  resetRound();
  res.json({ ok: true, config });
});

app.post('/api/admin/draw', authMiddleware, (_req, res) => {
  const payload = drawOne();
  res.json({ ok: true, payload });
});

// 👉 Hace ganar un número ahora: rellena la cola con lo que falta
app.post('/api/admin/makewin', authMiddleware, (req, res) => {
  const { number } = req.body;
  const n = Number(number);
  if (!Number.isInteger(n) || n < config.min || n > config.max) {
    return res.status(400).json({ ok: false, error: 'Número fuera de rango' });
  }
  const faltan = remainingForTarget(n);
  if (faltan > 0) presetQueue.push(...Array(faltan).fill(n));
  res.json({ ok: true, added: faltan, presetQueue, prediction: prediction() });
});

// 👉 Plan secreto
app.post('/api/admin/plan', authMiddleware, (req, res) => {
  const { winners: ws = [], gapMin = 1, gapMax = 4 } = req.body;
  if (!Array.isArray(ws) || ws.length === 0) {
    return res.status(400).json({ ok: false, error: 'Envía winners como array (1–3 números)' });
  }
  const valid = ws.every(n => Number.isInteger(n) && n >= config.min && n <= config.max);
  if (!valid) return res.status(400).json({ ok: false, error: 'Número fuera de rango' });

  plannedWinners = Array.from(new Set(ws.map(Number))).slice(0, 3);
  stealthQueue = buildStealthQueue(plannedWinners, gapMin, gapMax);
  return res.json({ ok: true, plannedWinners, stealthLeft: stealthQueue.length, prediction: prediction() });
});

app.get('/api/admin/plan', authMiddleware, (_req, res) => {
  res.json({ ok: true, plannedWinners, stealthLeft: stealthQueue.length, prediction: prediction() });
});

// ======= WebSocket =======
io.on('connection', (socket) => {
  socket.emit('hydrate', { config, counts, drawn, winners });
  socket.on('public:draw', () => {
    const payload = drawOne();
    socket.emit('ack', payload);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Servidor en http://localhost:${PORT} (sirviendo ${PUBLIC_DIR})`)
);

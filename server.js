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

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ======= Estado =======
let config = { min: 1, max: 10, touchesToWin: 5, winnersPerRound: 3 };

let counts = {};            // {n: veces}
let drawn = [];             // historial
let presetQueue = [];       // cola visible
let winners = [];           // ganadores firmes
let isRoundActive = false;

const RECENT_WINDOW = 3;    // anti-repetición evidente
let recent = [];            // últimos N

// Plan secreto (cola oculta)
let stealthQueue = [];      // [null | n]
let plannedWinners = [];    // objetivos del admin

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// ======= Util =======
const range = () => Array.from({ length: config.max - config.min + 1 }, (_, i) => config.min + i);
const eligibleNumbers = () => range().filter(n => !winners.includes(n));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function resetRound() {
  counts = {}; drawn = []; recent = []; winners = [];
  stealthQueue = []; /* plannedWinners se mantiene para que puedas reusar si quieres */
  isRoundActive = true;
  io.emit('round:reset', { config });
}

function purgeQueuesOf(n) {
  presetQueue = presetQueue.filter(x => x !== n);
  stealthQueue = stealthQueue.filter(x => x === null || x !== n);
}

function remainingToWin(n) {
  const have = counts[n] || 0;
  const inStealth = stealthQueue.filter(x => x === n).length;
  const inPreset = presetQueue.filter(x => x === n).length;
  return Math.max(0, config.touchesToWin - (have + inStealth + inPreset));
}

// === Aleatoriedad “natural” (con refuerzo opcional para el plan) ===
function isPlanActive() {
  const targets = plannedWinners.filter(n => !winners.includes(n));
  const stillForced = stealthQueue.some(x => x !== null);
  return targets.length > 0 || stillForced;
}
function activeTargets() { return plannedWinners.filter(n => !winners.includes(n)); }

function weightedPick(candidates) {
  if (candidates.length === 1) return candidates[0];

  const active = isPlanActive() ? new Set(activeTargets()) : null;

  const weights = candidates.map(n => {
    // más faltantes => más peso
    const have = counts[n] || 0;
    let w = 1 + Math.max(0, config.touchesToWin - have);

    // penaliza si salió muy recientemente
    if (recent.includes(n)) w *= 0.35;

    // si hay plan activo: refuerza objetivos y frena un poco al resto (sin cantar)
    if (active) {
      if (active.has(n)) w *= 1.8;   // empujón suave a objetivos
      else w *= 0.75;  // leve freno a no-objetivos
    }
    return Math.max(0.001, w);
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) { r -= weights[i]; if (r <= 0) return candidates[i]; }
  return candidates[candidates.length - 1];
}

function nextRandom() {
  let candidates = eligibleNumbers();
  if (candidates.length === 0) candidates = range();

  // evita repetir el último
  const last = recent[recent.length - 1];
  candidates = candidates.filter(n => n !== last);

  return weightedPick(candidates);
}

// === Plan fuerte: garantiza que los elegidos ganen sí o sí ===
// Separa cada aparición forzada con entre gapMin..gapMax “ruidos” (null),
// baraja todas las unidades y limita el ratio ruido/forzado para que no se alargue.
function buildStealthQueueStrong(targets, gapMin = 1, gapMax = 4) {
  const units = []; // cada "unit" = [null,null,..., target]
  targets.forEach(t => {
    const faltan = Math.max(0, config.touchesToWin - (counts[t] || 0));
    for (let i = 0; i < faltan; i++) {
      const gaps = rand(gapMin, gapMax);
      const u = Array(gaps).fill(null); // ruido previo
      u.push(t); // la forzada
      units.push(u);
    }
  });

  // baraja unidades entre objetivos distintos
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [units[i], units[j]] = [units[j], units[i]];
  }

  // aplana
  let seq = units.flat();

  // añado un poquito de ruido final, pero con límite global:
  const forcedCount = units.length;                 // # de apariciones forzadas totales
  const maxNoise = forcedCount * (gapMax - 1);      // ratio ruido/forzado acotado
  const extraNoise = Math.min(maxNoise, rand(1, Math.max(2, gapMin + 1)));
  seq.push(...Array(extraNoise).fill(null));

  return seq;
}

// === Predicción para el panel ===
function prediction() {
  const list = [];
  for (let n = config.min; n <= config.max; n++) {
    const have = counts[n] || 0;
    const inStealth = stealthQueue.filter(x => x === n).length;
    const inPreset = presetQueue.filter(x => x === n).length;
    list.push({
      number: n,
      have,
      inQueue: inStealth + inPreset,
      remaining: Math.max(0, config.touchesToWin - (have + inStealth + inPreset)),
      isWinner: winners.includes(n)
    });
  }
  list.sort((a, b) => a.remaining - b.remaining || b.have - a.have);
  return { list, queue: [...presetQueue], winners: [...winners], config };
}

// === Core: sacar una bola ===
function drawOne() {
  if (!isRoundActive) isRoundActive = true;

  let next = null;

  // 1) Plan secreto (cola oculta) — consume en orden, saltando ganadores
  while (stealthQueue.length && next === null) {
    const tok = stealthQueue.shift();
    if (tok === null) {
      next = nextRandom();             // ruido natural
    } else if (!winners.includes(tok)) {
      next = tok;                      // forzada (si aún no es ganador)
    }
  }

  // 2) Cola visible del admin — también salta ganadores
  while (presetQueue.length && next === null) {
    const cand = presetQueue.shift();
    if (!winners.includes(cand)) next = cand;
  }

  // 3) Aleatorio natural
  if (next === null) next = nextRandom();

  const n = next;
  counts[n] = (counts[n] || 0) + 1;
  drawn.push(n);

  // mantener ventana anti-repetición
  recent.push(n);
  if (recent.length > RECENT_WINDOW) recent.shift();

  // ¿se convirtió en ganador?
  if (!winners.includes(n) && counts[n] >= config.touchesToWin) {
    winners.push(n);
    purgeQueuesOf(n); // fuera de todas las colas
  }

  const payload = { number: n, counts, drawn, winners, config, plannedWinners, stealthLeft: stealthQueue.length };
  io.emit('draw', payload);

  // cierre de ronda
  if (winners.length >= config.winnersPerRound) {
    isRoundActive = false;
    io.emit('round:over', { winners, config, plannedWinners });
  }
  return payload;
}

// ======= Auth =======
function signToken() { return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }); }
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
app.get('/api/state', (_req, res) => res.json({ config, counts, drawn, winners, isRoundActive }));

// ======= Rutas admin =======
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || 'admin')) {
    return res.status(401).json({ ok: false, error: 'Clave incorrecta' });
  }
  const token = signToken();
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  });
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
  const { numbers } = req.body;
  if (!Array.isArray(numbers)) return res.status(400).json({ ok: false, error: 'numbers debe ser Array' });
  const valid = numbers.every(n => Number.isInteger(n) && n >= config.min && n <= config.max);
  if (!valid) return res.status(400).json({ ok: false, error: 'Número fuera de rango' });
  presetQueue.push(...numbers.map(Number).filter(n => !winners.includes(n)));
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

app.post('/api/admin/makewin', authMiddleware, (req, res) => {
  const { number } = req.body;
  const n = Number(number);
  if (!Number.isInteger(n) || n < config.min || n > config.max) {
    return res.status(400).json({ ok: false, error: 'Número fuera de rango' });
  }
  if (winners.includes(n)) {
    return res.json({ ok: true, added: 0, note: 'Ya es ganador', presetQueue, prediction: prediction() });
  }
  const faltan = remainingToWin(n);
  if (faltan > 0) presetQueue.push(...Array(faltan).fill(n));
  res.json({ ok: true, added: faltan, presetQueue, prediction: prediction() });
});

// Plan secreto (fuerte)
app.post('/api/admin/plan', authMiddleware, (req, res) => {
  const { winners: ws = [], gapMin = 1, gapMax = 4 } = req.body;
  if (!Array.isArray(ws) || ws.length === 0) {
    return res.status(400).json({ ok: false, error: 'Envía winners como array (1–3 números)' });
  }
  const valid = ws.every(n => Number.isInteger(n) && n >= config.min && n <= config.max);
  if (!valid) return res.status(400).json({ ok: false, error: 'Número fuera de rango' });

  plannedWinners = Array.from(new Set(ws.map(Number))).slice(0, 3)
    .filter(n => !winners.includes(n)); // descarta los que ya ganaron

  stealthQueue = buildStealthQueueStrong(plannedWinners, gapMin, gapMax);
  res.json({ ok: true, plannedWinners, stealthLeft: stealthQueue.length, prediction: prediction() });
});

app.get('/api/admin/plan', authMiddleware, (_req, res) => {
  res.json({ ok: true, plannedWinners, stealthLeft: stealthQueue.length, prediction: prediction() });
});

app.post('/api/admin/plan/clear', authMiddleware, (_req, res) => {
  stealthQueue = []; plannedWinners = [];
  res.json({ ok: true, cleared: true, prediction: prediction() });
});

// ======= WS =======
io.on('connection', (socket) => {
  socket.emit('hydrate', { config, counts, drawn, winners });
  socket.on('public:draw', () => {
    const payload = drawOne();
    socket.emit('ack', payload);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT} (sirviendo ${PUBLIC_DIR})`));

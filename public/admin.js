const $ = (id) => document.getElementById(id);

const loginBox = $('login');
const panel = $('panel');
const toasts = $('toasts');

let ADMIN_TOKEN = localStorage.getItem('ADMIN_TOKEN') || null;
const socket = io();

// ---- mini toasts ----
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toasts.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2200);
  setTimeout(() => el.remove(), 2600);
}

// ---- fetch con Authorization siempre ----
async function authFetch(url, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  const token = ADMIN_TOKEN || localStorage.getItem('ADMIN_TOKEN');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { credentials: 'same-origin', ...options, headers });
}

// --------- Login ----------
$('btn-login').onclick = async () => {
  const password = $('pwd').value.trim();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (!data.ok) { toast('🔐 Clave incorrecta'); return; }

  ADMIN_TOKEN = data.token;
  localStorage.setItem('ADMIN_TOKEN', ADMIN_TOKEN);
  loginBox.style.display = 'none';
  panel.style.display = 'block';
  loadState();
};

// --------- Config principal ----------
$('btn-save').onclick = async () => {
  const max = Number($('range').value);
  const touchesToWin = Number($('touches').value);
  const winnersPerRound = Number($('winnersPerRound').value);

  const res = await authFetch('/api/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ min: 1, max, touchesToWin, winnersPerRound })
  });
  const data = await res.json();
  if (!data.ok) { toast(data.error || 'Error'); return; }

  toast('✅ Configuración guardada · Ronda reiniciada');
  loadState();
};

$('btn-reset').onclick = async () => {
  await authFetch('/api/admin/round/reset', { method: 'POST' });
  toast('🔁 Ronda reiniciada');
  loadState();
};

$('btn-draw').onclick = async () => {
  await authFetch('/api/admin/draw', { method: 'POST' });
  // no recargamos todo: pedimos solo la predicción fresca
  await refreshPrediction();
  toast('🎱 Bola forzada');
};

// --------- Cola próximas bolas ----------
$('btn-preset').onclick = async () => {
  const arr = $('preset').value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));

  if (!arr.length) { toast('Agrega al menos un número'); return; }

  const res = await authFetch('/api/admin/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numbers: arr })
  });
  const data = await res.json();
  if (!data.ok) { toast(data.error || 'Error'); return; }

  $('preset').value = '';
  renderQueue(data.presetQueue);
  renderPrediction(data.prediction);
};

// --------- Plan secreto ----------
$('btn-plan').onclick = async () => {
  const winnersStr = $('plan-winners').value.trim();
  if (!winnersStr) { toast('Pon 1 a 3 números separados por coma'); return; }

  const winners = winnersStr
    .split(',').map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));

  if (!winners.length) { toast('Pon números válidos'); return; }

  const [g1, g2] = $('plan-gap').value.split('-').map((x) => Number(x.trim()));
  const gapMin = Number.isFinite(g1) ? g1 : 1;
  const gapMax = Number.isFinite(g2) ? g2 : Math.max(gapMin, 4);

  const res = await authFetch('/api/admin/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners, gapMin, gapMax })
  });
  const data = await res.json();
  if (!data.ok) { toast(data.error || 'Error'); return; }

  renderPlan(data);
  renderPrediction(data.prediction);
  toast('🧠 Plan cargado');
};

$('btn-plan-clear').onclick = async () => {
  const res = await authFetch('/api/admin/plan/clear', { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    $('plan-current').textContent = '—';
    $('plan-left').textContent = '0';
    document.getElementById('pill-plan').style.display = 'none';
    toast('🧹 Plan cancelado');
    await refreshPrediction();
  }
};

// --------- Carga de estado ----------
async function loadState() {
  if (!ADMIN_TOKEN && !localStorage.getItem('ADMIN_TOKEN')) {
    loginBox.style.display = 'block';
    panel.style.display = 'none';
    return;
  }

  const res = await authFetch('/api/admin/config');
  if (res.status === 401) {
    toast('Sesión expirada. Vuelve a entrar.');
    localStorage.removeItem('ADMIN_TOKEN'); ADMIN_TOKEN = null;
    loginBox.style.display = 'block'; panel.style.display = 'none';
    return;
  }

  const data = await res.json();

  $('range').value = data.config.max;
  $('touches').value = data.config.touchesToWin;
  $('winnersPerRound').value = data.config.winnersPerRound ?? 3;

  // chips superiores
  $('pill-objetivo').textContent = `Gana: ${data.config.touchesToWin}`;
  $('pill-rango').textContent = `Rango: ${data.config.min}–${data.config.max}`;
  $('pill-ganadores').textContent = `Ganadores: ${data.winners.length}`;

  renderQueue(data.presetQueue);
  $('state').textContent = JSON.stringify(
    { config: data.config, counts: data.counts, drawn: data.drawn, winners: data.winners },
    null, 2
  );
  renderPrediction(data.prediction);

  try {
    const p = await (await authFetch('/api/admin/plan')).json();
    if (p.ok) renderPlan(p);
  } catch (_) { /* no-op */ }
}

async function refreshPrediction() {
  const res = await authFetch('/api/admin/config');
  if (!res.ok) return;
  const data = await res.json();
  $('pill-ganadores').textContent = `Ganadores: ${data.winners.length}`;
  renderQueue(data.presetQueue);
  renderPrediction(data.prediction);
}

// --------- Renders auxiliares ----------
function renderQueue(q) {
  $('queue').textContent = q && q.length ? q.join(', ') : '—';
}

function renderPrediction(p) {
  if (!p || !p.list) { $('predict').innerHTML = '—'; return; }
  const goal = p.config.touchesToWin;

  const rows = p.list.map((item) => {
    const have = item.have;
    const inQ = item.inQueue;
    const rem = Math.max(0, goal - (have + inQ));
    const isWin = item.isWinner;

    // porcentajes de barra (cap a 100)
    const pctHave = Math.min(100, (have / goal) * 100);
    const pctQ = Math.max(0, Math.min(100 - pctHave, (inQ / goal) * 100));

    const badge = isWin ? ' 🏆' : '';
    const btn = isWin ? '—' :
      `<button data-make="${item.number}" class="btn btn-ghost">Hacer ganar</button>`;

    return `
      <tr>
        <td><strong>${item.number}${badge}</strong></td>
        <td style="min-width:220px">
          <div class="bar">
            <span class="tiene" style="width:${pctHave}%"></span>
            <span class="cola"  style="width:${pctQ}%;"></span>
          </div>
          <small class="muted">${have} tiene · ${inQ} en cola</small>
        </td>
        <td class="tright">${rem}</td>
        <td>${btn}</td>
      </tr>`;
  }).join('');

  $('predict').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Número</th><th>Progreso</th><th class="tright">Faltan</th><th>Acción</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="small muted">La barra muestra <strong>tiene</strong> (verde) y <strong>en cola</strong> (ámbar) hacia el objetivo de ganar.</p>
    </div>`;

  $('predict').querySelectorAll('button[data-make]').forEach((btn) => {
    btn.onclick = async () => {
      const number = Number(btn.getAttribute('data-make'));
      const res = await authFetch('/api/admin/makewin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number })
      });
      const data = await res.json();
      if (!data.ok) { toast(data.error || 'Error'); return; }
      renderQueue(data.presetQueue);
      renderPrediction(data.prediction);
    };
  });
}

function renderPlan(data) {
  $('plan-current').textContent =
    data.plannedWinners && data.plannedWinners.length
      ? data.plannedWinners.join(', ')
      : '—';
  $('plan-left').textContent = data.stealthLeft ?? 0;
  document.getElementById('pill-plan').style.display =
    (data.plannedWinners && data.plannedWinners.length) || (data.stealthLeft > 0)
      ? 'inline-flex' : 'none';
}

// ---- WS: al sacar una bola desde sala, refrescamos predicción rápido ----
socket.on('draw', () => { refreshPrediction(); });
socket.on('round:reset', () => { loadState(); });
socket.on('round:over', () => { refreshPrediction(); });

// Arranque
if (ADMIN_TOKEN) { loginBox.style.display = 'none'; panel.style.display = 'block'; }
loadState();

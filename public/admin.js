const $ = (id) => document.getElementById(id);

const loginBox = $('login');
const panel = $('panel');
const toasts = document.getElementById('toasts');

function toast(msg) {
  if (!toasts) { alert(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
  }, 2200);
  setTimeout(() => el.remove(), 2600);
}

// -------- Auth ----------
$('btn-login').onclick = async () => {
  const password = $('pwd').value.trim();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (!data.ok) { toast('🔐 Clave incorrecta'); return; }
  loginBox.style.display = 'none';
  panel.style.display = 'block';
  loadState();
};

// -------- Config principal ----------
$('btn-save').onclick = async () => {
  const max = Number($('range').value);
  const touchesToWin = Number($('touches').value);
  const winnersPerRound = Number($('winnersPerRound').value);

  const res = await fetch('/api/admin/config', {
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
  await fetch('/api/admin/round/reset', { method: 'POST' });
  toast('🔁 Ronda reiniciada');
  loadState();
};

$('btn-draw').onclick = async () => {
  await fetch('/api/admin/draw', { method: 'POST' });
  toast('🎱 Bola forzada');
  loadState();
};

// -------- Cola de próximas bolas ----------
$('btn-preset').onclick = async () => {
  const arr = $('preset').value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));

  if (!arr.length) { toast('Agrega al menos un número'); return; }

  const res = await fetch('/api/admin/preset', {
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

// -------- Plan secreto ----------
$('btn-plan').onclick = async () => {
  const winnersStr = $('plan-winners').value.trim();
  if (!winnersStr) { toast('Pon 1 a 3 números separados por coma'); return; }

  const winners = winnersStr
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));

  if (!winners.length) { toast('Pon números válidos'); return; }

  const [g1, g2] = $('plan-gap').value.split('-').map((x) => Number(x.trim()));
  const gapMin = Number.isFinite(g1) ? g1 : 1;
  const gapMax = Number.isFinite(g2) ? g2 : Math.max(gapMin, 4);

  const res = await fetch('/api/admin/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners, gapMin, gapMax })
  });
  const data = await res.json();
  if (!data.ok) { toast(data.error || 'Error'); return; }

  renderPlan(data);
  renderPrediction(data.prediction);
};

// -------- Carga de estado ----------
async function loadState() {
  const res = await fetch('/api/admin/config');
  if (res.status === 401) {
    toast('Sesión expirada. Vuelve a entrar.');
    location.reload();
    return;
  }

  const data = await res.json();

  $('range').value = data.config.max;
  $('touches').value = data.config.touchesToWin;
  $('winnersPerRound').value = data.config.winnersPerRound ?? 3;

  renderQueue(data.presetQueue);
  $('state').textContent = JSON.stringify(
    {
      config: data.config,
      counts: data.counts,
      drawn: data.drawn,
      winners: data.winners
    },
    null,
    2
  );
  renderPrediction(data.prediction);

  try {
    const p = await (await fetch('/api/admin/plan')).json();
    if (p.ok) renderPlan(p);
  } catch (_) {
    // no-op
  }
}

// -------- Renders auxiliares ----------
function renderQueue(q) {
  $('queue').textContent = q && q.length ? q.join(', ') : '—';
}

function renderPrediction(p) {
  if (!p || !p.list) { $('predict').innerHTML = '—'; return; }

  const rows = p.list
    .map((item) => {
      const badge = item.isWinner ? ' (GANADOR)' : '';
      return `
        <tr>
          <td>${item.number}${badge}</td>
          <td>${item.have}</td>
          <td>${item.inQueue}</td>
          <td>${item.remaining}</td>
          <td>${item.remaining > 0
          ? `<button data-make="${item.number}" class="btn btn-ghost">Hacer ganar</button>`
          : '—'
        }</td>
        </tr>`;
    })
    .join('');

  $('predict').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Número</th><th>Tiene</th><th>En cola</th><th>Faltan</th><th>Acción</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  $('predict').querySelectorAll('button[data-make]').forEach((btn) => {
    btn.onclick = async () => {
      const number = Number(btn.getAttribute('data-make'));
      const res = await fetch('/api/admin/makewin', {
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
}

// Arranque
// (si no hay sesión, el backend devuelve 401 y se queda en login)
loadState();
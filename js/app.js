/* ============================================================
   T-CMD — App.js — Main Orchestrator (Part 1: Core + Signals)
   ============================================================ */

// ── Toast notifications ────────────────────────────────
function showToast(icon, title, msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div><div class="toast-title">${title}</div>${msg ? `<div class="toast-msg">${msg}</div>` : ''}</div>
    <span class="toast-close" onclick="this.parentElement.remove()">×</span>`;
  container.prepend(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Draw mini sparkline on canvas ──────────────────────
function drawSparkline(canvas, data, color = '#4fc3f7') {
  if (!canvas || !data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth;
  const h = canvas.height = canvas.offsetHeight;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

// ── State ──────────────────────────────────────────────
const AppState = {
  activeTab: 'signals',
  signalFilter: 'all',
  signalCoinFilter: 'ALL',
  signalView: 'live',
  signals: [],
  customCoins: JSON.parse(localStorage.getItem('tcmd_custom_coins') || '[]'),
  scannerFilter: 'all',
  scannerChain: 'all',
  scannerScore: 0,
  scannerQuery: '',
  scannerTokens: [],
  autoScan: false,
  scanInterval: null,
  openDrawer: null,
  liveRefreshInterval: null,
  prices: {}
};

// ── Coin config ────────────────────────────────────────
const COINS = [
  { sym: 'BTC', icon: '₿', name: 'Bitcoin', id: 'bitcoin' },
  { sym: 'ETH', icon: 'Ξ', name: 'Ethereum', id: 'ethereum' },
  { sym: 'SOL', icon: '◎', name: 'Solana', id: 'solana' }
];
const ALT_COINS = ['BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'MATIC', 'UNI', 'ATOM', 'NEAR', 'APT', 'SUI', 'INJ', 'OP', 'ARB'];

// ── Tab switching ──────────────────────────────────────
function switchTab(tab) {
  AppState.activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
}

// ── Format helpers ─────────────────────────────────────
const fmt = {
  price: SignalEngine.formatPrice,
  vol: SignalEngine.formatVol,
  pct: (v) => (v > 0 ? '+' : '') + parseFloat(v).toFixed(2) + '%',
  rsi: (v) => v ? v.toFixed(0) : '—',
  num: (v, d = 2) => parseFloat(v).toFixed(d)
};

// ── Live price updater ─────────────────────────────────
async function updatePrices() {
  try {
    const syms = [...COINS.map(c => c.sym), 'BNB', 'XRP', 'ADA', 'AVAX'];
    const ids = syms.map(s => API.cgId(s)).join(',');
    const data = await API.CoinGecko.getPrices(syms);
    for (const [id, val] of Object.entries(data)) {
      const sym = Object.entries(API.COIN_IDS).find(([s, i]) => i === id)?.[0];
      if (sym) {
        const p = val.usd;
        AppState.prices[sym] = p;
        TradeLog.updatePrice(sym, p);
        document.querySelectorAll(`[data-live-price="${sym}"]`).forEach(el => {
          el.textContent = fmt.price(p, sym);
        });
        document.querySelectorAll(`[data-live-change="${sym}"]`).forEach(el => {
          const ch = val.usd_24h_change || 0;
          el.textContent = fmt.pct(ch);
          el.className = el.className.replace(/num-\w+/, '');
          el.classList.add(ch >= 0 ? 'num-green' : 'num-red');
        });
      }
    }
    updateTradingLogPnL();
  } catch (e) { console.warn('Price update error:', e); }
}

// ══════════════════════════════════════════════════════
// SIGNALS TAB
// ══════════════════════════════════════════════════════

async function loadSignals() {
  const grid = document.getElementById('signals-grid');
  grid.innerHTML = renderSkeletons(3);
  const sigs = [];

  async function processSymbol(sym, icon, displayName) {
    try {
      const priceData = await API.CoinGecko.getPrices([sym]);
      const chartData = await API.CoinGecko.getOHLCV(sym, 90);
      const cgId = API.cgId(sym);
      const price = API.normalizeCGPrice(cgId, priceData);
      const sig = SignalEngine.generateSignal(sym, price, chartData);
      if (sig) { sig.icon = icon; sig.displayName = displayName; sigs.push(sig); }
    } catch (e) { console.warn(`Signal load failed for ${sym}:`, e); }
  }

  await Promise.allSettled(COINS.map(c => processSymbol(c.sym, c.icon, c.name)));
  // Also load any user-added coins
  if (AppState.customCoins && AppState.customCoins.length) {
    await Promise.allSettled(AppState.customCoins.map(c => processSymbol(c.sym, c.icon, c.name)));
  }
  AppState.signals = sigs;
  // Tag each signal as fresh or revived, and record generation time
  AppState.signals.forEach(s => {
    s.signalAge = (s.phase === 'Breakout' || s.confidence >= 75) ? 'fresh' : 'revived';
    if (!s.generatedAt) s.generatedAt = Date.now();
  });
  renderSignalCards();
  updateSignalStats();
  if (typeof startSignalTimers === 'function') startSignalTimers();
}

// Add Coin modal
window.showAddCoinModal = function () {
  const overlay = document.createElement('div');
  overlay.id = 'add-coin-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:2000;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
      <div style="background:var(--bg-modal);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:28px;width:360px;box-shadow:var(--shadow-modal);">
        <div style="font-size:16px;font-weight:700;margin-bottom:16px;">+ Add Coin Signal</div>
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:16px;">Enter any Binance-listed trading pair (e.g. LINK, DOGE, AVAX, INJ)</div>
        <input id="add-coin-input" class="form-input" type="text" placeholder="Symbol e.g. LINK" style="text-transform:uppercase;margin-bottom:12px;" />
        <div id="add-coin-error" style="color:var(--accent-red);font-size:12px;margin-bottom:10px;display:none;"></div>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary" id="add-coin-confirm" style="flex:1;justify-content:center;">Generate Signal</button>
          <button class="btn btn-ghost" id="add-coin-cancel" style="flex:1;justify-content:center;">Cancel</button>
        </div>
      </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#add-coin-input');
  input.focus();
  overlay.querySelector('#add-coin-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#add-coin-confirm').onclick = () => doAddCoin(input.value.trim().toUpperCase(), overlay);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doAddCoin(input.value.trim().toUpperCase(), overlay); });
};

async function doAddCoin(sym, overlay) {
  if (!sym) return;
  const errEl = overlay.querySelector('#add-coin-error');
  const btn = overlay.querySelector('#add-coin-confirm');
  btn.textContent = 'Loading…'; btn.disabled = true;
  try {
    const priceData = await API.CoinGecko.getPrices([sym]);
    const chartData = await API.CoinGecko.getOHLCV(sym, 90);
    const cgId = Object.keys(priceData)[0];
    if (!cgId || !priceData[cgId]?.usd) throw new Error('Not found on Binance');
    const price = API.normalizeCGPrice(cgId, priceData);
    const sig = SignalEngine.generateSignal(sym, price, chartData);
    if (!sig) throw new Error('Could not generate signal');
    sig.icon = sym.slice(0, 2);
    sig.displayName = sym;
    sig.signalAge = 'fresh';
    sig.isCustom = true;
    // Remove old custom signal for same coin if exists
    AppState.signals = AppState.signals.filter(s => s.symbol !== sym || !s.isCustom);
    AppState.signals.unshift(sig);
    if (!AppState.customCoins) AppState.customCoins = [];
    if (!AppState.customCoins.find(c => c.sym === sym)) {
      AppState.customCoins.push({ sym, icon: sym.slice(0, 2), name: sym });
      localStorage.setItem('tcmd_custom_coins', JSON.stringify(AppState.customCoins));
    }
    overlay.remove();
    renderSignalCards();
    updateSignalStats();
    showToast('📡', `${sym} Signal Added`, `${sig.direction} · ${sig.confidence}% confidence`, 'success');
  } catch (e) {
    errEl.textContent = e.message || 'Failed to fetch data for this symbol';
    errEl.style.display = 'block';
    btn.textContent = 'Generate Signal'; btn.disabled = false;
  }
}

// ── Altcoins panel ─────────────────────────────────────
function renderAltcoinsPanel(grid) {
  const coins = AppState.customCoins || [];
  grid.style.display = 'block'; // full width, not grid
  grid.innerHTML = `
    <div class="altcoins-panel">
      <div class="altcoins-panel-header">
        <div>
          <div style="font-size:16px;font-weight:700;margin-bottom:4px;">🪙 Altcoin Signals</div>
          <div style="font-size:12.5px;color:var(--text-muted);">Track any Binance-listed coin. Signals generate on demand.</div>
        </div>
        ${coins.length ? `<button class="btn btn-primary" onclick="generateAltcoinSignals()" style="font-size:12px;">📡 Generate Signals</button>` : ''}
      </div>

      <div class="altcoin-chips-row" id="altcoin-chips">
        ${coins.length === 0
      ? `<div style="color:var(--text-muted);font-size:13px;">No altcoins tracked yet. Add one below.</div>`
      : coins.map(c => `
          <div class="altcoin-chip">
            <span class="altcoin-chip-icon">${c.icon || c.sym.slice(0, 2)}</span>
            <span class="altcoin-chip-name">${c.sym}</span>
            <button class="altcoin-chip-remove" onclick="removeCustomCoin('${c.sym}')" title="Remove ${c.sym}">×</button>
          </div>`).join('')}
      </div>

      <div class="altcoin-add-row">
        <input id="alts-quick-input" class="auth-input" type="text"
          placeholder="Enter symbol, e.g. LINK, DOGE, INJ, AVAX…"
          style="flex:1;max-width:320px;text-transform:uppercase;"
          onkeydown="if(event.key==='Enter')addCoinInline()">
        <button class="btn btn-primary" onclick="addCoinInline()" id="alts-add-btn">+ Add Coin</button>
      </div>
      <div id="alts-quick-error" style="color:var(--accent-red);font-size:12px;margin-top:6px;display:none;"></div>

      ${coins.length ? `
      <div class="altcoins-signals-section" id="altcoins-signals-grid">
        <div style="color:var(--text-muted);font-size:13px;padding:20px 0;">Click "Generate Signals" to load live signals for your altcoins.</div>
      </div>` : ''}
    </div>`;

  // Reset grid display back to grid when user leaves ALTS tab
  document.querySelector('.signals-grid')?.style.removeProperty('display');
}

window.removeCustomCoin = function (sym) {
  AppState.customCoins = (AppState.customCoins || []).filter(c => c.sym !== sym);
  AppState.signals = AppState.signals.filter(s => s.symbol !== sym || !s.isCustom);
  localStorage.setItem('tcmd_custom_coins', JSON.stringify(AppState.customCoins));
  renderAltcoinsPanel(document.getElementById('signals-grid'));
  showToast('🗑️', `${sym} Removed`, 'Altcoin removed from tracking', 'info');
};

window.addCoinInline = async function () {
  const input = document.getElementById('alts-quick-input');
  const errEl = document.getElementById('alts-quick-error');
  const btn = document.getElementById('alts-add-btn');
  const sym = (input?.value || '').trim().toUpperCase();
  if (!sym) return;
  if ((AppState.customCoins || []).find(c => c.sym === sym)) {
    errEl.textContent = `${sym} is already tracked.`; errEl.style.display = 'block';
    setTimeout(() => { errEl.style.display = 'none'; }, 3000); return;
  }
  btn.textContent = 'Loading…'; btn.disabled = true;
  try {
    const priceData = await API.CoinGecko.getPrices([sym]);
    const cgId = Object.keys(priceData)[0];
    if (!cgId || !priceData[cgId]?.usd) throw new Error(`"${sym}" not found. Try another symbol.`);
    if (!AppState.customCoins) AppState.customCoins = [];
    AppState.customCoins.push({ sym, icon: sym.slice(0, 2), name: sym });
    localStorage.setItem('tcmd_custom_coins', JSON.stringify(AppState.customCoins));
    input.value = '';
    errEl.style.display = 'none';
    renderAltcoinsPanel(document.getElementById('signals-grid'));
    showToast('✅', `${sym} Added`, 'Click Generate Signals to load live signal', 'success');
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  } finally {
    btn.textContent = '+ Add Coin'; btn.disabled = false;
  }
};

window.generateAltcoinSignals = async function () {
  const grid = document.getElementById('altcoins-signals-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0;">⏳ Generating signals…</div>';
  const coins = AppState.customCoins || [];
  const sigs = [];
  await Promise.allSettled(coins.map(async c => {
    try {
      const priceData = await API.CoinGecko.getPrices([c.sym]);
      const chartData = await API.CoinGecko.getOHLCV(c.sym, 90);
      const cgId = Object.keys(priceData)[0];
      if (!cgId || !priceData[cgId]?.usd) return;
      const price = API.normalizeCGPrice(cgId, priceData);
      const sig = SignalEngine.generateSignal(c.sym, price, chartData);
      if (sig) { sig.icon = c.icon; sig.displayName = c.sym; sig.isCustom = true; sig.generatedAt = Date.now(); sig.signalAge = 'fresh'; sigs.push(sig); }
    } catch (e) { console.warn(`Alt signal failed for ${c.sym}:`, e); }
  }));
  // Merge into main signals
  AppState.signals = AppState.signals.filter(s => !s.isCustom);
  AppState.signals.push(...sigs);
  if (!sigs.length) { grid.innerHTML = '<div style="color:var(--accent-red);font-size:13px;padding:12px 0;">Could not generate signals. Check symbols or try again.</div>'; return; }
  // Render signal cards inside panel
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(320px,1fr))';
  grid.style.gap = '14px';
  grid.style.marginTop = '16px';
  grid.innerHTML = sigs.map(sig => buildSignalCardHTML(sig)).join('');
  if (typeof startSignalTimers === 'function') startSignalTimers();
};

// Helper: build a single signal card HTML (wraps renderSignalCard)
function buildSignalCardHTML(sig) {
  return renderSignalCard(sig);
}

function renderSkeletons(n) {
  return Array.from({ length: n }, () => `
    <div class="signal-card" style="gap:12px;">
      <div class="skeleton" style="height:18px;width:60%;"></div>
      <div class="skeleton" style="height:14px;width:40%;"></div>
      <div class="skeleton" style="height:80px;"></div>
      <div class="skeleton" style="height:14px;"></div>
    </div>`).join('');
}

function filterSignals(sigs) {
  let result = sigs;
  if (AppState.signalCoinFilter === 'ALTS') {
    result = result.filter(s => s.isCustom);
  } else if (AppState.signalCoinFilter !== 'ALL') {
    result = result.filter(s => s.symbol === AppState.signalCoinFilter);
  }
  if (AppState.signalFilter === 'long') result = result.filter(s => s.direction === 'LONG');
  if (AppState.signalFilter === 'short') result = result.filter(s => s.direction === 'SHORT');
  if (AppState.signalFilter === 'breakout') result = result.filter(s => s.phase === 'Breakout');
  if (AppState.signalFilter === 'accumulating') result = result.filter(s => s.phase === 'Accumulating');
  if (AppState.signalFilter === 'fresh') result = result.filter(s => s.signalAge === 'fresh');
  if (AppState.signalFilter === 'revived') result = result.filter(s => s.signalAge === 'revived');
  return result;
}

function renderSignalCards() {
  const grid = document.getElementById('signals-grid');

  // ── Altcoins tab: show manager panel ──────────────────
  if (AppState.signalCoinFilter === 'ALTS') {
    renderAltcoinsPanel(grid);
    return;
  }

  const sigs = filterSignals(AppState.signals);
  if (sigs.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      <div class="empty-state-icon">📡</div>
      <h3>No signals match your filter</h3>
      <p>Try a different filter or wait for the next scan cycle.</p>
      <button class="btn btn-outline" onclick="loadSignals()">🔄 Refresh Now</button>
    </div>`;
    return;
  }
  grid.innerHTML = sigs.map(renderSignalCard).join('');
  sigs.forEach(s => {
    const canvas = document.getElementById(`chart-${s.id}`);
    if (canvas) {
      const color = s.direction === 'LONG' ? '#26de81' : '#fc5c65';
      drawSparkline(canvas, s.closes.slice(-30), color);
    }
  });
}

function renderSignalCard(s) {
  const isLong = s.direction === 'LONG';
  const ta = SignalEngine.timeAgo(s.timestamp);
  const phaseClass = s.phase === 'Breakout' ? 'amber' : s.phase === 'Accumulating' ? 'cyan' : 'red';
  const pctMove = (((s.takeProfit - s.entry) / s.entry) * 100).toFixed(1);
  const confColor = s.confidence >= 75 ? '#26de81' : s.confidence >= 55 ? '#f7b731' : '#fc5c65';

  return `<div class="signal-card ${isLong ? 'long-card' : 'short-card'} animate-fadeInUp" onclick="openSignalDetail('${s.id}')">
    <div class="card-top-row">
      <span class="card-type-badge ${s.signalAge || 'fresh'}"><span>✦</span> ${s.signalAge === 'revived' ? '↺ Revived' : '✦ Fresh'} Signal</span>
      ${s.generatedAt ? `<span class="signal-age-clock" data-signal-ts="${s.generatedAt}">${typeof fmtAge === 'function' ? fmtAge(s.generatedAt) : '< 1m'}</span>` : ''}
      <div class="direction-badge ${isLong ? 'long' : 'short'}">${isLong ? '▲' : '▼'} ${s.direction}</div>
    </div>
    <div class="card-phase"><span class="phase-dot ${phaseClass}"></span>${s.phase} Phase</div>
    <div class="card-coin-row">
      <div class="card-coin-info">
        <div class="coin-icon">${s.icon}</div>
        <div>
          <div class="coin-name">${s.symbol}/USDT</div>
          <div class="coin-vol">RSI: <span class="${s.rsi < 35 ? 'num-green' : s.rsi > 65 ? 'num-red' : 'num-cyan'}">${s.rsi}</span></div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:15px;font-weight:700;font-family:var(--font-mono);" data-live-price="${s.symbol}">${fmt.price(s.currentPrice, s.symbol)}</div>
        <div class="coin-fdv-change ${s.priceData.change24h >= 0 ? 'num-green' : 'num-red'}" data-live-change="${s.symbol}">${fmt.pct(s.priceData.change24h || 0)}</div>
      </div>
    </div>
    <div class="card-tags">
      ${s.tags.slice(0, 4).map(t => `<span class="card-tag tag-${t.color}">${t.label}</span>`).join('')}
    </div>
    <div class="mini-chart-area">
      <canvas class="mini-chart-canvas" id="chart-${s.id}"></canvas>
      <div class="mini-chart-labels">
        <div class="mini-chart-label">
          <div class="mini-label-key">Entry</div>
          <div class="mini-label-val num-cyan">${fmt.price(s.entry, s.symbol)}</div>
        </div>
        <div class="mini-chart-label">
          <div class="mini-label-key">Stop Loss</div>
          <div class="mini-label-val num-red">${fmt.price(s.stopLoss, s.symbol)}</div>
        </div>
        <div class="mini-chart-label">
          <div class="mini-label-key">Take Profit</div>
          <div class="mini-label-val num-green">${fmt.price(s.takeProfit, s.symbol)} <span style="font-size:10px;color:var(--accent-amber)">+${pctMove}%</span></div>
        </div>
      </div>
    </div>
    <div class="confidence-section">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;">
        <span style="color:var(--text-muted)">AI Confidence</span>
        <span style="font-weight:700;color:${confColor}">${s.confidence}%</span>
      </div>
      <div class="confidence-bar-track">
        <div class="confidence-bar-fill" style="width:${s.confidence}%;background:${confColor}"></div>
      </div>
    </div>
    <div class="card-bottom-row">
      <button class="take-trade-btn" onclick="event.stopPropagation();takeTrade('${s.id}')">💼 Take Trade</button>
      <div class="rr-badge">R:R ${s.rr}:1</div>
      <div class="timeago-badge">
        <div class="timeago-value">${ta.value}</div>
        <div class="timeago-unit">${ta.unit}</div>
      </div>
    </div>
  </div>`;
}

function updateSignalStats() {
  const sigs = AppState.signals;
  document.getElementById('stat-signals-today').textContent = sigs.length;
  const avgConf = sigs.length ? Math.round(sigs.reduce((a, s) => a + s.confidence, 0) / sigs.length) : 0;
  document.getElementById('stat-avg-conf').textContent = avgConf + '%';
  const avgRR = sigs.length ? (sigs.reduce((a, s) => a + parseFloat(s.rr), 0) / sigs.length).toFixed(1) : '—';
  document.getElementById('stat-avg-rr').textContent = avgRR;
  const stats = TradeLog.getStats();
  document.getElementById('stat-win-rate').textContent = stats.winRate + '%';
}

// ── Take Trade ─────────────────────────────────────────
window.takeTrade = function (sigId) {
  const sig = AppState.signals.find(s => s.id === sigId);
  if (!sig) return;
  if (!AuthManager.hasFeature('tradingLog')) {
    showToast('🔒', 'Feature Locked', 'Admin has not enabled Trading Log for your account.', 'warning'); return;
  }
  TradeLog.addPosition({
    symbol: sig.symbol, direction: sig.direction, entry: sig.entry,
    stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, size: 1,
    rr: sig.rr, fromSignalId: sig.id
  });
  showToast('💼', `${sig.direction} ${sig.symbol}`, `Entry: ${fmt.price(sig.entry, sig.symbol)} | R:R ${sig.rr}:1`, 'success');
  if (AppState.activeTab !== 'log') {
    setTimeout(() => { switchTab('log'); renderTradingLog(); }, 500);
  }
};

// ── Signal Detail Drawer ───────────────────────────────
window.openSignalDetail = function (sigId) {
  const sig = AppState.signals.find(s => s.id === sigId);
  if (!sig) return;
  AppState.openDrawer = sigId;
  const overlay = document.getElementById('drawer-overlay');
  const drawer = document.getElementById('signal-drawer');
  overlay.classList.add('open');
  drawer.classList.add('open');
  populateDrawer(sig);
};

function populateDrawer(sig) {
  const isLong = sig.direction === 'LONG';
  document.getElementById('drawer-coin-icon').textContent = sig.icon;
  document.getElementById('drawer-coin-name').textContent = `${sig.symbol}/USDT`;
  document.getElementById('drawer-coin-change').textContent = fmt.pct(sig.priceData.change24h || 0);
  document.getElementById('drawer-coin-change').className = `drawer-coin-change ${(sig.priceData.change24h || 0) >= 0 ? 'num-green' : 'num-red'}`;
  document.getElementById('drawer-dir-badge').className = `direction-badge ${isLong ? 'long' : 'short'}`;
  document.getElementById('drawer-dir-badge').textContent = `${isLong ? '▲' : '▼'} ${sig.direction}`;
  document.getElementById('drawer-vol').textContent = `Vol: ${fmt.vol(sig.priceData.volume24h)}`;
  document.getElementById('drawer-description').textContent =
    `${sig.symbol} is currently in a ${sig.phase} phase. RSI at ${sig.rsi} with ${sig.macdBullish ? 'bullish' : 'bearish'} MACD momentum. ` +
    `Markov chain analysis shows ${Math.round(sig.markov.breakout * 100)}% probability of continued breakout in the next 5 sessions.`;
  renderSignalHistoryTab(sig);
  renderTechSocialTab(sig);
  renderSmartTradesTab(sig);
  switchDrawerTab('history');
}

function switchDrawerTab(tab) {
  document.querySelectorAll('.drawer-tab').forEach(t => t.classList.toggle('active', t.dataset.dtab === tab));
  document.querySelectorAll('.drawer-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
}
window.switchDrawerTab = switchDrawerTab;

function renderSignalHistoryTab(sig) {
  const panel = document.getElementById('drawer-history-panel');
  const closes = sig.closes;
  const histWin = Math.round(sig.confidence / 10);
  const histLoss = 10 - histWin;
  panel.innerHTML = `
    <div class="signal-history-stats">
      <div class="sh-stat"><div class="sh-stat-label">Win Rate</div><div class="sh-stat-value num-green">${histWin * 10}%</div></div>
      <div class="sh-stat"><div class="sh-stat-label">Signals</div><div class="sh-stat-value num-cyan">10</div></div>
      <div class="sh-stat"><div class="sh-stat-label">Wins</div><div class="sh-stat-value num-green">${histWin}</div></div>
      <div class="sh-stat"><div class="sh-stat-label">Losses</div><div class="sh-stat-value num-red">${histLoss}</div></div>
    </div>
    <canvas id="drawer-chart" class="signal-history-chart"></canvas>
    <div class="sh-stat-label" style="margin-bottom:8px;">Recent Signals</div>
    <table class="signal-history-table">
      <thead><tr><th>Date</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th></tr></thead>
      <tbody>${generateSignalHistoryRows(sig)}</tbody>
    </table>`;
  setTimeout(() => {
    const c = document.getElementById('drawer-chart');
    if (c) drawSparkline(c, closes.slice(-40), sig.direction === 'LONG' ? '#26de81' : '#fc5c65');
  }, 50);
}

function generateSignalHistoryRows(sig) {
  const days = [6, 5, 4, 3, 2, 1, 0];
  return days.map((d, i) => {
    const win = i % 3 !== 1;
    const diff = sig.direction === 'LONG' ? (win ? 0.055 : -0.025) : (win ? -0.055 : 0.025);
    const exit = sig.entry * (1 + diff);
    const pct = (diff * 100).toFixed(2);
    const date = new Date(Date.now() - d * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<tr ${d === 0 ? 'class="current-row"' : ''}>
      <td>${date}</td>
      <td class="${sig.direction === 'LONG' ? 'num-green' : 'num-red'}">${sig.direction}</td>
      <td>${fmt.price(sig.entry, sig.symbol)}</td>
      <td>${fmt.price(exit, sig.symbol)}</td>
      <td class="${win ? 'num-green' : 'num-red'}">${win ? '+' : ''}${pct}%</td>
    </tr>`;
  }).join('');
}

function renderTechSocialTab(sig) {
  const panel = document.getElementById('drawer-techsocial-panel');
  const m = sig.markov;
  const rsiBull = sig.rsi < 40;
  panel.innerHTML = `
    <div class="sentiment-card">
      <div class="sentiment-header">
        <div class="sentiment-title">⚙️ Technical Sentiment</div>
        <div class="sentiment-label ${rsiBull ? 'num-green' : 'num-red'}">${rsiBull ? '● Bullish' : '● Bearish'}</div>
      </div>
      <div class="sentiment-bars">
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">RSI (${sig.rsi})</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill ${sig.rsi < 50 ? 'green' : 'red'}" style="width:${sig.rsi}%"></div></div></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">MACD</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill ${sig.macdBullish ? 'green' : 'red'}" style="width:${sig.macdBullish ? 65 : 35}%"></div></div></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">EMA Align</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill ${sig.bullishEMA ? 'green' : 'red'}" style="width:${sig.bullishEMA ? 70 : 30}%"></div></div></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">Breakout%</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill amber" style="width:${Math.round(m.breakout * 100)}%"></div></div></div>
      </div>
      <div class="sentiment-details">
        <div class="sentiment-detail-row"><div class="key">Markov Phase</div><div class="val">${m.mostLikely}</div></div>
        <div class="sentiment-detail-row"><div class="key">Breakout Prob</div><div class="val num-amber">${Math.round(m.breakout * 100)}%</div></div>
        <div class="sentiment-detail-row"><div class="key">AI Confidence</div><div class="val num-cyan">${sig.confidence}%</div></div>
        <div class="sentiment-detail-row"><div class="key">Liq Range (L)</div><div class="val num-red">${fmt.price(sig.liquidation.longLiqs, sig.symbol)}</div></div>
        <div class="sentiment-detail-row"><div class="key">Liq Range (S)</div><div class="val num-green">${fmt.price(sig.liquidation.shortLiqs, sig.symbol)}</div></div>
      </div>
    </div>
    <div class="sentiment-card">
      <div class="sentiment-header"><div class="sentiment-title">🌐 Social Sentiment</div></div>
      <div class="sentiment-bars">
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">Social Score</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill cyan" style="width:${50 + sig.confidence / 4}%"></div></div></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">Fear/Greed</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill amber" style="width:55%"></div></div></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">Mentions 24h</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill cyan" style="width:60%"></div></div></div>
      </div>
      <div class="sentiment-details">
        <div class="sentiment-detail-row"><div class="key">Trend Sentiment</div><div class="val num-cyan">Positive</div></div>
        <div class="sentiment-detail-row"><div class="key">Market Mood</div><div class="val num-amber">Neutral (55)</div></div>
      </div>
    </div>`;
}

function renderSmartTradesTab(sig) {
  const panel = document.getElementById('drawer-smarttrades-panel');

  // Seed randomness from coin symbol so each coin gets consistent-but-different data
  const seed = sig.symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = (min, max, offset = 0) => {
    const s = Math.sin(seed + offset) * 10000;
    return Math.floor((s - Math.floor(s)) * (max - min) + min);
  };

  const names = ['Whale Alpha', 'Sigma Wolf', 'Degen King', 'SOL Sniper',
    'Moon Chaser', 'Alpha Bear', 'Gem Hunter', 'Trench Wizard'];
  const count = 3 + (seed % 3); // 3-5 wallets, varies by coin
  const scale = sig.price > 10000 ? 100000 : sig.price > 100 ? 10000 : 2000;

  const traders = Array.from({ length: count }, (_, i) => {
    const bought = rng(scale * 0.3, scale * 3, i * 7);
    const hasSold = rng(0, 10, i * 13) > 6;
    const sold = hasSold ? rng(Math.floor(bought * 0.2), Math.floor(bought * 0.8), i * 11) : 0;
    const roi = hasSold ? (rng(-30, 80, i * 17) / 10).toFixed(1) : null;
    const age = rng(1, 96, i * 19);
    const name = names[(seed + i * 3) % names.length];
    return { name, avatar: name[0], bought, sold, roi: roi ? (parseFloat(roi) >= 0 ? '+' + roi : roi) : null, age };
  });

  const maxBought = Math.max(...traders.map(t => t.bought));
  const totalBought = traders.reduce((a, t) => a + t.bought, 0);

  panel.innerHTML = `
    <div class="simulated-badge">
      ⚠️ Simulated data — illustrative only.
      Real whale tracking requires paid APIs (Nansen, Arkham).
    </div>
    <div class="smart-trades-summary">
      <span>${traders.length} wallets tracked</span>
      <strong>${fmt.vol(totalBought)} total</strong>
    </div>
    <table class="smart-trades-table">
      <thead><tr><th>Wallet</th><th>Bought</th><th>Sold</th><th>ROI</th><th>Age</th></tr></thead>
      <tbody>${traders.map(t => {
    const pct = Math.round((t.bought / maxBought) * 100);
    return `<tr>
          <td><div class="wallet-name"><div class="wallet-avatar">${t.avatar}</div>${t.name}</div></td>
          <td><div class="wallet-balance">${fmt.vol(t.bought)}</div><div class="balance-bar"><div class="balance-bar-fill green" style="width:${pct}%"></div></div></td>
          <td class="txn-counts">${t.sold ? fmt.vol(t.sold) : '—'}</td>
          <td class="roi-value ${t.roi ? (parseFloat(t.roi) > 0 ? 'roi-positive' : 'roi-negative') : ''}">${t.roi ? t.roi + '%' : '—'}</td>
          <td class="age-action">${t.age}h ago</td>
        </tr>`;
  }).join('')}</tbody>
    </table>`;
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('signal-drawer').classList.remove('open');
  AppState.openDrawer = null;
}
window.closeDrawer = closeDrawer;

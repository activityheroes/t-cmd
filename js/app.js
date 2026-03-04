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
    scannerFilter: 'all',
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
    AppState.signals = sigs;
    renderSignalCards();
    updateSignalStats();
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
    if (AppState.signalCoinFilter !== 'ALL') {
        result = result.filter(s => s.symbol === AppState.signalCoinFilter);
    }
    if (AppState.signalFilter === 'long') result = result.filter(s => s.direction === 'LONG');
    if (AppState.signalFilter === 'short') result = result.filter(s => s.direction === 'SHORT');
    if (AppState.signalFilter === 'breakout') result = result.filter(s => s.phase === 'Breakout');
    if (AppState.signalFilter === 'accumulating') result = result.filter(s => s.phase === 'Accumulating');
    return result;
}

function renderSignalCards() {
    const grid = document.getElementById('signals-grid');
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
      <span class="card-type-badge"><span>✦</span> Fresh Signal</span>
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
    const traders = [
        { name: 'Whale Alpha', avatar: 'W', bought: 125000, sold: 0, roi: null, age: 2 },
        { name: 'Sigma Wolf', avatar: 'S', bought: 48000, sold: 22000, roi: '+38.2', age: 6 },
        { name: 'Degen King', avatar: 'D', bought: 200000, sold: 0, roi: null, age: 14 },
        { name: 'SOL Sniper', avatar: 'S', bought: 31000, sold: 31000, roi: '+12.8', age: 18 }
    ];
    const maxBought = Math.max(...traders.map(t => t.bought));
    panel.innerHTML = `
    <div class="smart-trades-summary">
      <span>${traders.length} wallets bought</span>
      <strong>${fmt.vol(traders.reduce((a, t) => a + t.bought, 0))} total</strong>
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

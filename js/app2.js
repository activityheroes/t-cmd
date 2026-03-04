/* ============================================================
   T-CMD — App.js Part 2: Scanner + Trading Log + App.init
   ============================================================ */

// ══════════════════════════════════════════════════════
// TRADING TERMINAL LINK HELPERS
// ══════════════════════════════════════════════════════

function getTerminalLinks(token) {
  const addr = token.address || '';
  const chain = (token.chainId || 'solana').toLowerCase();
  const isSol = chain.includes('sol');
  const isEth = chain.includes('eth') || chain.includes('erc');
  const isBase = chain.includes('base');
  const isBsc = chain.includes('bsc') || chain.includes('bnb');

  return {
    axiom: isSol ? `https://axiom.trade/meme/${addr}` : null,
    gmgn: isSol ? `https://gmgn.ai/sol/token/${addr}`
      : isEth ? `https://gmgn.ai/eth/token/${addr}`
        : isBase ? `https://gmgn.ai/base/token/${addr}`
          : isBsc ? `https://gmgn.ai/bsc/token/${addr}` : null,
    padre: isSol ? `https://trade.padre.gg/${addr}` : null,
    bubbleMaps: isSol ? `https://app.bubblemaps.io/sol/token/${addr}`
      : isEth ? `https://app.bubblemaps.io/eth/token/${addr}`
        : isBase ? `https://app.bubblemaps.io/base/token/${addr}`
          : isBsc ? `https://app.bubblemaps.io/bsc/token/${addr}` : null,
    explorer: isSol ? `https://solscan.io/token/${addr}`
      : isEth ? `https://etherscan.io/token/${addr}`
        : isBase ? `https://basescan.org/token/${addr}`
          : isBsc ? `https://bscscan.com/token/${addr}` : `https://solscan.io/token/${addr}`,
    walletExplorer: (wallet) => isSol ? `https://solscan.io/account/${wallet}`
      : isEth ? `https://etherscan.io/address/${wallet}`
        : isBase ? `https://basescan.org/address/${wallet}`
          : isBsc ? `https://bscscan.com/address/${wallet}` : `https://solscan.io/account/${wallet}`,
    kolscan: isSol ? `https://kolscan.io/` : null
  };
}

// ── Signal age timer ───────────────────────────────────────────
function fmtAge(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return '< 1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

let _timerInterval = null;
function startSignalTimers() {
  if (_timerInterval) clearInterval(_timerInterval);
  _timerInterval = setInterval(() => {
    document.querySelectorAll('[data-signal-ts]').forEach(el => {
      el.textContent = fmtAge(parseInt(el.dataset.signalTs));
    });
  }, 30000);
}

// ══════════════════════════════════════════════════════
// SCANNER TAB
// ══════════════════════════════════════════════════════

async function loadScanner() {
  const grid = document.getElementById('scanner-grid');
  grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-secondary);">
    <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
    <div>Scanning DexScreener for trending memecoins...</div>
  </div>`;
  try {
    const tokens = await Scanner.fetchAndScore();
    AppState.scannerTokens = tokens;
    renderScannerCards();
    updateScannerStats();
    startSignalTimers();
    showToast('🔍', 'Scan Complete', `Found ${tokens.length} tokens`, 'success');
  } catch (e) {
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">
      <div class="empty-state-icon">⚠️</div>
      <h3>Scan Failed</h3><p>Could not reach DexScreener API. Check your connection.</p>
      <button class="btn btn-outline" onclick="loadScanner()">↺ Retry</button>
    </div>`;
  }
}

function filterScannerTokens(tokens) {
  let t = tokens;
  // Type filter
  if (AppState.scannerFilter === 'hot') t = t.filter(x => x.pumpScore >= 70);
  if (AppState.scannerFilter === 'breakout') t = t.filter(x => x.isBreakout);
  if (AppState.scannerFilter === 'accumulating') t = t.filter(x => !x.isBreakout && x.pumpScore >= 50);
  if (AppState.scannerFilter === 'risk') t = t.filter(x => x.rugFlags.length >= 2);
  if (AppState.scannerFilter === 'fresh') t = t.filter(x => x.signalType === 'fresh');
  if (AppState.scannerFilter === 'revived') t = t.filter(x => x.signalType === 'revived');
  // Chain filter
  if (AppState.scannerChain && AppState.scannerChain !== 'all') {
    t = t.filter(x => (x.chainId || '').toLowerCase().includes(AppState.scannerChain));
  }
  // Score filter
  if (AppState.scannerScore && AppState.scannerScore > 0) {
    t = t.filter(x => x.pumpScore >= AppState.scannerScore);
  }
  // Text search
  const q = AppState.scannerQuery || '';
  if (q) t = t.filter(x => x.name.toLowerCase().includes(q) || x.symbol.toLowerCase().includes(q) || x.address.toLowerCase().includes(q));
  return t;
}

function renderScannerCards() {
  const grid = document.getElementById('scanner-grid');
  const tokens = filterScannerTokens(AppState.scannerTokens);
  if (!tokens.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">
      <div class="empty-state-icon">🔍</div>
      <h3>No tokens found</h3><p>Adjust filters or run a fresh scan.</p>
      <button class="btn btn-outline" onclick="loadScanner()">🔍 Scan Now</button>
    </div>`;
    return;
  }
  grid.innerHTML = tokens.map(renderScannerCard).join('');
}

function renderScannerCard(token) {
  const scoreClass = token.pumpScore >= 70 ? 'high' : token.pumpScore >= 45 ? 'medium' : 'low';
  const ch24 = token.priceChange.h24;
  const sig = token.memeSignal; // may be undefined for low-score tokens

  const logoHtml = token.imageUrl
    ? `<img src="${token.imageUrl}" class="token-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <div class="coin-icon" style="font-weight:700;font-size:11px;display:none;">${token.symbol.slice(0, 3)}</div>`
    : `<div class="coin-icon" style="font-weight:700;font-size:11px;">${token.symbol.slice(0, 3)}</div>`;

  const chainBadge = `<span class="chain-badge chain-${(token.chainId || 'sol').toLowerCase().slice(0, 3)}">${token.chainId}</span>`;

  const terminals = getTerminalLinks(token);

  return `<div class="signal-card ${token.isBreakout ? 'long-card' : token.pumpScore >= 50 && !token.isBreakout ? 'accum-card' : ''} animate-fadeInUp" onclick="openScannerDetail('${token.address}')">
    <div class="card-top-row">
      <span class="card-type-badge ${token.signalType}">${token.signalType === 'fresh' ? '\u2726 Fresh' : '\u21ba Revived'}</span>
      <span class="signal-age-clock" data-signal-ts="${token.scannedAt || Date.now()}">${fmtAge(token.scannedAt || Date.now())}</span>
      <div class="pump-score ${scoreClass}">
        <div class="pump-score-value">${token.pumpScore}</div>
        <div class="pump-score-label">Score</div>
      </div>
    </div>
    <div class="card-coin-row">
      <div class="card-coin-info">
        <div style="position:relative;flex-shrink:0;">${logoHtml}</div>
        <div>
          <div class="coin-name">${token.name} ${chainBadge}</div>
          <div class="coin-vol" style="font-size:11px;">${token.symbol} · Vol: ${fmt.vol(token.volume.h1)}/h</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:13px;font-weight:700;font-family:var(--font-mono);">${fmt.price(token.priceUSD)}</div>
        <div class="${ch24 >= 0 ? 'num-green' : 'num-red'}" style="font-size:11.5px;font-weight:600;">${fmt.pct(ch24)}</div>
      </div>
    </div>
    <div style="display:flex;gap:12px;font-size:11.5px;flex-wrap:wrap;">
      <span style="color:var(--text-muted)">Vol 24h: <span class="num-cyan">${fmt.vol(token.volume.h24)}</span></span>
      <span style="color:var(--text-muted)">Liq: <span class="${token.liquidity < 10000 ? 'num-red' : 'num-green'}">${fmt.vol(token.liquidity)}</span></span>
      <span style="color:var(--text-muted)">MC: ${fmt.vol(token.mktCap)}</span>
    </div>
    ${token.isBreakout ? '<div class="badge badge-breakout">\ud83d\ude80 Breakout</div>' : ''}
    ${sig ? `<div class="meme-signal-block">
      <div class="meme-signal-label">\ud83d\udcca ${sig.phase} Signal</div>
      <div class="meme-signal-levels">
        <span class="num-cyan">Entry <strong>${fmt.price(sig.entry)}</strong></span>
        <span class="num-red">SL <strong>${fmt.price(sig.stopLoss)}</strong></span>
        <span class="num-green">TP <strong>${fmt.price(sig.takeProfit)}</strong></span>
      </div>
    </div>` : ''}
    ${token.rugFlags.length > 0 ? `<div class="rug-flags">${token.rugFlags.map(f => `<div class="rug-flag">${f.icon} ${f.label}</div>`).join('')}</div>` : ''}
    <div class="card-bottom-row">
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        <a class="card-action-icon" href="${token.dexUrl}" target="_blank" title="DexScreener" onclick="event.stopPropagation()">📊</a>
        ${token.socials[0]?.url ? `<a class="card-action-icon" href="${token.socials[0].url}" target="_blank" onclick="event.stopPropagation()">🐦</a>` : ''}
        ${token.websites[0]?.url ? `<a class="card-action-icon" href="${token.websites[0].url}" target="_blank" onclick="event.stopPropagation()">🌐</a>` : ''}
        ${terminals.axiom ? `<a class="terminal-link axiom" href="${terminals.axiom}" target="_blank" onclick="event.stopPropagation()">Axiom</a>` : ''}
        ${terminals.gmgn ? `<a class="terminal-link gmgn" href="${terminals.gmgn}" target="_blank" onclick="event.stopPropagation()">gmgn</a>` : ''}
        ${terminals.padre ? `<a class="terminal-link padre" href="${terminals.padre}" target="_blank" onclick="event.stopPropagation()">Padre</a>` : ''}
      </div>
      <span class="multiplier-badge mult-${token.multiplier.tier}">${token.multiplier.label}</span>
    </div>
  </div>`;
}

function updateScannerStats() {
  const tokens = AppState.scannerTokens;
  const el = document.getElementById('scanner-stats');
  if (!el) return;
  const hot = tokens.filter(t => t.pumpScore >= 70).length;
  const breakouts = tokens.filter(t => t.isBreakout).length;
  const accum = tokens.filter(t => !t.isBreakout && t.pumpScore >= 50).length;
  const risk = tokens.filter(t => t.rugFlags.length >= 2).length;
  el.innerHTML = `<span>${tokens.length} scanned</span> · <span class="num-amber">🔥 ${hot} hot</span> · <span class="num-green">🚀 ${breakouts} breakout</span> · <span class="num-cyan">📦 ${accum} accum</span> · <span class="num-red">⚠️ ${risk} risk</span>`;
}

// Scanner detail drawer
window.openScannerDetail = function (address) {
  const token = AppState.scannerTokens.find(t => t.address === address);
  if (!token) return;
  AppState.openDrawer = address;
  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('signal-drawer').classList.add('open');
  populateScannerDrawer(token);
};

function populateScannerDrawer(token) {
  const ch24 = token.priceChange.h24;
  const terminals = getTerminalLinks(token);

  // Header
  const iconEl = document.getElementById('drawer-coin-icon');
  if (token.imageUrl) {
    iconEl.innerHTML = `<img src="${token.imageUrl}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" onerror="this.parentElement.textContent='${token.symbol.slice(0, 2)}'">`;
  } else {
    iconEl.textContent = token.symbol.slice(0, 2);
  }
  document.getElementById('drawer-coin-name').textContent = `${token.name} (${token.symbol})`;
  document.getElementById('drawer-coin-change').textContent = fmt.pct(ch24);
  document.getElementById('drawer-coin-change').className = `drawer-coin-change ${ch24 >= 0 ? 'num-green' : 'num-red'}`;
  document.getElementById('drawer-dir-badge').className = 'direction-badge long';
  document.getElementById('drawer-dir-badge').textContent = `\u{1F4CA} Score: ${token.pumpScore}/100`;
  document.getElementById('drawer-vol').textContent = `Vol 24h: ${fmt.vol(token.volume.h24)} · Liq: ${fmt.vol(token.liquidity)}`;
  document.getElementById('drawer-description').textContent =
    `${token.name} is a ${token.chainId} token with pump score ${token.pumpScore}/100. ` +
    `${token.isBreakout ? 'Breakout detected — vol acceleration >2×. ' : !token.isBreakout && token.pumpScore >= 50 ? 'Accumulation phase — signal during low-volume consolidation. ' : ''}` +
    `${token.rugFlags.length ? 'Risks: ' + token.rugFlags.map(f => f.label).join(', ') + '.' : 'No major rug flags.'}`;

  // Terminal links
  const termLinks = document.getElementById('drawer-terminal-links');
  const termBtns = document.getElementById('drawer-terminal-btns');
  termLinks.style.display = 'block';
  termBtns.innerHTML = [
    terminals.axiom && `<a class="terminal-link axiom" href="${terminals.axiom}" target="_blank">Axiom</a>`,
    terminals.gmgn && `<a class="terminal-link gmgn" href="${terminals.gmgn}" target="_blank">gmgn.ai</a>`,
    terminals.photon && `<a class="terminal-link photon" href="${terminals.photon}" target="_blank">Photon</a>`,
    terminals.bubbleMaps && `<a class="terminal-link bubble" href="${terminals.bubbleMaps}" target="_blank">\ud83d\udef8 BubbleMaps</a>`,
    terminals.explorer && `<a class="terminal-link explorer" href="${terminals.explorer}" target="_blank">\ud83d\udd0e Explorer</a>`,
    terminals.kolscan && `<a class="terminal-link kolscan" href="${terminals.kolscan}" target="_blank">KolScan</a>`,
  ].filter(Boolean).join('');

  // History tab: price stats + memecoin signal + metrics table
  const sig = token.memeSignal;
  document.getElementById('drawer-history-panel').innerHTML = `
    <div class="signal-history-stats">
      <div class="sh-stat"><div class="sh-stat-label">Pump Score</div><div class="sh-stat-value ${token.pumpScore >= 70 ? 'num-green' : 'num-amber'}">${token.pumpScore}/100</div></div>
      <div class="sh-stat"><div class="sh-stat-label">5m</div><div class="sh-stat-value ${token.priceChange.m5 >= 0 ? 'num-green' : 'num-red'}">${fmt.pct(token.priceChange.m5)}</div></div>
      <div class="sh-stat"><div class="sh-stat-label">1h</div><div class="sh-stat-value ${token.priceChange.h1 >= 0 ? 'num-green' : 'num-red'}">${fmt.pct(token.priceChange.h1)}</div></div>
      <div class="sh-stat"><div class="sh-stat-label">24h</div><div class="sh-stat-value ${ch24 >= 0 ? 'num-green' : 'num-red'}">${fmt.pct(ch24)}</div></div>
    </div>
    ${sig ? `<div class="drawer-meme-signal">
      <div class="dms-header">\ud83d\udcca ${sig.phase} Signal <span class="dms-rr">R:R ${sig.rr}:1</span></div>
      <div class="dms-levels">
        <div class="dms-level"><span class="dms-lbl">Entry</span><span class="num-cyan dms-val">${fmt.price(sig.entry)}</span></div>
        <div class="dms-level"><span class="dms-lbl">Stop Loss</span><span class="num-red dms-val">${fmt.price(sig.stopLoss)}</span></div>
        <div class="dms-level"><span class="dms-lbl">Take Profit</span><span class="num-green dms-val">${fmt.price(sig.takeProfit)}</span></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${sig.note}</div>
    </div>` : ''}
    <table class="signal-history-table" style="margin-top:12px;">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Market Cap</td><td>${fmt.vol(token.mktCap)}</td></tr>
        <tr><td>FDV</td><td>${fmt.vol(token.fdv)}</td></tr>
        <tr><td>Liquidity</td><td>${fmt.vol(token.liquidity)}</td></tr>
        <tr><td>Volume 1h</td><td>${fmt.vol(token.volume.h1)}</td></tr>
        <tr><td>Buys/Sells 24h</td><td>${token.txns?.h24?.buys || 0} / ${token.txns?.h24?.sells || 0}</td></tr>
        <tr><td>Chain</td><td>${token.chainId}</td></tr>
        <tr><td>Signal Type</td><td>${token.signalType === 'fresh' ? '\u2726 Fresh' : '\u21ba Revived'}</td></tr>
      </tbody>
    </table>`;

  // Tech & social + LunarCrush
  const ts = Scanner.calcTechnicalSentiment(token);
  const whaleRisk = token.pumpScore >= 70 ? 'High concentration possible' : token.pumpScore >= 50 ? 'Moderate distribution' : 'Distributed';
  document.getElementById('drawer-techsocial-panel').innerHTML = `
    <div class="sentiment-card">
      <div class="sentiment-header"><div class="sentiment-title">\u2699\ufe0f Technical</div><div class="sentiment-label num-${ts.trend === 'Bullish' ? 'green' : ts.trend === 'Bearish' ? 'red' : 'amber'}">\u25cf ${ts.trend}</div></div>
      <div class="sentiment-bars">
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">Momentum</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill ${ts.momentum >= 50 ? 'green' : 'red'}" style="width:${ts.momentum}%"></div></div><span style="font-size:10px;color:var(--text-muted);margin-left:6px;">${ts.momentum}%</span></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">Buy Pressure</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill ${ts.buyPressure >= 50 ? 'green' : 'red'}" style="width:${ts.buyPressure}%"></div></div><span style="font-size:10px;color:var(--text-muted);margin-left:6px;">${ts.buyPressure}%</span></div>
        <div class="sentiment-bar-row"><div class="sentiment-bar-label">RSI Est.</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill cyan" style="width:${Math.min(100, ts.rsiEst)}%"></div></div><span style="font-size:10px;color:var(--text-muted);margin-left:6px;">${Math.round(ts.rsiEst)}</span></div>
      </div>
      <div class="sentiment-details">
        <div class="sentiment-detail-row"><div class="key">Volume Trend</div><div class="val num-cyan">${ts.volumeTrend}</div></div>
        <div class="sentiment-detail-row"><div class="key">Signal Phase</div><div class="val">${ts.trend === 'Bullish' && !token.isBreakout ? '\ud83d\udce6 Accumulation (ideal entry)' : token.isBreakout ? '\ud83d\ude80 Breakout (manage risk)' : '\u23f8\ufe0f Watch'}</div></div>
        ${token.rugFlags.map(f => `<div class="sentiment-detail-row"><div class="key">${f.icon} Risk</div><div class="val num-red">${f.label}</div></div>`).join('')}
      </div>
    </div>
    <div class="sentiment-card" style="margin-top:12px;" id="lunar-crush-card">
      <div class="sentiment-header"><div class="sentiment-title">\ud83c\udf19 Social Sentiment</div><div class="sentiment-label" id="lunar-status">Loading...</div></div>
      <div id="lunar-content"><div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Fetching LunarCrush data...</div></div>
    </div>
    <div class="sentiment-card" style="margin-top:12px;">
      <div class="sentiment-header"><div class="sentiment-title">\ud83d\udef8 Holder Distribution</div></div>
      <div class="sentiment-details">
        <div class="sentiment-detail-row"><div class="key">Est. Concentration</div><div class="val ${token.liquidity < 20000 ? 'num-red' : 'num-green'}">${whaleRisk}</div></div>
        <div class="sentiment-detail-row"><div class="key">FDV/MC Ratio</div><div class="val ${token.fdv > 0 && token.mktCap > 0 && token.fdv / token.mktCap > 5 ? 'num-red' : 'num-green'}">${token.fdv > 0 && token.mktCap > 0 ? (token.fdv / token.mktCap).toFixed(1) + '×' : '—'}</div></div>
        <div class="sentiment-detail-row"><div class="key">BubbleMaps</div><div class="val">${terminals.bubbleMaps ? `<a href="${terminals.bubbleMaps}" target="_blank" style="color:var(--accent-cyan);">View holder bubbles \u2192</a>` : 'N/A'}</div></div>
      </div>
    </div>`;

  // Fetch LunarCrush async
  API.LunarCrush.getSentiment(token.symbol).then(lc => {
    const el = document.getElementById('lunar-content');
    const st = document.getElementById('lunar-status');
    if (!el) return;
    if (!lc) {
      el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Social data unavailable for this token.</div>';
      if (st) st.textContent = 'N/A';
      return;
    }
    if (st) { st.textContent = lc.sentiment; st.className = `sentiment-label num-${lc.bullish >= 60 ? 'green' : lc.bullish <= 40 ? 'red' : 'amber'}`; }
    el.innerHTML = `<div class="sentiment-bars" style="margin-top:8px;">
      <div class="sentiment-bar-row"><div class="sentiment-bar-label">Bullish</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill green" style="width:${lc.bullish}%"></div></div><span style="font-size:10px;color:var(--text-muted);margin-left:6px;">${lc.bullish}%</span></div>
      <div class="sentiment-bar-row"><div class="sentiment-bar-label">Social Volume</div><div class="sentiment-bar-track"><div class="sentiment-bar-fill cyan" style="width:${Math.min(100, lc.socialVolumeScore)}%"></div></div></div>
    </div>
    <div class="sentiment-details" style="margin-top:8px;">
      <div class="sentiment-detail-row"><div class="key">Posts 24h</div><div class="val num-cyan">${lc.posts24h?.toLocaleString() || '—'}</div></div>
      <div class="sentiment-detail-row"><div class="key">Interactions</div><div class="val">${lc.interactions24h?.toLocaleString() || '—'}</div></div>
      <div class="sentiment-detail-row"><div class="key">Galaxy Score</div><div class="val ${lc.galaxyScore >= 50 ? 'num-green' : 'num-amber'}">${lc.galaxyScore || '—'}/100</div></div>
    </div>`;
  }).catch(() => {
    const el = document.getElementById('lunar-content');
    if (el) el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Social data unavailable.</div>';
  });

  // Smart trades with explorer links
  const traders = Scanner.generateSmartTraders(token);
  const maxB = Math.max(...traders.map(t => t.bought));
  document.getElementById('drawer-smarttrades-panel').innerHTML = `
    <div class="smart-trades-summary">
      <span>${traders.length} wallets detected</span>
      <strong>${fmt.vol(traders.reduce((a, t) => a + t.bought, 0))} total bought</strong>
    </div>
    <table class="smart-trades-table">
      <thead><tr><th>Wallet</th><th>Bought</th><th>Sold</th><th>ROI</th><th>Explore</th></tr></thead>
      <tbody>${traders.map(t => {
    const pct = Math.round((t.bought / maxB) * 100);
    const explorerUrl = terminals.walletExplorer(t.walletAddress || '11111111111111111111111111111111');
    return `<tr>
          <td><div class="wallet-name"><div class="wallet-avatar">${t.avatar}</div>${t.name}</div></td>
          <td><div class="wallet-balance">${fmt.vol(t.bought)}</div><div class="balance-bar"><div class="balance-bar-fill green" style="width:${pct}%"></div></div></td>
          <td>${t.sold ? fmt.vol(t.sold) : '\u2014'}</td>
          <td class="${t.roi ? (parseFloat(t.roi) > 0 ? 'roi-positive roi-value' : 'roi-negative roi-value') : ''}">${t.roi ? t.roi + '%' : '\u2014'}</td>
          <td><a href="${explorerUrl}" target="_blank" class="explorer-wallet-link" title="View on-chain">\ud83d\udd0d</a></td>
        </tr>`;
  }).join('')}</tbody>
    </table>`;
  switchDrawerTab('history');
}


// ══════════════════════════════════════════════════════
// TRADING LOG TAB
// ══════════════════════════════════════════════════════

function renderTradingLog() {
  const container = document.getElementById('trading-log-container');
  const positions = TradeLog.getPositions();
  const stats = TradeLog.getStats();

  document.getElementById('log-stat-win').textContent = stats.winRate + '%';
  document.getElementById('log-stat-pnl').textContent = (stats.totalPnl >= 0 ? '+' : '') + stats.totalPnl + '%';
  document.getElementById('log-stat-count').textContent = stats.count;
  document.getElementById('log-stat-open').textContent = positions.length;

  if (!positions.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">📒</div>
      <h3>No Open Positions</h3>
      <p>Take a trade from the Coin Signals tab to start tracking.</p>
      <button class="btn btn-outline" onclick="switchTab('signals')">📡 View Signals</button>
    </div>`;
    return;
  }
  container.innerHTML = positions.map(pos => {
    const pnlPct = TradeLog.calcPnL(pos);
    const isPos = pnlPct >= 0;
    const openedAgo = SignalEngine.timeAgo(pos.openedAt);
    return `<div class="position-card ${pos.direction === 'LONG' ? 'long-position' : 'short-position'}">
      <div class="position-card-header">
        <div class="position-symbol">${pos.symbol}/USDT</div>
        <div class="position-direction ${pos.direction === 'LONG' ? 'pos-long' : 'pos-short'}">${pos.direction === 'LONG' ? '▲' : '▼'} ${pos.direction}</div>
        <div style="margin-left:auto;font-size:12px;color:var(--text-muted)">R:R ${pos.rr}:1</div>
      </div>
      <div class="position-grid">
        <div class="position-cell"><div class="position-cell-label">Entry Price</div><div class="position-cell-value num-cyan">${fmt.price(pos.entry, pos.symbol)}</div></div>
        <div class="position-cell"><div class="position-cell-label">Stop Loss</div><div class="position-cell-value num-red">${fmt.price(pos.stopLoss, pos.symbol)}</div></div>
        <div class="position-cell"><div class="position-cell-label">Take Profit</div><div class="position-cell-value num-green">${fmt.price(pos.takeProfit, pos.symbol)}</div></div>
      </div>
      <div class="position-pnl-row">
        <span class="pnl-label">Unrealized P&L</span>
        <span class="pnl-value ${isPos ? 'pnl-positive' : 'pnl-negative'}" id="pnl-${pos.id}">${isPos ? '+' : ''}${pnlPct.toFixed(2)}%</span>
      </div>
      <div class="position-footer">
        <span class="position-opened">Opened ${openedAgo.value}${openedAgo.unit.toLowerCase()} ago</span>
        <button class="close-position-btn" onclick="closePos('${pos.id}')">Close Position</button>
      </div>
    </div>`;
  }).join('');
}

window.closePos = function (id) {
  const price = AppState.prices;
  const pos = TradeLog.getPositions().find(p => p.id === id);
  const cp = pos ? (price[pos.symbol] || pos.currentPrice || pos.entry) : null;
  const closed = TradeLog.closePosition(id, cp);
  if (closed) {
    const isWin = closed.pnlPct >= 0;
    showToast(isWin ? '✅' : '❌', `Position Closed — ${closed.symbol}`, `P&L: ${closed.pnlPct > 0 ? '+' : ''}${closed.pnlPct}%`, isWin ? 'success' : 'error');
    renderTradingLog();
  }
};

function updateTradingLogPnL() {
  TradeLog.getPositions().forEach(pos => {
    const livePrice = AppState.prices[pos.symbol];
    if (!livePrice) return;
    const pnlPct = pos.direction === 'LONG'
      ? ((livePrice - pos.entry) / pos.entry) * 100
      : ((pos.entry - livePrice) / pos.entry) * 100;
    const el = document.getElementById(`pnl-${pos.id}`);
    if (el) {
      el.textContent = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%';
      el.className = `pnl-value ${pnlPct >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
    }
  });
}

// ══════════════════════════════════════════════════════
// FEAR & GREED WIDGET
// ══════════════════════════════════════════════════════

async function loadFearGreed() {
  try {
    const fg = await API.FearGreed.get();
    const el = document.getElementById('fear-greed-value');
    const sl = document.getElementById('fear-greed-sent');
    if (el) el.textContent = fg.value;
    if (sl) { sl.textContent = fg.classification; sl.className = `fg-sentiment ${fg.value >= 60 ? 'num-green' : fg.value <= 30 ? 'num-red' : 'num-amber'}`; }
  } catch (_) { }
}

// ══════════════════════════════════════════════════════
// TICKER BAR
// ══════════════════════════════════════════════════════

async function loadTicker() {
  try {
    const data = await API.CoinGecko.getPrices(['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
    const bar = document.getElementById('ticker-bar');
    if (!bar) return;
    const symbols = [
      { sym: 'BTC', id: 'bitcoin', icon: '₿' },
      { sym: 'ETH', id: 'ethereum', icon: 'Ξ' },
      { sym: 'SOL', id: 'solana', icon: '◎' },
      { sym: 'BNB', id: 'binancecoin', icon: 'B' },
      { sym: 'XRP', id: 'ripple', icon: 'X' }
    ];
    const makeItems = () => symbols.map(c => {
      const d = data[c.id] || {};
      const ch = d.usd_24h_change || 0;
      return `<div class="ticker-item">
        <span style="color:var(--text-muted)">${c.icon} ${c.sym}</span>
        <span style="font-family:var(--font-mono);color:var(--text-primary);">${fmt.price(d.usd, c.sym)}</span>
        <span class="${ch >= 0 ? 'num-green' : 'num-red'};font-weight:600">${fmt.pct(ch)}</span>
      </div><span class="ticker-sep">·</span>`;
    }).join('');
    // Duplicate items for seamless infinite scroll
    bar.innerHTML = `<div class="ticker-inner">${makeItems()}${makeItems()}</div>`;
  } catch (_) { }
}

// ══════════════════════════════════════════════════════
// APP INIT
// ══════════════════════════════════════════════════════

const App = {
  init() {
    AuthManager.init();
    if (!AuthManager.isLoggedIn()) { showAuthPage('login'); return; }
    this.setupNav();
    this.setupDrawer();
    this.setupAdminPanel();
    this.gateFeatures();
    switchTab('signals');
    loadSignals();
    loadFearGreed();
    loadTicker();
    updatePrices();
    AppState.liveRefreshInterval = setInterval(() => {
      updatePrices();
      updateTradingLogPnL();
      loadTicker();
    }, 60000);
  },

  setupNav() {
    const user = AuthManager.getUser();
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const t = tab.dataset.tab;
        switchTab(t);
        if (t === 'signals') { renderSignalCards(); updateSignalStats(); }
        if (t === 'scanner' && !AppState.scannerTokens.length) loadScanner();
        if (t === 'scanner') renderScannerCards();
        if (t === 'log') renderTradingLog();
      });
    });

    // Coin filter
    document.querySelectorAll('.coin-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.coin-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        AppState.signalCoinFilter = btn.dataset.coin;
        renderSignalCards();
      });
    });

    // Signal type + scanner type + chain + score filters
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const group = pill.dataset.group;
        if (!group) return;
        document.querySelectorAll(`.filter-pill[data-group="${group}"]`).forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        if (group === 'signal') { AppState.signalFilter = pill.dataset.value; renderSignalCards(); }
        if (group === 'scanner') { AppState.scannerFilter = pill.dataset.value; renderScannerCards(); }
        if (group === 'chain') { AppState.scannerChain = pill.dataset.value; renderScannerCards(); }
        if (group === 'score') { AppState.scannerScore = parseInt(pill.dataset.value) || 0; renderScannerCards(); }
      });
    });

    // Add Coin button
    const addCoinBtn = document.getElementById('add-coin-btn');
    if (addCoinBtn) addCoinBtn.addEventListener('click', () => window.showAddCoinModal());

    // Scanner search
    const sq = document.getElementById('scanner-search');
    if (sq) sq.addEventListener('input', () => { AppState.scannerQuery = sq.value.trim().toLowerCase(); renderScannerCards(); });

    // Live/History toggle
    document.querySelectorAll('.live-btn, .history-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.live-btn, .history-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        AppState.signalView = btn.classList.contains('live-btn') ? 'live' : 'history';
        if (AppState.signalView === 'live' && !AppState.signals.length) loadSignals();
        else renderSignalCards();
      });
    });

    // Scan Now / Auto Scan
    const scanBtn = document.getElementById('scan-now-btn');
    if (scanBtn) scanBtn.addEventListener('click', () => { scanBtn.classList.add('scanning'); loadScanner().finally(() => scanBtn.classList.remove('scanning')); });

    const autoToggle = document.getElementById('auto-scan-toggle');
    if (autoToggle) autoToggle.addEventListener('click', () => {
      AppState.autoScan = !AppState.autoScan;
      autoToggle.classList.toggle('on', AppState.autoScan);
      if (AppState.autoScan) {
        AppState.scanInterval = setInterval(loadScanner, 120000);
        showToast('🔄', 'Auto-scan On', 'Refreshing every 2 minutes', 'info');
      } else {
        clearInterval(AppState.scanInterval);
        showToast('⏸️', 'Auto-scan Off', '', 'info');
      }
    });

    // Admin panel button
    const adminBtn = document.getElementById('admin-btn');
    if (adminBtn) {
      if (AuthManager.isAdmin()) adminBtn.style.display = 'flex';
      adminBtn.addEventListener('click', openAdminPanel);
    }

    // Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => {
      AuthManager.logout();
      clearInterval(AppState.liveRefreshInterval);
      showAuthPage('login');
    });

    // User display
    const userEl = document.getElementById('nav-user-name');
    if (userEl && user) userEl.textContent = user.name;
  },

  setupDrawer() {
    document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
    document.getElementById('drawer-close-btn').addEventListener('click', closeDrawer);
    document.querySelectorAll('.drawer-tab').forEach(tab => {
      tab.addEventListener('click', () => switchDrawerTab(tab.dataset.dtab));
    });
  },

  setupAdminPanel() {
    const overlay = document.getElementById('admin-overlay');
    overlay.addEventListener('click', e => { if (e.target === overlay) closeAdminPanel(); });
    document.getElementById('admin-close-btn').addEventListener('click', closeAdminPanel);
    document.getElementById('admin-invite-btn').addEventListener('click', () => {
      const email = document.getElementById('invite-email').value.trim();
      const name = document.getElementById('invite-name').value.trim();
      if (!email) return;
      const result = AuthManager.inviteUser(email, name);
      if (result.success) { showToast('✉️', 'Invite Sent', email, 'success'); renderAdminPanel(); document.getElementById('invite-email').value = ''; document.getElementById('invite-name').value = ''; }
      else showToast('⚠️', 'Error', result.error, 'warning');
    });
  },

  gateFeatures() {
    const user = AuthManager.getUser();
    if (!user) return;
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(t => {
      const tab = t.dataset.tab;
      if (tab === 'scanner' && !user.features?.memeScanner) t.style.opacity = '0.4';
      if (tab === 'log' && !user.features?.tradingLog) t.style.opacity = '0.4';
    });
  }
};

// ── Kick off ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());

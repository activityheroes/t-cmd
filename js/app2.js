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

// ── Entry window countdown timer ───────────────────────────────
function fmtTimer(remainMs) {
  if (remainMs <= 0) return 'EXPIRED';
  const totalSec = Math.floor(remainMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

// ── Sparkline mini-chart from price change data ─────────────────
function sparklineChart(token) {
  const ch24 = parseFloat(token.priceChange?.h24 || 0);
  const ch6  = parseFloat(token.priceChange?.h6  || 0);
  const ch1  = parseFloat(token.priceChange?.h1  || 0);
  const ch_m5= parseFloat(token.priceChange?.m5  || 0);
  // Reconstruct historical prices relative to current (= 1.0)
  const p_now = 1.0;
  const p_1h  = p_now  / (1 + ch1  / 100 || 1);
  const p_6h  = p_now  / (1 + ch6  / 100 || 1);
  const p_24h = p_now  / (1 + ch24 / 100 || 1);
  // Interpolate to 7 points for a smoother curve
  const pts = [
    p_24h,
    p_24h * 0.6 + p_6h * 0.4,
    p_24h * 0.2 + p_6h * 0.8,
    p_6h,
    p_6h  * 0.4 + p_1h * 0.6,
    p_1h,
    p_now
  ];
  const minP = Math.min(...pts), maxP = Math.max(...pts);
  const range = (maxP - minP) || 0.001;
  const norm  = pts.map(p => (p - minP) / range);
  const W = 300, H = 58, px = 4, py = 6;
  const svgPts = norm.map((v, i) => [
    px + (i / (norm.length - 1)) * (W - px * 2),
    H - py - v * (H - py * 2)
  ]);
  // Smooth bezier path
  let d = `M ${svgPts[0][0].toFixed(1)} ${svgPts[0][1].toFixed(1)}`;
  for (let i = 1; i < svgPts.length; i++) {
    const [ax, ay] = svgPts[i - 1], [bx, by] = svgPts[i];
    const cpx = ax + (bx - ax) * 0.5;
    d += ` C ${cpx.toFixed(1)} ${ay.toFixed(1)} ${cpx.toFixed(1)} ${by.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  const [lastX, lastY] = svgPts[svgPts.length - 1];
  const fillD = `${d} L ${lastX.toFixed(1)} ${H} L ${px} ${H} Z`;
  const isUp  = ch24 >= 0;
  const lc    = isUp ? '#22c55e' : '#ef4444';
  const gradId = `cg${token.address.slice(-6)}`;
  // Signal marker: position based on when signal was scanned
  const sigTs    = token.scannedAt || Date.now();
  const ageMs    = Math.max(0, Date.now() - sigTs);
  const ageFrac  = Math.min(1, ageMs / 86400000); // fraction through 24h window
  const sigIdxF  = (1 - ageFrac) * (svgPts.length - 1);
  const si0      = Math.min(Math.floor(sigIdxF), svgPts.length - 2);
  const sf       = sigIdxF - si0;
  const sigX     = svgPts[si0][0] + (svgPts[si0 + 1][0] - svgPts[si0][0]) * sf;
  const sigY     = svgPts[si0][1] + (svgPts[si0 + 1][1] - svgPts[si0][1]) * sf;

  // ── Signal popup metadata ─────────────────────────────────────
  // Pick the price-change window that best covers the signal age
  const sigWindowPct = ageMs < 300000   ? ch_m5
                     : ageMs < 3600000  ? ch1
                     : ageMs < 21600000 ? ch6
                     : ch24;
  const divsr    = 1 + sigWindowPct / 100;
  const safeDivsr = Math.abs(divsr) > 0.05 ? divsr : 0.05;
  const sigPrice = token.priceUSD > 0 ? token.priceUSD / safeDivsr : 0;
  const sigMC    = (token.mktCap  || 0) / safeDivsr;
  // Format signal datetime: "2/28, 04:35:46"
  const _sd      = new Date(sigTs);
  const sigDateStr = `${_sd.getMonth()+1}/${_sd.getDate()}, ` +
    _sd.toLocaleTimeString('en', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });

  // Time labels
  const _t = (offsetMs) => {
    const d = new Date(Date.now() - offsetMs);
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: true });
  };
  return `<div class="card-sparkline">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:64px;display:block;">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${lc}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${lc}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#${gradId})"/>
      <path d="${d}" fill="none" stroke="${lc}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${sigX.toFixed(1)}" cy="${sigY.toFixed(1)}" r="9" fill="${lc}" opacity="0.15"/>
      <circle cx="${sigX.toFixed(1)}" cy="${sigY.toFixed(1)}" r="4.5" fill="${lc}"/>
      <circle cx="${sigX.toFixed(1)}" cy="${sigY.toFixed(1)}" r="2" fill="white" opacity="0.95"/>
      <!-- Hit area — pointer-events="all" required because fill:transparent
           would otherwise be invisible to mouse events (SVG default is visiblePainted) -->
      <circle class="sparkline-sig-hit"
        cx="${sigX.toFixed(1)}" cy="${sigY.toFixed(1)}" r="16"
        fill="transparent" pointer-events="all" style="cursor:pointer;"
        data-sig-date="${sigDateStr}"
        data-sig-price="${sigPrice > 0 ? sigPrice.toPrecision(6) : '0'}"
        data-sig-mc="${Math.max(0, Math.round(sigMC))}"
        data-sig-change="${sigWindowPct.toFixed(2)}"
        data-sig-symbol="${(token.symbol||'').replace(/"/g,'')}"
      />
    </svg>
    <div class="sparkline-labels">
      <span>${_t(86400000)}</span>
      <span>${_t(21600000)}</span>
      <span>${_t(3600000)}</span>
      <span>Now</span>
    </div>
  </div>`;
}

let _timerInterval = null;
function startSignalTimers() {
  if (_timerInterval) clearInterval(_timerInterval);
  _timerInterval = setInterval(() => {
    document.querySelectorAll('[data-signal-ts]').forEach(el => {
      el.textContent = fmtAge(parseInt(el.dataset.signalTs));
    });
    document.querySelectorAll('[data-entry-end]').forEach(el => {
      const end = parseInt(el.dataset.entryEnd);
      const remaining = end - Date.now();
      el.textContent = fmtTimer(remaining);
      el.classList.toggle('timer-expired', remaining <= 0);
      el.classList.toggle('timer-urgent', remaining > 0 && remaining < 600000);
    });
  }, 1000);
}

// ══════════════════════════════════════════════════════
// SCANNER TAB
// ══════════════════════════════════════════════════════

// ── Re-merge custom tokens saved by the user after a fresh scan ─
async function restoreCustomTokens() {
  let customs;
  try { customs = JSON.parse(localStorage.getItem('tcmd_custom_tokens') || '[]'); } catch { customs = []; }
  if (!customs.length) return;

  const existing = new Set((AppState.scannerTokens || []).map(t => t.address));
  const missing  = customs.filter(addr => !existing.has(addr)).slice(0, 20); // cap at 20
  if (!missing.length) return;

  const settled = await Promise.allSettled(
    missing.map(async addr => {
      try {
        const pairs = await API.DexScreener.getTokenPairs('solana', addr);
        const best  = (pairs || [])
          .sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))[0];
        if (!best || parseFloat(best.priceUsd || 0) <= 0) return null;
        return Scanner.formatToken(best, 0);
      } catch { return null; }
    })
  );

  const fetched = settled.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  if (!fetched.length) return;

  // Prepend restored custom tokens so they appear at the top
  AppState.scannerTokens = [...fetched, ...(AppState.scannerTokens || [])];
}

async function loadScanner() {
  const grid = document.getElementById('scanner-grid');
  grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-secondary);">
    <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
    <div>Scanning DexScreener for trending memecoins...</div>
  </div>`;
  try {
    const tokens = await Scanner.fetchAndScore();
    AppState.scannerTokens = tokens;
    if (!AppState.rugResults) AppState.rugResults = {};
    if (!AppState.momentumResults) AppState.momentumResults = {};
    // Re-merge any custom tokens the user manually added (they aren't in the trending feed)
    await restoreCustomTokens();
    renderScannerCards();
    updateScannerStats();
    startSignalTimers();
    showToast('🔍', 'Scan Complete', `Found ${AppState.scannerTokens.length} tokens`, 'success');
    // Background auto-analysis (non-blocking)
    autoAnalyzeTokens(AppState.scannerTokens);
  } catch (e) {
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">
      <div class="empty-state-icon">⚠️</div>
      <h3>Scan Failed</h3><p>Could not reach DexScreener API. Check your connection.</p>
      <button class="btn btn-outline" onclick="loadScanner()">↺ Retry</button>
    </div>`;
  }
}

// ── Background auto-analysis ──────────────────────────────────
const _autoQueue = [];
let _autoRunning = false;
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function autoAnalyzeTokens(tokens) {
  if (!AppState.momentumResults) AppState.momentumResults = {};
  _autoQueue.length = 0;
  tokens.slice(0, 25).forEach(t => _autoQueue.push(t));
  if (!_autoRunning) _processAutoQueue();
}

async function _processAutoQueue() {
  _autoRunning = true;
  while (_autoQueue.length > 0) {
    const batch = _autoQueue.splice(0, 2);
    await Promise.all(batch.map(autoAnalyzeOne));
    if (_autoQueue.length > 0) await _sleep(1500);
  }
  _autoRunning = false;
}

async function autoAnalyzeOne(token) {
  try {
    if (typeof MomentumDetector === 'undefined') return;
    const mom = await MomentumDetector.analyze(token);
    if (mom && mom.momentumScore >= 0) {
      AppState.momentumResults[token.address] = mom;
      updateCardMomentum(token.address, mom);
    }
  } catch (e) {
    // silent — background task
  }
}

function updateCardMomentum(address, result) {
  const badge = document.querySelector(`.mom-auto-badge[data-addr="${address}"]`);
  if (!badge) return;
  const score = result.momentumScore || 0;
  if (result.isGem) {
    badge.innerHTML = `💎 GEM`;
    badge.className = 'mom-auto-badge gem';
    badge.title = `Momentum Score: ${score} — GEM DETECTED`;
  } else if (score >= 60) {
    badge.innerHTML = `🚀 ${score}`;
    badge.className = 'mom-auto-badge high';
    badge.title = `Momentum: HIGH POTENTIAL (${score}/100)`;
  } else if (score >= 35) {
    badge.innerHTML = `📈 ${score}`;
    badge.className = 'mom-auto-badge medium';
    badge.title = `Momentum: MEDIUM (${score}/100)`;
  } else {
    badge.innerHTML = `📊 ${score}`;
    badge.className = 'mom-auto-badge low';
    badge.title = `Momentum: LOW (${score}/100)`;
  }
}

// ── Favorites helpers ─────────────────────────────────────────
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('tcmd_favorites') || '[]'); } catch { return []; }
}
function isFavorite(addr) { return getFavorites().includes(addr); }
window.toggleFavorite = function (addr) {
  const favs = getFavorites();
  const idx = favs.indexOf(addr);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(addr);
  localStorage.setItem('tcmd_favorites', JSON.stringify(favs));
  const isNowFav = idx < 0;
  document.querySelectorAll(`.fav-btn[data-addr="${addr}"]`).forEach(btn => {
    btn.classList.toggle('active', isNowFav);
    btn.title = isNowFav ? 'Remove from favorites' : 'Add to favorites';
  });
  // Update gems/favorites filter counts
  updateScannerStats();
};

// ── DexScreener token search ──────────────────────────────────
async function searchAndAddToken(query) {
  query = (query || '').trim();
  if (!query) return;
  const findBtn = document.getElementById('scanner-find-btn');
  if (findBtn) { findBtn.textContent = '…'; findBtn.disabled = true; }
  try {
    // Try address lookup first (32+ char strings = likely token address)
    let pair = null;
    if (query.length >= 32) {
      const data = await ChainAPIs.dsToken(query).catch(() => null);
      const pairs = data?.pairs || [];
      pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
    }
    // Fallback: text search
    if (!pair) {
      const data = await ChainAPIs.dsSearch(query).catch(() => null);
      const pairs = data?.pairs || [];
      pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
    }
    if (!pair) {
      showToast('❌', 'Not Found', `No token found for "${query}"`, 'error');
      return;
    }
    const baseAddr = pair.baseToken?.address || '';
    if (!baseAddr) { showToast('❌', 'Error', 'Invalid token data', 'error'); return; }
    // Build token from pair data using Scanner.formatToken (preferred) or fallback
    let newToken = null;
    if (typeof Scanner !== 'undefined' && typeof Scanner.formatToken === 'function') {
      newToken = Scanner.formatToken(pair, pair.boostAmount || 0);
    } else {
      newToken = _buildTokenFromPair(pair);
    }
    if (!newToken) { showToast('❌', 'Error', 'Could not parse token data', 'error'); return; }
    // Insert at top if not already present
    const exists = AppState.scannerTokens.find(t => t.address === baseAddr);
    if (!exists) {
      AppState.scannerTokens.unshift(newToken);
      // Persist custom tokens
      const customs = JSON.parse(localStorage.getItem('tcmd_custom_tokens') || '[]');
      if (!customs.includes(baseAddr)) { customs.unshift(baseAddr); localStorage.setItem('tcmd_custom_tokens', JSON.stringify(customs.slice(0, 50))); }
    }
    // Clear search input and re-render
    const sq = document.getElementById('scanner-search');
    if (sq) sq.value = '';
    AppState.scannerQuery = '';
    renderScannerCards();
    showToast('✅', 'Token Added', `${pair.baseToken?.name || baseAddr.slice(0, 8)} added to scanner`, 'success');
    autoAnalyzeOne(newToken);
  } catch (e) {
    showToast('❌', 'Search Error', e.message || 'Unknown error', 'error');
  } finally {
    if (findBtn) { findBtn.textContent = 'Find'; findBtn.disabled = false; }
  }
}

function _buildTokenFromPair(pair) {
  // Minimal token object from DexScreener pair data
  if (!pair?.baseToken) return null;
  const p = pair;
  const b = p.baseToken;
  const chainRaw = (p.chainId || 'solana').toLowerCase();
  return {
    address:     b.address  || '',
    name:        b.name     || 'Unknown',
    symbol:      b.symbol   || '???',
    chainId:     p.chainId  || 'solana',
    priceUSD:    parseFloat(p.priceUsd || 0),
    priceChange: { m5: p.priceChange?.m5 || 0, h1: p.priceChange?.h1 || 0, h6: p.priceChange?.h6 || 0, h24: p.priceChange?.h24 || 0 },
    volume:      { m5: p.volume?.m5 || 0, h1: p.volume?.h1 || 0, h6: p.volume?.h6 || 0, h24: p.volume?.h24 || 0 },
    liquidity:   p.liquidity?.usd || 0,
    mktCap:      p.marketCap || 0,
    fdv:         p.fdv || 0,
    txns:        p.txns || {},
    pairAddress: p.pairAddress || '',
    dexUrl:      p.url || `https://dexscreener.com/${chainRaw}/${p.pairAddress}`,
    socials:     [],
    websites:    [],
    imageUrl:    b.info?.imageUrl || null,
    boostAmount: 0,
    pumpScore:   Math.min(100, Math.round(((p.volume?.h1 || 0) / Math.max(p.liquidity?.usd || 1, 1)) * 20)),
    rugFlags:    [],
    isBreakout:  false,
    signalType:  'fresh',
    multiplier:  { label: '—', tier: 'low' },
    memeSignal:  null,
    scannedAt:   Date.now(),
    isCustom:    true
  };
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
  if (AppState.scannerFilter === 'favorites') {
    const favs = getFavorites();
    t = t.filter(x => favs.includes(x.address));
  }
  if (AppState.scannerFilter === 'gems') {
    t = t.filter(x => AppState.momentumResults?.[x.address]?.isGem);
  }
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

  // Always float favorites to top (unless already filtering for favorites only)
  if (AppState.scannerFilter !== 'favorites') {
    const favSet = new Set(getFavorites());
    if (favSet.size > 0) {
      t = [...t.filter(x => favSet.has(x.address)), ...t.filter(x => !favSet.has(x.address))];
    }
  }

  return t;
}

function renderScannerCards() {
  const grid = document.getElementById('scanner-grid');
  if (!grid) return;
  const tokens = filterScannerTokens(AppState.scannerTokens || []);
  if (!tokens.length) {
    const q = AppState.scannerQuery || '';
    const canSearch = q.length > 1;
    const qSafe = q.replace(/'/g, '&#39;');
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">
      <div class="empty-state-icon">${canSearch ? '🔍' : '📡'}</div>
      <h3>${canSearch ? `No local results for "${q}"` : 'No Tokens Match'}</h3>
      <p>${canSearch ? 'Not in scanner yet — try searching DexScreener to add it.' : 'Adjust filters or run a fresh scan.'}</p>
      ${canSearch
        ? `<button class="btn btn-outline" style="margin-top:10px;" onclick="searchAndAddToken('${qSafe}')">🌐 Search DexScreener for "${qSafe}"</button>`
        : `<button class="btn btn-outline" onclick="loadScanner()">🔍 Scan Now</button>`}
    </div>`;
    return;
  }
  grid.innerHTML = tokens.map(renderScannerCard).join('');
}

function renderScannerCard(token) {
  const scoreClass = token.pumpScore >= 70 ? 'high' : token.pumpScore >= 45 ? 'medium' : 'low';
  const ch24 = token.priceChange.h24;
  const sig = token.memeSignal;
  const isFav = isFavorite(token.address);
  const momResult = AppState.momentumResults?.[token.address] || null;
  const addr = token.address;

  // Momentum badge
  let momBadgeHtml = '';
  if (momResult) {
    const sc = momResult.momentumScore || 0;
    if (momResult.isGem) {
      momBadgeHtml = `<span class="mom-auto-badge gem" data-addr="${addr}" title="Momentum Score: ${sc} — GEM DETECTED!">💎 GEM</span>`;
    } else if (sc >= 60) {
      momBadgeHtml = `<span class="mom-auto-badge high" data-addr="${addr}" title="HIGH POTENTIAL (${sc}/100)">🚀 ${sc}</span>`;
    } else if (sc >= 35) {
      momBadgeHtml = `<span class="mom-auto-badge medium" data-addr="${addr}" title="MEDIUM MOMENTUM (${sc}/100)">📈 ${sc}</span>`;
    } else {
      momBadgeHtml = `<span class="mom-auto-badge low" data-addr="${addr}" title="LOW MOMENTUM (${sc}/100)">📊 ${sc}</span>`;
    }
  } else {
    momBadgeHtml = `<span class="mom-auto-badge pending" data-addr="${addr}" title="Analysing momentum...">⟳</span>`;
  }

  // Entry window countdown timer
  const windowMs = token.isBreakout ? 2 * 3600000 : 8 * 3600000; // 2h breakout, 8h accum
  const scannedAt = token.scannedAt || Date.now();
  const entryEnd = scannedAt + windowMs;
  const remainMs = entryEnd - Date.now();
  const timerClass = remainMs <= 0 ? 'timer-expired' : remainMs < 600000 ? 'timer-urgent' : '';
  const entryTimerHtml = `<div class="entry-timer-block">
    <span class="entry-timer-label">${token.isBreakout ? '🚀 Breakout' : '📦 Accumulation'} window</span>
    <span class="entry-timer-value ${timerClass}" data-entry-end="${entryEnd}">${fmtTimer(remainMs)}</span>
  </div>`;

  const logoHtml = token.imageUrl
    ? `<img src="${token.imageUrl}" class="token-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <div class="coin-icon" style="font-weight:700;font-size:11px;display:none;">${token.symbol.slice(0, 3)}</div>`
    : `<div class="coin-icon" style="font-weight:700;font-size:11px;">${token.symbol.slice(0, 3)}</div>`;

  const chainBadge = `<span class="chain-badge chain-${(token.chainId || 'sol').toLowerCase().slice(0, 3)}">${token.chainId}</span>`;
  const terminals = getTerminalLinks(token);

  // Terminal icon links — DEX = nav only; Axiom/GMGN/Padre = copy CA + open
  const dsFavicon    = 'https://dexscreener.com/favicon.ico';
  const axiomFavicon = 'https://axiom.trade/favicon.ico';
  const gmgnSvg      = 'assets/logos/gmgn.svg';
  const padreSvg     = 'assets/logos/padre.svg';

  // Plain nav link (for DEX)
  const navLink = (href, iconSrc, label, cls, imgW = 14, isSvg = false) =>
    `<a class="terminal-icon-link ${cls}" href="${href}" target="_blank" onclick="event.stopPropagation()" title="${label}">
      <img src="${iconSrc}" width="${imgW}" height="14" onerror="this.style.display='none'" style="${isSvg ? 'object-fit:contain;' : 'border-radius:3px;'}vertical-align:middle;margin-right:3px;">${label}
    </a>`;
  // Copy-CA + open link (for Axiom, GMGN, Padre)
  const tradeLink = (href, iconSrc, label, cls, tokenAddr, imgW = 14, isSvg = false) =>
    `<button class="terminal-icon-link ${cls}" onclick="event.stopPropagation();window.copyAndGo('${tokenAddr}','${href}','${label}')" title="Trade on ${label} · CA auto-copied to clipboard">
      <img src="${iconSrc}" width="${imgW}" height="14" onerror="this.style.display='none'" style="${isSvg ? 'object-fit:contain;' : 'border-radius:3px;'}vertical-align:middle;margin-right:3px;">${label}
    </button>`;

  // Tooltip helper for badge hover
  const tip = (text) => `data-tooltip="${text.replace(/"/g, '&quot;')}"`;

  return `<div class="signal-card ${token.isBreakout ? 'long-card' : token.pumpScore >= 50 && !token.isBreakout ? 'accum-card' : ''} animate-fadeInUp" onclick="openScannerDetail('${addr}')">
    <div class="card-top-row">
      <span class="card-type-badge ${token.signalType}" ${tip(token.signalType === 'fresh' ? 'Fresh token — launched < 6 hours ago' : 'Revived — older token with new momentum')}>${token.signalType === 'fresh' ? '\u2726 Fresh' : '\u21ba Revived'}</span>
      <span class="signal-age-clock" data-signal-ts="${scannedAt}" ${tip('Signal detected ' + fmtAge(scannedAt) + ' ago')}>${fmtAge(scannedAt)}</span>
      ${momResult
        ? momResult.isGem
          ? `<span class="mom-auto-badge gem" data-addr="${addr}" ${tip('💎 GEM — Momentum ≥75. High probability runner. Rare signal.')}>💎 GEM</span>`
          : momResult.momentumScore >= 60
            ? `<span class="mom-auto-badge high" data-addr="${addr}" ${tip('HIGH POTENTIAL — strong momentum, multiple signals firing')}>🚀 ${momResult.momentumScore}</span>`
            : momResult.momentumScore >= 35
              ? `<span class="mom-auto-badge medium" data-addr="${addr}" ${tip('MEDIUM momentum — building phase, watch closely')}>📈 ${momResult.momentumScore}</span>`
              : `<span class="mom-auto-badge low" data-addr="${addr}" ${tip('LOW momentum — weak signals')}>📊 ${momResult.momentumScore}</span>`
        : `<span class="mom-auto-badge pending" data-addr="${addr}" ${tip('Scanning momentum in background…')}>⟳</span>`
      }
      <div class="pump-score ${scoreClass}" ${tip('Pump Score: composite signal strength 0–100. 70+ = Hot 🔥')}>
        <div class="pump-score-value">${token.pumpScore}</div>
        <div class="pump-score-label">Score</div>
      </div>
      <button class="fav-btn ${isFav ? 'active' : ''}" data-addr="${addr}" onclick="event.stopPropagation();window.toggleFavorite('${addr}')" title="${isFav ? 'Remove from favorites' : 'Save to favorites'}">⭐</button>
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

    <div class="card-stats-row">
      <span>Vol 24h: <span class="num-cyan">${fmt.vol(token.volume.h24)}</span></span>
      <span>Liq: <span class="${token.liquidity < 10000 ? 'num-red' : 'num-green'}">${fmt.vol(token.liquidity)}</span></span>
      <span>MC: <span class="num-amber">${fmt.vol(token.mktCap)}</span></span>
    </div>

    ${sparklineChart(token)}

    ${sig ? (() => {
      const supply = token.mktCap > 0 && token.priceUSD > 0 ? token.mktCap / token.priceUSD : 0;
      const toMc = p => supply > 0 ? fmt.vol(p * supply) : '—';
      return `<div class="meme-signal-block" id="msb-${addr}" data-mc-mode="1">
      <div class="meme-signal-header">
        <div class="meme-signal-label">📊 ${sig.phase} Signal</div>
        <button class="mc-toggle-btn" onclick="event.stopPropagation();window.toggleMcMode('${addr}')" title="Switch between Market Cap and Price view">
          <svg width="14" height="10" viewBox="0 0 14 10" fill="none" style="vertical-align:middle;margin-right:4px;"><path d="M1 5h12M9 1l4 4-4 4M5 1L1 5l4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="mc-toggle-price" style="display:none;">💲 Price</span>
          <span class="mc-toggle-mc">📈 MC</span>
        </button>
      </div>
      <div class="meme-signal-levels" id="msb-levels-${addr}">
        <span class="num-cyan" ${tip('Suggested entry price / market cap')}>Entry
          <strong class="msb-entry-p" style="display:none">${fmt.price(sig.entry)}</strong>
          <strong class="msb-entry-mc"><em>${toMc(sig.entry)}</em></strong>
        </span>
        <span class="num-red" ${tip('Stop loss — exit if price drops here')}>SL
          <strong class="msb-sl-p" style="display:none">${fmt.price(sig.stopLoss)}</strong>
          <strong class="msb-sl-mc"><em>${toMc(sig.stopLoss)}</em></strong>
        </span>
        <span class="num-green" ${tip('Take profit target')}>TP
          <strong class="msb-tp-p" style="display:none">${fmt.price(sig.takeProfit)}</strong>
          <strong class="msb-tp-mc"><em>${toMc(sig.takeProfit)}</em></strong>
        </span>
      </div>
    </div>`;
    })() : ''}

    ${entryTimerHtml}
    ${token.rugFlags.length > 0 ? `<div class="rug-flags">${token.rugFlags.map(f => `<div class="rug-flag" ${tip(f.label)}>${f.icon} ${f.label}</div>`).join('')}</div>` : ''}

    <div class="card-bottom-row">
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        <button class="ca-copy-btn" onclick="event.stopPropagation();copyCa('${addr}',this)" title="Copy contract address">
          📋 ${addr ? addr.slice(0, 4) + '…' + addr.slice(-4) : 'CA'}
        </button>
        <button class="rug-check-btn" onclick="event.stopPropagation();if(typeof RugUI!=='undefined')RugUI.openPanel('${addr}','${token.chainId}','${token.name.replace(/'/g,"&#39;")}')" title="Deep rug analysis — 12 signals + wallet clusters">🛡️ Rug</button>
        ${navLink(token.dexUrl, dsFavicon, 'View on DexScreener', 'dex')}
        ${token.socials[0]?.url ? `<a class="card-action-icon x-social-link" href="${token.socials[0].url}" target="_blank" onclick="event.stopPropagation()" title="X / Twitter"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/></svg></a>` : ''}
        ${token.websites[0]?.url ? `<a class="card-action-icon" href="${token.websites[0].url}" target="_blank" onclick="event.stopPropagation()" title="Website">🌐</a>` : ''}
        ${terminals.axiom ? tradeLink(terminals.axiom, axiomFavicon, 'Axiom', 'axiom', addr) : ''}
        ${terminals.gmgn  ? tradeLink(terminals.gmgn,  gmgnSvg,      'GMGN',  'gmgn',  addr, 28, true) : ''}
        ${terminals.padre ? tradeLink(terminals.padre,  padreSvg,     'Padre', 'padre', addr, 14, true) : ''}
      </div>
      <span class="multiplier-badge mult-${token.multiplier.tier}" ${tip('Potential multiplier based on current market cap vs sector')}>${token.multiplier.label}</span>
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
  const gems = tokens.filter(t => AppState.momentumResults?.[t.address]?.isGem).length;
  const favs = getFavorites().length;
  el.innerHTML = `<span>${tokens.length} scanned</span> · <span class="num-amber">🔥 ${hot} hot</span> · <span class="num-green">🚀 ${breakouts} breakout</span> · <span class="num-cyan">📦 ${accum} accum</span> · <span class="num-red">⚠️ ${risk} risk</span>${gems ? ` · <span style="color:#a855f7;">💎 ${gems} gem${gems !== 1 ? 's' : ''}</span>` : ''}${favs ? ` · <span class="num-amber">⭐ ${favs} fav${favs !== 1 ? 's' : ''}</span>` : ''}`;
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

  // History tab: price stats + momentum + memecoin signal + metrics table
  const sig = token.memeSignal;
  const momRes = AppState.momentumResults?.[token.address] || null;
  const momHtml = momRes ? (() => {
    const sigs = { ...momRes.signals, ...momRes.advanced };
    const meta = typeof MomentumDetector !== 'undefined' ? MomentumDetector.SIGNAL_META : [];
    const gemClass = momRes.isGem ? 'gem-score-ring' : '';
    const scoreColor = momRes.momentumScore >= 75 ? '#a855f7' : momRes.momentumScore >= 60 ? 'var(--accent-green)' : momRes.momentumScore >= 35 ? 'var(--accent-amber)' : 'var(--text-muted)';
    return `<div class="drawer-momentum-block">
      <div class="dmb-header">
        <div style="display:flex;align-items:center;gap:8px;">
          ${momRes.isGem ? '<span style="font-size:18px;">💎</span>' : ''}
          <span style="font-size:13px;font-weight:700;color:${scoreColor};">${momRes.label}</span>
        </div>
        <div class="dmb-score" style="color:${scoreColor};">${momRes.momentumScore}<span style="font-size:11px;font-weight:400;color:var(--text-muted);">/100</span></div>
      </div>
      <div class="dmb-signals">
        ${meta.map(m => {
          const s = sigs[m.key];
          if (!s) return '';
          const color = s.active ? 'var(--accent-green)' : s.score > 30 ? 'var(--accent-amber)' : 'var(--text-muted)';
          return `<div class="dmb-signal-row">
            <span style="font-size:12px;">${m.icon}</span>
            <span style="font-size:11px;flex:1;color:var(--text-secondary);">${m.label}</span>
            <span style="font-size:10px;color:${color};font-weight:600;">${s.active ? '✅' : '—'} ${s.score}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  })() : '';

  document.getElementById('drawer-history-panel').innerHTML = `
    <div class="signal-history-stats">
      <div class="sh-stat"><div class="sh-stat-label">Pump Score</div><div class="sh-stat-value ${token.pumpScore >= 70 ? 'num-green' : 'num-amber'}">${token.pumpScore}/100</div></div>
      <div class="sh-stat"><div class="sh-stat-label">5m</div><div class="sh-stat-value ${token.priceChange.m5 >= 0 ? 'num-green' : 'num-red'}">${fmt.pct(token.priceChange.m5)}</div></div>
      <div class="sh-stat"><div class="sh-stat-label">1h</div><div class="sh-stat-value ${token.priceChange.h1 >= 0 ? 'num-green' : 'num-red'}">${fmt.pct(token.priceChange.h1)}</div></div>
      <div class="sh-stat"><div class="sh-stat-label">24h</div><div class="sh-stat-value ${ch24 >= 0 ? 'num-green' : 'num-red'}">${fmt.pct(ch24)}</div></div>
    </div>
    ${momHtml}
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

  // ── Smart Trades: Real DexScreener data + TP Prediction ──────
  const tx = token.txns || {};
  const vol = token.volume || {};
  const periods = [
    { label: '5m', buys: tx.m5?.buys || 0, sells: tx.m5?.sells || 0, vol: vol.m5 || 0 },
    { label: '1h', buys: tx.h1?.buys || 0, sells: tx.h1?.sells || 0, vol: vol.h1 || 0 },
    { label: '6h', buys: tx.h6?.buys || 0, sells: tx.h6?.sells || 0, vol: vol.h6 || 0 },
    { label: '24h', buys: tx.h24?.buys || 0, sells: tx.h24?.sells || 0, vol: vol.h24 || 0 }
  ];
  const h24Total = periods[3].buys + periods[3].sells;
  const buyPct = h24Total > 0 ? Math.round((periods[3].buys / h24Total) * 100) : 50;
  const buyPressureColor = buyPct >= 60 ? 'var(--accent-green)' : buyPct <= 40 ? 'var(--accent-red)' : 'var(--accent-amber)';

  // Run Monte Carlo TP prediction
  const tpZone = Scanner.HolderAnalysis.simulateTpZone(token);
  const tpHtml = tpZone ? `
    <div class="tp-prediction-card">
      <div class="tp-pred-header">
        <span>🎯 Whale TP Prediction</span>
        <span class="tp-confidence" style="color:var(--accent-cyan);">${tpZone.confidence}% confidence</span>
      </div>
      <div class="tp-pred-subtitle">Markov Chain + Monte Carlo (1,000 simulations) · Based on holder buy-ins</div>
      <div class="tp-zone-row">
        <div class="tp-zone-item">
          <div class="tp-zone-label">Conservative</div>
          <div class="tp-zone-val num-amber">${fmt.price(tpZone.lowPrice)}</div>
          <div class="tp-zone-mc">${fmt.vol(tpZone.lowMc)} MC</div>
        </div>
        <div class="tp-zone-item tp-zone-median">
          <div class="tp-zone-label">Most Likely</div>
          <div class="tp-zone-val num-green" style="font-size:15px;">${fmt.price(tpZone.medPrice)}</div>
          <div class="tp-zone-mc">${fmt.vol(tpZone.medMc)} MC</div>
        </div>
        <div class="tp-zone-item">
          <div class="tp-zone-label">Optimistic</div>
          <div class="tp-zone-val num-cyan">${fmt.price(tpZone.highPrice)}</div>
          <div class="tp-zone-mc">${fmt.vol(tpZone.highMc)} MC</div>
        </div>
      </div>
      <div class="tp-pred-info">
        Est. whale avg buy-in: <strong>${fmt.vol(tpZone.avgBuyInMc)}</strong> MC
        · Current: <strong>${fmt.vol(tpZone.currentMc)}</strong> MC
        · Upside to median TP: <strong class="num-green">+${tpZone.medMc > tpZone.currentMc ? ((tpZone.medMc / tpZone.currentMc - 1) * 100).toFixed(0) : '0'}%</strong>
      </div>
    </div>` : '';

  const stPanel = document.getElementById('drawer-smarttrades-panel');
  stPanel.innerHTML = `
    <div class="dex-source-badge">
      📊 Live data from <a href="${token.dexUrl}" target="_blank" style="color:var(--accent-cyan);">DexScreener</a>
      <span style="margin-left:auto;font-size:10px;color:var(--text-muted);">Pair: ${token.pairAddress ? token.pairAddress.slice(0, 8) + '…' : 'N/A'}</span>
    </div>

    <div class="buy-pressure-row">
      <span style="font-size:12px;font-weight:700;color:var(--accent-green);">Buys ${buyPct}%</span>
      <div class="buy-pressure-bar">
        <div class="buy-pressure-fill" style="width:${buyPct}%;background:${buyPressureColor};"></div>
      </div>
      <span style="font-size:12px;font-weight:700;color:var(--accent-red);">${100 - buyPct}% Sells</span>
    </div>

    <table class="smart-trades-table" style="margin-top:14px;">
      <thead><tr><th>Period</th><th>🟢 Buys</th><th>🔴 Sells</th><th>B/S Ratio</th><th>Volume</th></tr></thead>
      <tbody>${periods.map(p => {
    const total = p.buys + p.sells;
    const ratio = total > 0 ? (p.buys / Math.max(1, p.sells)).toFixed(2) : '—';
    const ratioColor = parseFloat(ratio) > 1 ? 'num-green' : parseFloat(ratio) < 1 ? 'num-red' : '';
    return `<tr>
          <td><strong>${p.label}</strong></td>
          <td class="num-green">${p.buys.toLocaleString()}</td>
          <td class="num-red">${p.sells.toLocaleString()}</td>
          <td class="${ratioColor}">${ratio}x</td>
          <td class="num-cyan">${fmt.vol(p.vol)}</td>
        </tr>`;
  }).join('')}</tbody>
    </table>

    ${tpHtml}

    <div id="tracked-wallets-alert"></div>

    <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:6px;">
      ${terminals.axiom ? `<a class="terminal-link axiom" href="${terminals.axiom}" target="_blank">Trade on Axiom</a>` : ''}
      ${terminals.gmgn ? `<a class="terminal-link gmgn" href="${terminals.gmgn}" target="_blank">gmgn.ai</a>` : ''}
      ${terminals.padre ? `<a class="terminal-link padre" href="${terminals.padre}" target="_blank">Padre</a>` : ''}
      ${terminals.bubbleMaps ? `<a class="terminal-link bubble" href="${terminals.bubbleMaps}" target="_blank">🛸 BubbleMaps</a>` : ''}
      <a class="terminal-link explorer" href="${terminals.explorer}" target="_blank">🔎 Explorer</a>
    </div>`;

  // Async: check if any tracked wallets hold this token
  if (token.address && token.chainId?.toLowerCase().includes('sol')) {
    WalletTracker.checkWalletHoldings(token.address).then(matches => {
      const alertEl = document.getElementById('tracked-wallets-alert');
      if (!alertEl || !matches.length) return;
      alertEl.innerHTML = `
        <div class="tracked-wallet-alert">
          🐋 <strong>${matches.length} tracked wallet${matches.length > 1 ? 's' : ''} hold this token!</strong>
          ${matches.map(m => `<div class="tracked-wallet-row">
            <span>${m.wallet.label}</span>
            <span class="num-cyan">${m.holding.amount.toLocaleString()} tokens</span>
          </div>`).join('')}
        </div>`;
    }).catch(() => { });
  }

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
  _initialized: false,

  init() {
    AuthManager.init();
    if (!AuthManager.isLoggedIn()) { showAuthPage(); return; }
    if (typeof showAppPage === 'function') showAppPage();

    // Clear any existing refresh interval from a previous init call
    if (AppState.liveRefreshInterval) {
      clearInterval(AppState.liveRefreshInterval);
      AppState.liveRefreshInterval = null;
    }

    if (!this._initialized) {
      this.setupNav();
      this.setupDrawer();
      this.setupAdminPanel();
      this._initialized = true;
    }

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
        if (t === 'whales') { if (typeof WhalesPanel !== 'undefined') WhalesPanel.render(); }
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
    if (sq) {
      sq.addEventListener('input', () => { AppState.scannerQuery = sq.value.trim().toLowerCase(); renderScannerCards(); });
      sq.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const q = sq.value.trim();
          if (q.length >= 32 || (q.length > 2 && !AppState.scannerTokens.find(t => t.name.toLowerCase().includes(q.toLowerCase()) || t.symbol.toLowerCase().includes(q.toLowerCase())))) {
            searchAndAddToken(q);
          }
        }
      });
    }
    const findBtn = document.getElementById('scanner-find-btn');
    if (findBtn) findBtn.addEventListener('click', () => {
      const q = (document.getElementById('scanner-search')?.value || '').trim();
      if (q) searchAndAddToken(q);
    });

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
    if (!overlay) return;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeAdminPanel(); });
    document.getElementById('admin-close-btn')?.addEventListener('click', closeAdminPanel);
    // The new invite generation is handled inside renderAdminPanel() from auth.js
  },

  gateFeatures() {
    const user = AuthManager.getUser();
    if (!user) return;
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(t => {
      const tab = t.dataset.tab;
      if (tab === 'scanner' && !user.features?.memeScanner) t.style.opacity = '0.4';
      if (tab === 'log' && !user.features?.tradingLog) t.style.opacity = '0.4';
      if (tab === 'whales' && !user.features?.whalesWallets) t.style.opacity = '0.4';
    });
  }
};

// ── Kick off ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());

// ── Copy CA + open trading terminal ──────────────────────────────
window.copyAndGo = function (addr, href, label) {
  const doOpen = () => window.open(href, '_blank', 'noopener');
  if (!addr) { doOpen(); return; }
  navigator.clipboard.writeText(addr).then(() => {
    showToast('📋', `CA Copied — Opening ${label || 'terminal'}`, addr.slice(0, 6) + '…' + addr.slice(-4), 'success');
    setTimeout(doOpen, 250);
  }).catch(() => {
    // Clipboard blocked — still open the link
    doOpen();
    showToast('📋', 'Tip', 'Enable clipboard access to auto-copy CA', 'info');
  });
};

// ── Badge info popover toggle ─────────────────────────────
window.toggleBadgeInfo = function () {
  const el = document.getElementById('badge-info-overlay');
  if (!el) return;
  el.classList.toggle('bi-hidden');
  document.body.style.overflow = el.classList.contains('bi-hidden') ? '' : 'hidden';
};

// Close popover on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const el = document.getElementById('badge-info-overlay');
    if (el && !el.classList.contains('bi-hidden')) {
      el.classList.add('bi-hidden');
      document.body.style.overflow = '';
    }
  }
});

// ── Copy contract address ────────────────────────────────
window.copyCa = function (address, btn) {
  if (!address) return;
  navigator.clipboard.writeText(address).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ Copied!';
    btn.style.color = 'var(--accent-green)';
    btn.style.borderColor = 'var(--accent-green)';
    setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 2000);
  }).catch(() => {
    // Fallback for browsers without clipboard API
    const ta = document.createElement('textarea');
    ta.value = address;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
};

// ── Price ↔ Market Cap toggle (MC is default — data-mc-mode="1") ──
window.toggleMcMode = function (addr) {
  const block = document.getElementById('msb-' + addr);
  if (!block) return;
  // mcMode='1' = showing MC (default); mcMode='0' = showing Price
  const isMc = block.dataset.mcMode !== '0';
  block.dataset.mcMode = isMc ? '0' : '1';
  const newIsMc = !isMc;
  // Price elements: msb-entry-p, msb-sl-p, msb-tp-p
  block.querySelectorAll('.msb-entry-p,.msb-sl-p,.msb-tp-p').forEach(el => {
    el.style.display = newIsMc ? 'none' : '';
  });
  // MC elements: msb-entry-mc, msb-sl-mc, msb-tp-mc
  block.querySelectorAll('.msb-entry-mc,.msb-sl-mc,.msb-tp-mc').forEach(el => {
    el.style.display = newIsMc ? 'inline' : 'none';
  });
  const btnPrice = block.querySelector('.mc-toggle-price');
  const btnMc    = block.querySelector('.mc-toggle-mc');
  if (btnPrice) btnPrice.style.display = newIsMc ? 'none'   : 'inline';
  if (btnMc)    btnMc.style.display    = newIsMc ? 'inline' : 'none';
};

// ══════════════════════════════════════════════════════════════
// TOOLTIP SYSTEM — uses position:fixed + body-level div so it
// is never clipped by card overflow:hidden
// ══════════════════════════════════════════════════════════════
(function initTooltip() {
  // Create singleton tooltip element
  const tip = document.createElement('div');
  tip.id = 'tcmd-tip';
  document.body.appendChild(tip);

  let _hideTimer = null;

  function show(target) {
    const text = target.dataset.tooltip;
    if (!text) return;
    clearTimeout(_hideTimer);
    tip.textContent = text;
    tip.classList.add('visible');
    reposition(target);
  }

  function reposition(target) {
    const r   = target.getBoundingClientRect();
    const tw  = tip.offsetWidth;
    const th  = tip.offsetHeight;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const GAP = 9;

    // Default: above the element, horizontally centred
    let top  = r.top  - th - GAP;
    let left = r.left + (r.width - tw) / 2;

    // Flip below if it would go off the top
    if (top < 6) top = r.bottom + GAP;
    // Flip above if it goes off the bottom
    if (top + th > vh - 6) top = r.top - th - GAP;

    // Clamp horizontally
    left = Math.max(8, Math.min(left, vw - tw - 8));

    tip.style.top  = top  + 'px';
    tip.style.left = left + 'px';
  }

  function hide() {
    _hideTimer = setTimeout(() => tip.classList.remove('visible'), 80);
  }

  // Event delegation — works on dynamically created cards
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tooltip]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-tooltip]');
    if (el) hide();
  });
  // Hide on scroll or any click
  document.addEventListener('scroll', () => tip.classList.remove('visible'), true);
  document.addEventListener('click',  () => tip.classList.remove('visible'), true);
})();

// ══════════════════════════════════════════════════════════════
// SIGNAL DOT POPUP — rich card shown on hover over sparkline signal marker
// ══════════════════════════════════════════════════════════════
(function initSigPopup() {
  const pop = document.createElement('div');
  pop.id = 'tcmd-sig-popup';
  pop.innerHTML = `
    <div class="sigpop-header">
      <span class="sigpop-icon">📡</span>
      <span class="sigpop-title">Signal Alert</span>
      <span class="sigpop-date" id="sigpop-date"></span>
    </div>
    <div class="sigpop-grid">
      <div class="sigpop-item">
        <div class="sigpop-label">MC at Signal</div>
        <div class="sigpop-value" id="sigpop-mc"></div>
      </div>
      <div class="sigpop-item">
        <div class="sigpop-label">Price at Signal</div>
        <div class="sigpop-value" id="sigpop-price"></div>
      </div>
      <div class="sigpop-item">
        <div class="sigpop-label">Max Gain</div>
        <div class="sigpop-value" id="sigpop-change"></div>
      </div>
    </div>
  `;
  document.body.appendChild(pop);

  // Smart price formatter for micro-cap meme coins
  function _fmtP(n) {
    n = parseFloat(n);
    if (!n || isNaN(n) || n <= 0) return '$—';
    if (n >= 100)   return `$${n.toFixed(2)}`;
    if (n >= 1)     return `$${n.toFixed(4)}`;
    if (n >= 0.01)  return `$${n.toFixed(6)}`;
    // Very small: find first significant decimals
    const dec = Math.min(Math.max(2 - Math.floor(Math.log10(n)), 4), 12);
    return `$${n.toFixed(dec)}`;
  }
  function _fmtMC(n) {
    n = parseFloat(n);
    if (!n || isNaN(n)) return '$—';
    if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  }

  function show(el) {
    const date   = el.getAttribute('data-sig-date')   || '';
    const price  = el.getAttribute('data-sig-price')  || '0';
    const mc     = el.getAttribute('data-sig-mc')     || '0';
    const change = parseFloat(el.getAttribute('data-sig-change') || '0');

    document.getElementById('sigpop-date').textContent  = date;
    document.getElementById('sigpop-mc').textContent    = _fmtMC(mc);
    document.getElementById('sigpop-price').textContent = _fmtP(price);

    const chEl = document.getElementById('sigpop-change');
    chEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    chEl.className   = 'sigpop-value ' + (change >= 0 ? 'sigpop-pos' : 'sigpop-neg');

    pop.classList.add('visible');
    reposition(el);
  }

  function reposition(el) {
    // For SVG elements, getBoundingClientRect() returns screen coords
    const r  = el.getBoundingClientRect ? el.getBoundingClientRect()
              : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    const pw = pop.offsetWidth  || 260;
    const ph = pop.offsetHeight || 90;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 14;

    let top  = r.top - ph - GAP;
    let left = r.left + (r.width - pw) / 2;

    if (top < 6)           top = r.bottom + GAP;  // flip below
    if (top + ph > vh - 6) top = r.top - ph - GAP; // flip above
    left = Math.max(8, Math.min(left, vw - pw - 8));

    pop.style.top  = top  + 'px';
    pop.style.left = left + 'px';
  }

  let _hideTimer = null;

  // Use hasAttribute('data-sig-date') instead of closest() — more reliable on SVG elements
  function findSigHit(node) {
    for (let i = 0; i < 4 && node && node !== document; i++) {
      if (node.hasAttribute && node.hasAttribute('data-sig-date')) return node;
      node = node.parentNode;
    }
    return null;
  }

  document.addEventListener('mouseover', e => {
    const hit = findSigHit(e.target);
    if (hit) { clearTimeout(_hideTimer); show(hit); }
  });
  document.addEventListener('mouseout', e => {
    const hit = findSigHit(e.target);
    if (hit) { _hideTimer = setTimeout(() => pop.classList.remove('visible'), 120); }
  });
  document.addEventListener('scroll', () => pop.classList.remove('visible'), true);
  document.addEventListener('click',  () => pop.classList.remove('visible'), true);
})();

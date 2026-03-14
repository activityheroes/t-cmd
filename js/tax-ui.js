/* ============================================================
   T-CMD — Swedish Crypto Tax UI v2
   Auto-updating pipeline, exception-only review,
   K4 per-asset report, full import status tracking.
   ============================================================ */

const TaxUI = (() => {

  // ── State ─────────────────────────────────────────────────
  const S = {
    page: 'portfolio',
    taxYear: TaxEngine.getSettings().taxYear,
    taxResult: null,
    txFilter: { search: '', category: 'all', account: 'all', dateFrom: '', dateTo: '', needsReview: false },
    txSort: { field: 'date', dir: 'desc' },
    txPage: 0,
    txPageSize: 50,
    importModal: null,
    importNetwork: null,  // selected network when multi-network wallet is chosen
    addAccountModal: false, // Koinly-style "add account" search modal
    walletModalTab: 'auto',      // 'auto' | 'empty'
    walletImportFrom: 'beginning', // 'beginning' | 'date'
    walletImportDate: '',          // ISO date string e.g. '2024-01-01'
    editTxId: null,
    calOpen: false,
    calField: null,
    calMonth: new Date().getMonth(),
    calYear: new Date().getFullYear(),
    pipelinePct: 0,
    pipelineMsg: '',
    pipelineRunning: false,
    // Portfolio dashboard
    portfolioSnap: null,   // live-price enriched snapshot
    portfolioHist: null,   // time-series history for chart
    portfolioRange: '1W',   // selected time range
    portfolioCharts: {},     // Chart.js instances { main, alloc, perf }
    portfolioRefreshTimer: null, // auto-refresh interval handle
    // Transaction selection
    selectedTxIds: new Set(),
    // Transaction expanded row & manual entry
    expandedTxId: null,
    expandedTxTab: 'description',   // 'description' | 'tax'
    manualTxRows: [],               // Array of { _id, type, label, wallet, date, sentAmt, sentCcy, recAmt, recCcy, feeAmt, feeCcy }
    addTxMenuOpen: false,           // add-transaction dropdown open
    txLabelFilter: 'all',           // active label filter pill
    txWalletFilter: 'all',          // active wallet filter pill (mirrors txFilter.account)
    userName: '',
    userPnr: '',
    _cloudSyncedAt: null,  // ISO timestamp of last successful cloud sync
    // Review page: which groups are collapsed (received_not_sold starts collapsed)
    collapsedGroups: new Set(['received_not_sold']),
  };

  let _pendingCSVText = null;
  let _pendingCSVParser = null;

  // ── Cloud sync event ──────────────────────────────────────
  // Fired by TaxEngine._pushTransactionsToCloud after a successful write.
  window.addEventListener('taxCloudSynced', ({ detail }) => {
    S._cloudSyncedAt = detail.syncedAt;
    // Update just the sync info bar if the accounts page is visible
    if (S.page === 'accounts') render();
  });

  // ── Pipeline Listener ─────────────────────────────────────
  function bindPipelineEvents() {
    TaxEngine.Events.on('pipeline:start', () => {
      S.pipelineRunning = true; S.pipelinePct = 0; S.pipelineMsg = 'Starting…';
      showPipelineBar();
    });
    TaxEngine.Events.on('pipeline:step', ({ pct, msg }) => {
      S.pipelinePct = pct; S.pipelineMsg = msg;
      updatePipelineBar(pct, msg);
    });
    TaxEngine.Events.on('pipeline:done', ({ totalTxns, reviewIssues }) => {
      S.pipelineRunning = false;
      S.taxResult = null; S.portfolioSnap = null; S.portfolioHist = null; // force recompute
      hidePipelineBar();
      render();
      showTaxToast('✅', 'Processing complete',
        `${totalTxns.toLocaleString()} transactions · ${reviewIssues} need review`);
    });
    TaxEngine.Events.on('pipeline:error', ({ message }) => {
      S.pipelineRunning = false;
      hidePipelineBar();
      showTaxToast('❌', 'Processing error', message, 'error');
    });
  }

  function showPipelineBar() {
    let bar = document.getElementById('tax-pipeline-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'tax-pipeline-bar';
      bar.className = 'tax-pipeline-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = pipelineBarHTML(0, 'Starting…');
    bar.style.display = 'flex';
  }
  function updatePipelineBar(pct, msg) {
    const bar = document.getElementById('tax-pipeline-bar');
    if (bar) bar.innerHTML = pipelineBarHTML(pct, msg);
  }
  function hidePipelineBar() {
    const bar = document.getElementById('tax-pipeline-bar');
    if (bar) { bar.style.opacity = '0'; setTimeout(() => { if (bar) bar.style.display = 'none'; bar.style.opacity = '1'; }, 600); }
  }
  function pipelineBarHTML(pct, msg) {
    return `
      <div class="tax-pb-icon">⚙️</div>
      <div class="tax-pb-content">
        <div class="tax-pb-msg">${msg}</div>
        <div class="tax-pb-track"><div class="tax-pb-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="tax-pb-pct">${pct}%</div>
    `;
  }

  // ── Utility Helpers ───────────────────────────────────────
  function timeAgoShort(iso) {
    if (!iso) return 'Never';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // ── Auto-run pipeline ─────────────────────────────────────
  async function triggerPipeline() {
    if (TaxEngine.isPipelineRunning()) return;
    try {
      await TaxEngine.runPipeline();
    } catch { }
  }

  // ── Root Render ───────────────────────────────────────────
  function render() {
    const panel = document.getElementById('tax-panel');
    if (!panel) return;
    let pageHTML = '';
    try {
      pageHTML = renderPage();
    } catch (e) {
      console.error('[TaxUI] renderPage error:', e);
      pageHTML = `<div style="padding:32px;color:#f87171;font-family:monospace">
        <strong>⚠️ Render error on page "${S.page}":</strong><br><br>
        <code>${e.message}</code><br><small>${e.stack?.split('\n').slice(0,3).join('<br>')}</small>
      </div>`;
    }
    panel.innerHTML = `
      <div class="tax-root">
        <aside class="tax-sidebar">${renderSidebar()}</aside>
        <main class="tax-main">${pageHTML}</main>
      </div>
    `;
    bindEvents();
  }

  function renderSidebar() {
    const txns = TaxEngine.getTransactions();
    const reviewCount = TaxEngine.getReviewIssues(txns).length;
    const years = TaxEngine.getAvailableTaxYears();
    const pages = [
      { id: 'portfolio',     icon: '💼', label: 'Portfolio' },
      { id: 'accounts',      icon: '🔗', label: 'Accounts' },
      { id: 'transactions',  icon: '📋', label: 'Transactions' },
      { id: 'review',        icon: '🔍', label: 'Review' },
      { id: 'reports',       icon: '📊', label: 'Reports' },
    ];
    return `
      <div class="tax-logo">
        <span class="tax-logo-icon">🇸🇪</span>
        <div>
          <div class="tax-logo-title">Tax Calculator</div>
          <div class="tax-logo-sub">Skatteverket · K4 · Genomsnittsmetoden</div>
        </div>
      </div>

      <div class="tax-year-select">
        <label>Inkomstår</label>
        <select id="tax-year-picker" class="tax-select">
          ${years.map(y => `<option value="${y}" ${y == S.taxYear ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>

      <nav class="tax-nav">
        ${pages.map(p => `
          <button class="tax-nav-item ${S.page === p.id ? 'active' : ''}" data-page="${p.id}">
            <span class="tax-nav-icon">${p.icon}</span>
            <span class="tax-nav-label">${p.label}</span>
            ${p.id === 'review' && reviewCount > 0 ? `<span class="tax-nav-badge">${reviewCount}</span>` : ''}
          </button>
        `).join('')}
      </nav>

      <div class="tax-sidebar-footer">
        <div class="tax-storage-info">
          <span>💾</span>
          <span>${txns.length.toLocaleString()} transactions</span>
        </div>
        ${S.pipelineRunning ? `<div class="tax-sidebar-syncing">⚙️ Processing…</div>` : ''}
      </div>
    `;
  }

  function renderPage() {
    switch (S.page) {
      case 'portfolio': return renderPortfolio();
      case 'accounts': return renderAccounts();
      case 'transactions': return renderTransactions();
      case 'review': return renderReview();
      case 'reports': return renderReports();
      default: return renderPortfolio();
    }
  }

  // ════════════════════════════════════════════════════════════
  // PORTFOLIO PAGE  — full dashboard with charts
  // ════════════════════════════════════════════════════════════
  function renderPortfolio() {
    const result = getOrComputeTaxResult();
    const { summary, currentHoldings } = result;
    const issues = TaxEngine.getReviewIssues().length;
    const snap = S.portfolioSnap;
    const totalVal = snap ? snap.totalValueSEK : null;
    const unrealized = snap ? snap.totalUnrealizedSEK : null;
    const fiatIn = snap ? snap.fiatInvestedSEK : null;
    const fiatOut = snap ? snap.fiatProceedsSEK : null;
    const fees = snap ? snap.totalFeesSEK : null;
    const totalReturn = snap ? (unrealized || 0) + summary.netGainLoss : null;
    const fmtVal = v => v !== null ? TaxEngine.formatSEK(v) : '<span class="tax-port-loading-val">—</span>';
    const fmtPct = p => p !== null
      ? `<span class="${p >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">${p >= 0 ? '+' : ''}${p.toFixed(2)}%</span>` : '—';

    // Holdings for assets table (snap-enriched if available, else raw)
    const tableHoldings = snap ? snap.holdings : currentHoldings.map(h => ({
      ...h, currentPriceSEK: null, currentValueSEK: null, unrealizedSEK: null,
      unrealizedPct: null, changePercent24Hr: null,
    }));
    // Sort by current value desc (or cost basis if no live price)
    const sortedHoldings = [...tableHoldings].sort((a, b) =>
      (b.currentValueSEK ?? b.totalCostSEK) - (a.currentValueSEK ?? a.totalCostSEK));

    // Trigger async chart init after DOM is painted
    setTimeout(initPortfolioCharts, 0);

    return `
      <div class="tax-page tax-page--portfolio">

        <!-- ── Review banner ──────────────────────────────── -->
        ${issues > 0 ? `
        <div class="tax-review-banner" onclick="TaxUI.navigate('review')">
          <span>⚠️</span>
          <span><strong>${issues} transaktioner</strong> behöver granskning — skatteberäkningen kan vara ofullständig</span>
          <span class="tax-rb-link">Åtgärda →</span>
        </div>` : ''}

        <!-- ── HERO: balance + chart ───────────────────────── -->
        <div class="tax-port-top">

          <!-- Left: hero balance + chart -->
          <div class="tax-port-chart-card">
            <div class="tax-port-hero">
              <div class="tax-port-hero-label">Total balans</div>
              <div class="tax-port-hero-val" id="tax-port-total-val">
                ${totalVal !== null ? TaxEngine.formatSEK(totalVal) : '<span class="tax-port-loading-val">Hämtar…</span>'}
              </div>
              ${totalReturn !== null ? `
              <div class="tax-port-hero-sub ${totalReturn >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">
                ${totalReturn >= 0 ? '▲' : '▼'} ${TaxEngine.formatSEK(Math.abs(totalReturn))} total avkastning
              </div>` : ''}
            </div>
            <div class="tax-port-chart-wrap">
              <canvas id="tax-port-chart" height="180"></canvas>
              <div class="tax-port-chart-overlay" id="tax-port-overlay" style="display:none">Laddar diagram…</div>
            </div>
            <div class="tax-port-time-row">
              ${['1D', '1W', '1M', '1Y', 'YTD', 'All'].map(r => `
                <button class="tax-port-tb ${S.portfolioRange === r ? 'active' : ''}"
                  onclick="TaxUI.portSetRange('${r}')">${r}</button>`).join('')}
              <span style="flex:1"></span>
              <span class="tax-port-legend-dot" style="background:#6366f1"></span>
              <span class="tax-port-legend-lbl">Marknadsvärde</span>
              <span class="tax-port-legend-dot" style="background:rgba(148,163,184,0.4)"></span>
              <span class="tax-port-legend-lbl">Investerat</span>
            </div>
          </div>

          <!-- Right: performance summary -->
          <div class="tax-port-summary-panel">
            <div class="tax-port-sum-title">Prestanda <span class="tax-port-auto-tag">🔄 Live</span></div>

            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">24h P&amp;L</span>
              <span class="tax-port-sum-val" id="tax-ps-24h"><span class="tax-port-loading-val">—</span></span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Orealiserad vinst</span>
              <span class="tax-port-sum-val ${unrealized !== null ? (unrealized >= 0 ? 'tax-port-pos' : 'tax-port-neg') : ''}"
                id="tax-ps-unrealized">${fmtVal(unrealized)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Investerat kapital</span>
              <span class="tax-port-sum-val" id="tax-ps-fiatin">${fmtVal(fiatIn)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Realiserade intäkter</span>
              <span class="tax-port-sum-val" id="tax-ps-fiatout">${fmtVal(fiatOut)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Avgifter betalda</span>
              <span class="tax-port-sum-val" id="tax-ps-fees">${fmtVal(fees)}</span>
            </div>

            <!-- Quick tax stat -->
            <div class="tax-port-sum-div" style="margin-top:auto"></div>
            <div class="tax-port-tax-pill">
              <span class="tax-port-tax-pill-lbl">Skatt ${S.taxYear} (est. 30%)</span>
              <span class="tax-port-tax-pill-val tax-red">${TaxEngine.formatSEK(summary.estimatedTax)}</span>
            </div>
          </div>

        </div>

        <!-- ── STAT CARDS ──────────────────────────────────── -->
        <div class="tax-stat-grid">
          <div class="tax-stat-card">
            <div class="tax-stat-label">Tillgångar</div>
            <div class="tax-stat-value">${currentHoldings.length} st</div>
          </div>
          <div class="tax-stat-card ${summary.netGainLoss >= 0 ? 'gain' : 'loss'}">
            <div class="tax-stat-label">Nettovinst/-förlust ${S.taxYear}</div>
            <div class="tax-stat-value">${TaxEngine.formatSEK(summary.netGainLoss)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Realiserad vinst ${S.taxYear}</div>
            <div class="tax-stat-value ${summary.totalGains >= 0 ? 'tax-port-pos' : ''}">${TaxEngine.formatSEK(summary.totalGains || 0)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Transaktioner ${S.taxYear}</div>
            <div class="tax-stat-value">${summary.totalTransactions.toLocaleString()}</div>
          </div>
        </div>

        <!-- ── CHARTS ROW: donut + winners/losers ─────────── -->
        <div class="tax-port-mid">
          <div class="tax-chart-card">
            <div class="tax-chart-card-title">Tillgångsfördelning</div>
            <div class="tax-alloc-inner">
              <div class="tax-alloc-donut-wrap">
                <canvas id="tax-alloc-chart"></canvas>
                <div class="tax-alloc-center" id="tax-alloc-center">
                  <div class="tax-alloc-center-lbl">Alla</div>
                  <div class="tax-alloc-center-val" id="tax-alloc-total">
                    ${totalVal !== null ? TaxEngine.formatSEK(totalVal) : TaxEngine.formatSEK(currentHoldings.reduce((s, h) => s + h.totalCostSEK, 0))}
                  </div>
                </div>
              </div>
              <div class="tax-alloc-legend" id="tax-alloc-legend">
                ${sortedHoldings.slice(0, 8).map((h, _, arr) => {
      const total = arr.reduce((s, x) => s + (x.currentValueSEK ?? x.totalCostSEK), 0);
      const val = h.currentValueSEK ?? h.totalCostSEK;
      const pct = total > 0 ? (val / total * 100).toFixed(0) : 0;
      return `<div class="tax-alloc-row">
                    <img class="tax-alloc-icon" src="https://assets.coincap.io/assets/icons/${h.symbol.toLowerCase()}@2x.png"
                         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                         alt="${h.symbol}">
                    <span class="tax-asset-icon" style="display:none;font-size:9px">${h.symbol.slice(0, 3)}</span>
                    <span class="tax-alloc-sym">${h.symbol}</span>
                    <span class="tax-alloc-pct">${pct}%</span>
                    <span class="tax-alloc-val">${TaxEngine.formatSEK(val)}</span>
                  </div>`;
    }).join('')}
                ${sortedHoldings.length > 8 ? `<div class="tax-alloc-row tax-alloc-other">
                  <span class="tax-asset-icon" style="font-size:9px">…</span>
                  <span class="tax-alloc-sym">Övriga</span>
                  <span class="tax-alloc-pct">&lt;1%</span>
                  <span class="tax-alloc-val">${TaxEngine.formatSEK(sortedHoldings.slice(8).reduce((s, h) => s + (h.currentValueSEK ?? h.totalCostSEK), 0))}</span>
                </div>` : ''}
              </div>
            </div>
          </div>
          <div class="tax-chart-card">
            <div class="tax-chart-card-title" id="tax-perf-title">Vinnare och förlorare</div>
            <div class="tax-perf-wrap">
              <canvas id="tax-perf-chart"></canvas>
              <p id="tax-perf-loading" class="tax-port-loading-val"
                 style="padding:12px 0;font-size:12px;${snap ? 'display:none' : ''}">Hämtar priser…</p>
            </div>
            <div id="tax-perf-note" class="tax-port-accuracy-note"
                 style="${snap && !tableHoldings.some(h => h.unrealizedPct === null) ? 'display:none' : ''}">
              ⓘ Förbättra noggrannheten genom att kategorisera transaktioner
            </div>
          </div>
        </div>

        <!-- ── ASSETS TABLE ────────────────────────────────── -->
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>Mina tillgångar</h2>
            <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
              <input class="tax-search-input" id="tax-asset-search" placeholder="Sök tillgång…"
                oninput="TaxUI.filterAssets(this.value)">
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()" title="Beräkna om">⚙</button>
            </div>
          </div>
          ${sortedHoldings.length === 0
        ? renderEmpty('Inga tillgångar', 'Importera transaktioner för att se din portfölj.', '💼')
        : `<div class="tax-table-wrap"><table class="tax-table">
                <thead><tr>
                  <th>Tillgång</th>
                  <th class="ta-r">Aktuellt pris</th>
                  <th class="ta-r">Kostnadsbas</th>
                  <th class="ta-r">Innehav</th>
                  <th class="ta-r">Vinst / Förlust</th>
                  <th class="ta-r">24h</th>
                </tr></thead>
                <tbody id="tax-assets-tbody">
                  ${sortedHoldings.map(renderAssetRow).join('')}
                </tbody>
              </table></div>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" style="margin-top:10px"
                onclick="TaxUI.toggleSmallBalances()">Visa tokens med litet saldo ▾</button>`
      }
        </div>
      </div>
    `;
  }

  function renderAssetRow(h) {
    // Resolve the best available display name for the symbol.
    // Priority: (1) h.assetName set by async DexScreener lookup or static map,
    //           (2) resolveTokenDisplay static lookup, (3) raw symbol as fallback.
    const td = TaxEngine.resolveTokenDisplay(h.symbol);
    const displaySym = td.symbol || h.symbol;  // may be "JUP" instead of "JUPYIWRY"
    const resolvedName = h.assetName && h.assetName !== h.symbol
      ? h.assetName      // already enriched (from engine or async lookup)
      : (td.name || null); // static map hit
    const displayName = resolvedName || displaySym; // fallback to symbol if truly unknown

    const price = h.currentPriceSEK;
    const value = h.currentValueSEK;
    const ugl = h.unrealizedSEK;
    const uglPct = h.unrealizedPct;
    const ch24 = h.changePercent24Hr;
    const ch24sek = h.change24hSEK;
    // Use resolved (clean) symbol for the CoinCap icon URL
    const icon = `https://assets.coincap.io/assets/icons/${displaySym.toLowerCase()}@2x.png`;
    return `<tr>
      <td>
        <div class="tax-asset-cell">
          <img class="tax-alloc-icon" src="${icon}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt="${displaySym}">
          <span class="tax-asset-icon" style="display:none;font-size:9px">${displaySym.slice(0, 3)}</span>
          <div>
            <div class="tax-asset-sym">${displayName}</div>
            <div class="tax-asset-name">${displaySym}</div>
          </div>
        </div>
      </td>
      <td class="ta-r tax-mono">${price !== null ? TaxEngine.formatSEK(price, 2) : '<span class="tax-port-loading-val">—</span>'}</td>
      <td class="ta-r tax-mono">${TaxEngine.formatSEK(h.totalCostSEK)}</td>
      <td class="ta-r">
        <div class="tax-mono">${value !== null ? TaxEngine.formatSEK(value) : '<span class="tax-port-loading-val">—</span>'}</div>
        <div class="tax-asset-qty">${TaxEngine.formatCrypto(h.quantity)} ${displaySym}</div>
      </td>
      <td class="ta-r">
        ${ugl !== null
        ? `<div class="tax-mono ${ugl >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">${ugl >= 0 ? '+' : ''}${TaxEngine.formatSEK(ugl)}</div>
             <div class="${uglPct >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">${uglPct >= 0 ? '+' : ''}${uglPct.toFixed(2)}%</div>`
        : '<span class="tax-port-loading-val">—</span>'}
      </td>
      <td class="ta-r">
        ${ch24 !== null
        ? `<div class="tax-mono tax-24h-sek ${ch24 >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">${ch24sek >= 0 ? '+' : ''}${TaxEngine.formatSEK(ch24sek)}</div>
           <div class="tax-24h-pct ${ch24 >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%</div>`
        : '<span class="tax-port-loading-val">—</span>'}
      </td>
    </tr>`;
  }

  // ── Portfolio chart initialisation (async, fires after render) ───────
  async function initPortfolioCharts() {
    if (S.page !== 'portfolio') return;

    // Destroy stale Chart.js instances before touching canvases
    destroyPortfolioCharts();

    const canvasMain = document.getElementById('tax-port-chart');
    const canvasAlloc = document.getElementById('tax-alloc-chart');
    const canvasPerf = document.getElementById('tax-perf-chart');
    if (!canvasMain) return; // user navigated away

    // If we already have a fresh snapshot (< 5 min), skip the API calls
    const FRESH_MS = 5 * 60 * 1000;
    const needsFetch = !S.portfolioSnap || (Date.now() - S.portfolioSnap.fetchedAt) > FRESH_MS;

    if (needsFetch) {
      const overlay = document.getElementById('tax-port-overlay');
      if (overlay) overlay.style.display = 'flex';

      const result = getOrComputeTaxResult();
      const allTxns = TaxEngine.getTransactions();
      const symbols = result.currentHoldings.map(h => h.symbol);

      // Fetch live prices and FX in parallel
      const [livePrices, sekRate] = await Promise.all([
        TaxEngine.fetchLivePrices(symbols),
        TaxEngine.fetchLiveSEKRate(),
      ]);

      if (S.page !== 'portfolio') return; // navigated away during fetch

      S.portfolioSnap = TaxEngine.buildPortfolioSnapshot(
        result.currentHoldings, livePrices, sekRate, allTxns
      );
      S.portfolioHist = TaxEngine.buildPortfolioHistory(allTxns, TaxEngine.getPriceCache());

      // Fallback: if no cached prices found for user's holdings, use cost-basis history
      // (always computable from transaction data — no external prices needed)
      if (!S.portfolioHist?.length) {
        S.portfolioHist = TaxEngine.buildCostBasisHistory(allTxns);
      }

      // Patch live values into DOM without full re-render (preserves canvas elements)
      _patchPortfolioDOM(S.portfolioSnap, result.summary);
      if (overlay) overlay.style.display = 'none';
    }

    // Re-check canvases — might have been removed during DOM patch
    if (!document.getElementById('tax-port-chart')) return;

    // Safety: if hist still empty (e.g. data loaded from cache but no prices), use cost basis
    if (!S.portfolioHist?.length) {
      const allTxns2 = TaxEngine.getTransactions();
      S.portfolioHist = TaxEngine.buildCostBasisHistory(allTxns2);
    }

    // Draw charts
    S.portfolioCharts.main = _drawMainChart(canvasMain, S.portfolioHist, S.portfolioRange);
    S.portfolioCharts.alloc = _drawAllocChart(canvasAlloc, S.portfolioSnap);
    S.portfolioCharts.perf = _drawPerfChart(canvasPerf, S.portfolioSnap);

    // Auto-refresh: re-fetch live prices every 5 minutes
    if (S.portfolioRefreshTimer) clearInterval(S.portfolioRefreshTimer);
    S.portfolioRefreshTimer = setInterval(async () => {
      if (S.page !== 'portfolio') {
        clearInterval(S.portfolioRefreshTimer);
        S.portfolioRefreshTimer = null;
        return;
      }
      S.portfolioSnap = null; // force full re-fetch
      await initPortfolioCharts();
    }, 5 * 60 * 1000);

    // Async: look up human-readable names for any holdings still showing
    // raw mint-prefix symbols (e.g. "A2CAQTDE") via DexScreener (cached 7 days).
    if (S.portfolioSnap) {
      const unknownSyms = S.portfolioSnap.holdings
        .filter(h => !h.assetName || h.assetName === h.symbol)
        .map(h => h.symbol);
      if (unknownSyms.length) {
        TaxEngine.resolveUnknownTokenNames(unknownSyms).then(nameCache => {
          if (S.page !== 'portfolio' || !S.portfolioSnap) return;
          let changed = false;
          S.portfolioSnap.holdings = S.portfolioSnap.holdings.map(h => {
            const entry = nameCache[(h.symbol || '').toUpperCase()];
            if (entry?.name && entry.name !== h.assetName) {
              changed = true;
              return {
                ...h,
                symbol: entry.symbol || h.symbol,
                assetName: entry.name,
              };
            }
            return h;
          });
          if (changed) {
            // Re-render just the assets table (no chart flicker)
            const tbody = document.getElementById('tax-assets-tbody');
            if (tbody) {
              const sorted = [...S.portfolioSnap.holdings].sort(
                (a, b) => (b.currentValueSEK ?? b.totalCostSEK) - (a.currentValueSEK ?? a.totalCostSEK)
              );
              tbody.innerHTML = sorted.map(renderAssetRow).join('');
            }
          }
        }).catch(() => { });
      }
    }
  }

  function _patchPortfolioDOM(snap, summary) {
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const fmt = v => TaxEngine.formatSEK(v);
    const fmtClass = (v, id) => {
      const el = document.getElementById(id); if (!el) return;
      el.innerHTML = fmt(v);
      el.className = 'tax-port-sum-val ' + (v >= 0 ? 'tax-port-pos' : 'tax-port-neg');
    };
    // When live prices aren't available for the user's holdings (e.g. unknown tokens),
    // totalValueSEK stays 0. Fall back to total cost basis so the headline isn't 0 kr.
    const hasLivePrices = snap.totalValueSEK > 0;
    const displayTotalSEK = hasLivePrices ? snap.totalValueSEK : snap.totalCostSEK;
    const totalReturn = (snap.totalUnrealizedSEK || 0) + (summary.netGainLoss || 0);

    // Update the "TOTAL VALUE" label to indicate when we're showing cost basis
    const valLabelEl = document.querySelector('.tax-port-val-label');
    if (valLabelEl) valLabelEl.textContent = hasLivePrices ? 'TOTAL VALUE' : 'COST BASIS';

    // Clear the "Loading prices…" spinner and accuracy note in the perf chart area
    const perfLoading = document.getElementById('tax-perf-loading');
    if (perfLoading) perfLoading.style.display = 'none';

    // Compute total 24h P&L from holdings
    const total24hSEK = snap.holdings.reduce((s, h) => s + (h.change24hSEK ?? 0), 0);
    const has24h = snap.holdings.some(h => h.change24hSEK != null);
    if (has24h) {
      const el24 = document.getElementById('tax-ps-24h');
      if (el24) {
        el24.innerHTML = `<span class="${total24hSEK >= 0 ? 'tax-port-pos' : 'tax-port-neg'}">${total24hSEK >= 0 ? '+' : ''}${TaxEngine.formatSEK(total24hSEK)}</span>`;
      }
    }
    set('tax-port-total-val', fmt(displayTotalSEK));
    set('tax-ps-return', fmt(totalReturn));
    fmtClass(snap.totalUnrealizedSEK, 'tax-ps-unrealized');
    set('tax-ps-fiatin', fmt(snap.fiatInvestedSEK));
    set('tax-ps-fiatout', fmt(snap.fiatProceedsSEK));
    set('tax-ps-fees', fmt(snap.totalFeesSEK));
    set('tax-alloc-total', fmt(displayTotalSEK));
    // Update assets table rows
    const tbody = document.getElementById('tax-assets-tbody');
    if (tbody) {
      const sorted = [...snap.holdings].sort((a, b) =>
        (b.currentValueSEK ?? b.totalCostSEK) - (a.currentValueSEK ?? a.totalCostSEK));
      tbody.innerHTML = sorted.map(renderAssetRow).join('');
    }
  }

  function _drawMainChart(canvas, hist, range) {
    if (!hist?.length || typeof Chart === 'undefined') return null;

    // Ensure canvas has a CSS height so Chart.js can measure the container correctly.
    // Without this, responsive mode may read 0px height when the parent flex height
    // isn't resolved yet.
    if (!canvas.style.height) canvas.style.height = '200px';

    const isCostBasis = !!(hist[0]?.isCostBasis); // true when using fallback history
    const now = new Date();
    const cutoff = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365, 'YTD': null, 'All': 99999 };
    const days = cutoff[range] ?? 99999;
    let filtered = hist;
    if (range === 'YTD') {
      filtered = hist.filter(p => p.date >= `${now.getFullYear()}-01-01`);
    } else if (days < 99999) {
      const from = new Date(now); from.setDate(from.getDate() - days);
      const fromStr = from.toISOString().slice(0, 10);
      filtered = hist.filter(p => p.date >= fromStr);
    }
    if (!filtered.length) filtered = hist.slice(-3); // show last few if range is too short

    const labels = filtered.map(p => {
      const d = new Date(p.date);
      return d.toLocaleDateString('sv-SE', { month: 'short', year: filtered.length > 24 ? '2-digit' : undefined });
    });
    const values = filtered.map(p => p.valueSEK);

    const ctx = canvas.getContext('2d');
    // Use teal tint for cost-basis fallback, indigo for live values
    const lineColor = isCostBasis ? '#2dd4bf' : '#6366f1';
    const gradTop = isCostBasis ? 'rgba(45,212,191,0.30)' : 'rgba(99,102,241,0.35)';
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, gradTop);
    grad.addColorStop(1, isCostBasis ? 'rgba(45,212,191,0)' : 'rgba(99,102,241,0)');

    return new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: isCostBasis ? 'Cost basis (no price data)' : 'Total value',
          data: values,
          borderColor: lineColor,
          backgroundColor: grad,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: lineColor,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            titleColor: '#94a3b8',
            bodyColor: '#f1f5f9',
            borderColor: 'rgba(99,102,241,0.3)',
            borderWidth: 1,
            callbacks: {
              label: ctx => ' ' + TaxEngine.formatSEK(ctx.parsed.y),
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 11 } }, border: { display: false } },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' }, ticks: {
              color: '#64748b', font: { size: 11 },
              callback: v => TaxEngine.formatSEK(v, 0)
            }, border: { display: false }
          },
        },
      },
    });
  }

  // Colour palette matching the dark design
  const ALLOC_COLORS = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#e0d9ff',
    '#4f46e5', '#7c3aed', '#9333ea', '#a855f7', '#c084fc'];

  function _drawAllocChart(canvas, snap) {
    if (!canvas || !snap || typeof Chart === 'undefined') return null;
    const holdings = [...snap.holdings]
      .filter(h => (h.currentValueSEK ?? h.totalCostSEK) > 0)
      .sort((a, b) => (b.currentValueSEK ?? b.totalCostSEK) - (a.currentValueSEK ?? a.totalCostSEK));
    if (!holdings.length) return null;

    const top = holdings.slice(0, 8);
    const others = holdings.slice(8);
    const labels = [...top.map(h => h.symbol), ...(others.length ? ['Other'] : [])];
    const values = [...top.map(h => h.currentValueSEK ?? h.totalCostSEK),
    ...(others.length ? [others.reduce((s, h) => s + (h.currentValueSEK ?? h.totalCostSEK), 0)] : [])];

    return new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values, backgroundColor: ALLOC_COLORS, borderWidth: 2,
          borderColor: '#111827', hoverBorderColor: '#1e293b'
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b', titleColor: '#94a3b8', bodyColor: '#f1f5f9',
            borderColor: 'rgba(99,102,241,0.3)', borderWidth: 1,
            callbacks: {
              label: ctx => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                return ` ${TaxEngine.formatSEK(ctx.parsed)}  (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  function _drawPerfChart(canvas, snap) {
    if (!canvas || !snap || typeof Chart === 'undefined') return null;

    // Ensure canvas has a measurable height before Chart.js reads it.
    // Without this, maintainAspectRatio:false + flex parent = 0px canvas.
    if (!canvas.style.height) canvas.style.height = '200px';

    const withPct = snap.holdings
      .filter(h => h.unrealizedPct !== null)
      .sort((a, b) => (b.unrealizedPct || 0) - (a.unrealizedPct || 0));

    // ── Fallback: no live prices available ───────────────────
    // Show top holdings by % of total invested cost so the chart is always
    // useful even when CoinCap can't price the user's tokens.
    if (!withPct.length) {
      const titleEl = document.getElementById('tax-perf-title');
      if (titleEl) titleEl.textContent = 'Top holdings by cost';
      const noteEl = document.getElementById('tax-perf-note');
      if (noteEl) noteEl.textContent = 'ⓘ Live prices unavailable — showing cost basis allocation';

      const byBasis = [...snap.holdings]
        .filter(h => h.totalCostSEK > 0)
        .sort((a, b) => b.totalCostSEK - a.totalCostSEK)
        .slice(0, 8);
      if (!byBasis.length) return null;

      const total = byBasis.reduce((s, h) => s + h.totalCostSEK, 0);
      const labels = byBasis.map(h => {
        const td = TaxEngine.resolveTokenDisplay(h.symbol);
        return td.symbol || h.symbol;
      });
      const values = byBasis.map(h => parseFloat((h.totalCostSEK / total * 100).toFixed(1)));

      return new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            data: values, backgroundColor: 'rgba(99,102,241,0.75)',
            borderRadius: 4, borderWidth: 0
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1e293b', titleColor: '#94a3b8', bodyColor: '#f1f5f9',
              borderColor: 'rgba(99,102,241,0.3)', borderWidth: 1,
              callbacks: {
                label: ctx => {
                  const h = byBasis[ctx.dataIndex];
                  return ` ${ctx.parsed.x}%  (${TaxEngine.formatSEK(h.totalCostSEK)})`;
                },
              },
            },
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.04)' }, ticks: {
                color: '#64748b', font: { size: 11 },
                callback: v => `${v}%`
              }, border: { display: false }, max: 100
            },
            y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 12 } }, border: { display: false } },
          },
        },
      });
    }

    // ── Live-price path: show unrealized P/L % winners and losers ─
    const titleEl = document.getElementById('tax-perf-title');
    if (titleEl) titleEl.textContent = 'Winners and losers';
    const noteEl = document.getElementById('tax-perf-note');
    if (noteEl) noteEl.style.display = withPct.every(h => h.unrealizedPct !== null) ? 'none' : '';

    const top = withPct.slice(0, 5);
    const bot = withPct.slice(-Math.min(4, Math.max(0, withPct.length - top.length))).reverse();
    const items = [...new Map([...top, ...bot].map(h => [h.symbol, h])).values()];

    const labels = items.map(h => { const td = TaxEngine.resolveTokenDisplay(h.symbol); return td.symbol || h.symbol; });
    const values = items.map(h => h.unrealizedPct ?? 0);
    const colors = values.map(v => v >= 0 ? 'rgba(74,222,128,0.8)' : 'rgba(248,113,113,0.8)');

    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, borderWidth: 0 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b', titleColor: '#94a3b8', bodyColor: '#f1f5f9',
            borderColor: 'rgba(99,102,241,0.3)', borderWidth: 1,
            callbacks: {
              label: ctx => ` ${ctx.parsed.x >= 0 ? '+' : ''}${ctx.parsed.x.toFixed(2)}%`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' }, ticks: {
              color: '#64748b', font: { size: 11 },
              callback: v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`
            }, border: { display: false }
          },
          y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 12 } }, border: { display: false } },
        },
      },
    });
  }

  function destroyPortfolioCharts() {
    Object.values(S.portfolioCharts).forEach(c => { try { c?.destroy(); } catch { } });
    S.portfolioCharts = {};
  }

  function portSetRange(range) {
    S.portfolioRange = range;
    // Redraw only the main chart if it exists
    destroyPortfolioCharts();
    const c = document.getElementById('tax-port-chart');
    if (c && S.portfolioHist) {
      S.portfolioCharts.main = _drawMainChart(c, S.portfolioHist, range);
    }
    const ca = document.getElementById('tax-alloc-chart');
    if (ca && S.portfolioSnap) S.portfolioCharts.alloc = _drawAllocChart(ca, S.portfolioSnap);
    const cp = document.getElementById('tax-perf-chart');
    if (cp && S.portfolioSnap) S.portfolioCharts.perf = _drawPerfChart(cp, S.portfolioSnap);
    // Update active button styles
    document.querySelectorAll('.tax-port-tb').forEach(b => {
      b.classList.toggle('active', b.textContent.trim() === range);
    });
  }

  function filterAssets(query) {
    const q = (query || '').toLowerCase();
    const tbody = document.getElementById('tax-assets-tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = !q || text.includes(q) ? '' : 'none';
    });
  }

  let _showSmallBalances = false;
  function toggleSmallBalances() {
    _showSmallBalances = !_showSmallBalances;
    const THRESHOLD_SEK = 10;
    const tbody = document.getElementById('tax-assets-tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(row => {
      const costCell = row.cells[2];
      if (!costCell) return;
      // parse SEK value from cost column
      const raw = costCell.textContent.replace(/[^\d,.]/g, '').replace(',', '.');
      const val = parseFloat(raw) || 0;
      if (val < THRESHOLD_SEK) row.style.display = _showSmallBalances ? '' : 'none';
    });
  }

  // ════════════════════════════════════════════════════════════
  // ACCOUNTS PAGE
  // ════════════════════════════════════════════════════════════

  // All account source types — wallets, blockchains, exchanges, services
  const ACC_SOURCES = [
    // ── Wallets ──────────────────────────────────────────────
    { type: 'metamask',    icon: '🦊',  name: 'MetaMask',       category: 'wallets',    tag: 'popular', desc: 'Ethereum & EVM networks', color: '#e2761b',
      networks: [
        { id: 'eth',     label: 'Ethereum', icon: 'Ξ',  chain: 'eth' },
        { id: 'polygon', label: 'Polygon',  icon: '🔷', chain: 'eth', chainId: 137 },
        { id: 'base',    label: 'Base',     icon: '🔵', chain: 'eth', chainId: 8453 },
        { id: 'monad',   label: 'Monad',    icon: '🟣', chain: 'eth', chainId: 41454 },
      ] },
    { type: 'phantom',     icon: '👻',  name: 'Phantom',        category: 'wallets',    tag: 'popular', desc: 'Solana & Ethereum wallet', color: '#ab9ff2',
      networks: [{ id: 'sol', label: 'Solana', icon: '◎', chain: 'sol' }, { id: 'eth', label: 'Ethereum', icon: 'Ξ', chain: 'eth' }] },
    { type: 'solflare',    icon: '☀️',  name: 'Solflare',       category: 'wallets',    tag: '',        desc: 'Solana wallet',            color: '#fc7227',
      networks: [{ id: 'sol', label: 'Solana', icon: '◎', chain: 'sol' }] },
    { type: 'sui',         icon: '💧',  name: 'Sui Wallet',     category: 'wallets',    tag: '',        desc: 'Sui network',              color: '#4DA2FF',
      networks: [{ id: 'sui', label: 'Sui', icon: '💧', chain: 'sui' }] },
    { type: 'ledger',      icon: '🔐',  name: 'Ledger',         category: 'wallets',    tag: 'popular', desc: 'Hardware wallet (CSV)',    color: '#00c4b4', networks: [] },
    { type: 'trezor',      icon: '🛡️', name: 'Trezor',         category: 'wallets',    tag: '',        desc: 'Hardware wallet (CSV)',    color: '#1a9b3c', networks: [] },
    // ── Blockchains ───────────────────────────────────────────
    { type: 'ethereum_bc', icon: '🔷',  name: 'Ethereum',       category: 'blockchains',tag: 'popular', desc: 'EVM address import',       color: '#627EEA', networks: [{ id: 'eth', label: 'Ethereum', icon: 'Ξ', chain: 'eth' }] },
    { type: 'solana_bc',   icon: '◎',   name: 'Solana',         category: 'blockchains',tag: 'popular', desc: 'Solana wallet import',      color: '#9945FF', networks: [{ id: 'sol', label: 'Solana', icon: '◎', chain: 'sol' }] },
    { type: 'polygon_bc',   icon: '🟣',  name: 'Polygon',        category: 'blockchains',tag: '',        desc: 'Polygon (MATIC) address',   color: '#8247E5', networks: [{ id: 'polygon',  label: 'Polygon',   icon: '🟣', chain: 'eth', chainId: 137   }] },
    { type: 'base_bc',      icon: '🔵',  name: 'Base',           category: 'blockchains',tag: '',        desc: 'Coinbase L2 address',       color: '#0052FF', networks: [{ id: 'base',     label: 'Base',      icon: '🔵', chain: 'eth', chainId: 8453  }] },
    { type: 'arbitrum_bc',  icon: '🔷',  name: 'Arbitrum',       category: 'blockchains',tag: '',        desc: 'Arbitrum One address',      color: '#28a0f0', networks: [{ id: 'arbitrum', label: 'Arbitrum',  icon: '🔷', chain: 'eth', chainId: 42161 }] },
    { type: 'bnb_bc',       icon: '🟡',  name: 'BNB Chain',      category: 'blockchains',tag: '',        desc: 'BNB Smart Chain address',   color: '#f3ba2f', networks: [{ id: 'bsc',      label: 'BNB Chain', icon: '🟡', chain: 'eth', chainId: 56    }] },
    { type: 'avalanche_bc', icon: '🔺',  name: 'Avalanche',      category: 'blockchains',tag: '',        desc: 'Avalanche C-Chain address', color: '#e84142', networks: [{ id: 'avax',     label: 'Avalanche', icon: '🔺', chain: 'eth', chainId: 43114 }] },
    // ── Exchanges ─────────────────────────────────────────────
    { type: 'binance',      icon: '🟡',  name: 'Binance',        category: 'exchanges',  tag: 'popular', desc: 'Upload trade history CSV',  color: '#f0b90b', networks: [] },
    { type: 'coinbase',     icon: '🔵',  name: 'Coinbase',       category: 'exchanges',  tag: 'popular', desc: 'Upload transaction CSV',    color: '#0052ff', networks: [] },
    { type: 'kraken',       icon: '🐙',  name: 'Kraken',         category: 'exchanges',  tag: 'popular', desc: 'Upload ledger CSV',         color: '#5741d9', networks: [] },
    { type: 'bybit',        icon: '🔸',  name: 'Bybit',          category: 'exchanges',  tag: 'popular', desc: 'Upload order history CSV',  color: '#f7a600', networks: [] },
    { type: 'kucoin',       icon: '🟢',  name: 'KuCoin',         category: 'exchanges',  tag: '',        desc: 'Upload trade history CSV',  color: '#26de81', networks: [] },
    { type: 'cryptocom',    icon: '🔷',  name: 'Crypto.com',     category: 'exchanges',  tag: '',        desc: 'Upload transaction CSV',    color: '#002d74', networks: [] },
    { type: 'revolut',      icon: '🟤',  name: 'Revolut',        category: 'exchanges',  tag: '',        desc: 'Upload Revolut CSV export',  color: '#0075eb', networks: [] },
    { type: 'mexc',         icon: '🟩',  name: 'MEXC',           category: 'exchanges',  tag: '',        desc: 'Upload MEXC trade history', color: '#00b897', networks: [] },
    // ── Services ──────────────────────────────────────────────
    { type: 'csv',         icon: '📄',  name: 'CSV / Generic',  category: 'services',   tag: '',        desc: 'Any exchange or wallet CSV', color: '#64748b', networks: [] },
  ];

  // State for the add-account search modal
  let _accSearch = '';
  let _accFilter = 'all'; // all | exchanges | blockchains | wallets | services

  function renderAccounts() {
    const accounts = TaxEngine.getAccounts();
    const txns = TaxEngine.getTransactions();
    const txnCount = txns.length;

    // Cloud sync status line
    const cloudMeta = (typeof SUPABASE_READY !== 'undefined' && SUPABASE_READY)
      ? (S._cloudSyncedAt
          ? `<span style="color:#34d399">☁ Backed up ${timeAgoShort(S._cloudSyncedAt)}</span>`
          : `<span style="color:var(--text-muted)">☁ Not yet synced to cloud</span>`)
      : `<span style="color:var(--text-muted)">☁ Cloud sync off (Supabase not configured)</span>`;

    return `
      <div class="tax-page tax-page--accounts">
        <div class="tax-page-header">
          <h1 class="tax-page-title">ACCOUNTS</h1>
          <div style="display:flex;gap:8px;align-items:center">
            ${accounts.length > 0 ? `
            <button class="tax-btn tax-btn-sm tax-btn-ghost" style="color:#f87171;border-color:#f8717133" onclick="TaxUI.clearAllData()" title="Delete all accounts and transactions">
              🗑 Clear all data
            </button>` : ''}
            <button class="acc-add-btn" onclick="TaxUI.openAddAccountModal()">
              <span>＋</span> Add account
            </button>
          </div>
        </div>

        <!-- ── Cross-browser cloud sync info bar ─────────────── -->
        ${txnCount > 0 ? `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:rgba(255,255,255,0.03);border:1px solid var(--border-subtle);border-radius:10px;margin-bottom:16px;font-size:12px;">
          <span style="color:var(--text-muted)">${txnCount.toLocaleString()} transactions</span>
          <span style="color:var(--border-subtle)">•</span>
          ${cloudMeta}
          <button class="tax-btn tax-btn-xs tax-btn-ghost" style="margin-left:auto" onclick="TaxUI.manualCloudSync()" title="Push all transactions to cloud now (makes them available in other browsers)">
            ☁ Sync now
          </button>
        </div>` : ''}

        <!-- ── Connected accounts table ─────────────────── -->
        ${accounts.length > 0 ? `
        <div class="acc-table-wrap">
          <div class="acc-table-header">
            <span class="acc-th">Account</span>
            <span class="acc-th">Synced</span>
            <span class="acc-th">Type</span>
            <span class="acc-th acc-th-r">Tx</span>
            <span class="acc-th acc-th-r">Actions</span>
          </div>
          ${accounts.map(acc => {
      const st = TaxEngine.getImportStatus(acc.id);
      const cnt = txns.filter(t => t.accountId === acc.id).length;
      const src = ACC_SOURCES.find(s => s.type === acc.type) || { icon: '📂', name: acc.type, color: '#64748b' };
      const stMap = { synced: ['✅', 'Synced'], syncing: ['⏳', 'Syncing…'], partial_sync: ['⚠️', 'Partial'], failed: ['❌', 'Failed'], never_synced: ['—', 'Not synced'] };
      const [stIcon, stLabel] = stMap[st.status] || stMap.never_synced;
      const lastSync = acc.lastSyncAt ? timeAgoShort(acc.lastSyncAt) : 'Never';
      return `<div class="acc-row">
                  <div class="acc-row-account">
                    <div class="acc-row-icon" style="background:${src.color}22;border:1px solid ${src.color}44">${src.icon}</div>
                    <div>
                      <div class="acc-row-name">${acc.label || src.name}</div>
                      ${acc.address ? `<div class="acc-row-addr">${acc.address.slice(0, 8)}…${acc.address.slice(-5)}</div>` : ''}
                    </div>
                  </div>
                  <div class="acc-row-sync">${stIcon} <span title="${lastSync}">${lastSync}</span></div>
                  <div class="acc-row-type"><span class="tax-badge">${src.name}</span></div>
                  <div class="acc-row-tx tax-mono">${cnt.toLocaleString()}</div>
                  <div class="acc-row-actions">
                    <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.resyncAccount('${acc.id}')" title="Re-sync">🔄</button>
                    <button class="tax-btn tax-btn-xs tax-btn-ghost" style="color:#f87171" onclick="TaxUI.removeAccount('${acc.id}')">✕</button>
                  </div>
                </div>`;
    }).join('')}
        </div>` : `
        <div class="acc-empty-state">
          <div class="acc-empty-icon">🔗</div>
          <div class="acc-empty-title">No accounts connected yet</div>
          <div class="acc-empty-sub">Click <strong>+ Add account</strong> to import wallets and exchanges.</div>
          <button class="acc-add-btn" style="margin-top:16px" onclick="TaxUI.openAddAccountModal()">＋ Add account</button>
        </div>`}

        ${renderImportModal()}
        ${S.addAccountModal ? renderAddAccountModal() : ''}
      </div>
    `;
  }

  function renderAddAccountModal() {
    const q = (_accSearch || '').toLowerCase();
    const filter = _accFilter || 'all';
    const filters = [
      { id: 'all', label: 'All' },
      { id: 'exchanges', label: 'Exchanges' },
      { id: 'blockchains', label: 'Blockchains' },
      { id: 'wallets', label: 'Wallets' },
      { id: 'services', label: 'Services' },
    ];

    const visible = ACC_SOURCES.filter(s => {
      if (filter !== 'all' && s.category !== filter) return false;
      if (q && !s.name.toLowerCase().includes(q) && !s.desc.toLowerCase().includes(q)) return false;
      return true;
    });

    const popular = visible.filter(s => s.tag === 'popular');
    const others  = visible.filter(s => s.tag !== 'popular');

    return `<div class="acc-modal-overlay" onclick="if(event.target===this)TaxUI.closeAddAccountModal()">
      <div class="acc-modal">
        <div class="acc-modal-header">
          <span class="acc-modal-title">Add account</span>
          <button class="tax-modal-close" onclick="TaxUI.closeAddAccountModal()">✕</button>
        </div>
        <div class="acc-modal-search-wrap">
          <span class="acc-modal-search-icon">🔍</span>
          <input class="acc-modal-search" id="acc-search-input" type="text"
                 placeholder="Search for your wallet, exchange or blockchain"
                 value="${_accSearch}"
                 oninput="TaxUI.accSearch(this.value)" autofocus>
        </div>
        <div class="acc-modal-filters">
          ${filters.map(f => `
            <button class="acc-filter-pill ${_accFilter === f.id ? 'active' : ''}"
                    onclick="TaxUI.accFilter('${f.id}')">${f.label}</button>`).join('')}
        </div>
        <div class="acc-modal-body">
          ${popular.length > 0 ? `
          <div class="acc-modal-section-label">MOST POPULAR</div>
          <div class="acc-modal-grid">
            ${popular.map(s => `
              <button class="acc-modal-item" onclick="TaxUI.openImport('${s.type}');TaxUI.closeAddAccountModal()">
                <div class="acc-modal-item-icon" style="background:${s.color}18;border:1px solid ${s.color}33">${s.icon}</div>
                <div class="acc-modal-item-name">${s.name}</div>
              </button>`).join('')}
          </div>` : ''}
          ${others.length > 0 ? `
          ${popular.length > 0 ? '<div class="acc-modal-divider"></div>' : ''}
          <div class="acc-modal-grid">
            ${others.map(s => `
              <button class="acc-modal-item" onclick="TaxUI.openImport('${s.type}');TaxUI.closeAddAccountModal()">
                <div class="acc-modal-item-icon" style="background:${s.color}18;border:1px solid ${s.color}33">${s.icon}</div>
                <div class="acc-modal-item-name">${s.name}</div>
              </button>`).join('')}
          </div>` : ''}
          ${visible.length === 0 ? `<div style="text-align:center;padding:32px;color:var(--text-muted)">No results for "${_accSearch}"</div>` : ''}
          <div class="acc-modal-request">
            <a href="mailto:support@t-cmd.io?subject=Integration Request" class="acc-modal-request-link">
              Request an integration ↗
            </a>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderImportStatus(st) {
    const map = {
      never_synced: ['⬜', 'Never imported', '#64748b'],
      syncing: ['⏳', 'Syncing…', '#818cf8'],
      synced: ['✅', 'Synced', '#4ade80'],
      partial_sync: ['⚠️', 'Partial', '#fbbf24'],
      failed: ['❌', 'Failed', '#f87171'],
    };
    const [icon, label, color] = map[st.status] || map.never_synced;
    return `<span class="tax-status-pill" style="color:${color}">${icon} ${label}</span>`;
  }

  // ── Import Modals ─────────────────────────────────────────
  function renderImportModal() {
    if (!S.importModal) return '';
    const src = ACC_SOURCES.find(s => s.type === S.importModal);
    const hasNetworks = src?.networks?.length > 0;
    // Multiple networks and none selected yet → show network picker
    if (hasNetworks && src.networks.length > 1 && !S.importNetwork) {
      return renderNetworkPickerModal(src);
    }
    // Has networks (wallets / blockchains) → show wallet address input
    if (hasNetworks) {
      const net = src.networks?.find(n => n.id === S.importNetwork) || src.networks?.[0];
      return renderWalletModal(S.importModal, net?.chain || 'eth', net);
    }
    // Exchange or service → CSV upload
    return renderCSVModal(S.importModal);
  }

  function renderNetworkPickerModal(src) {
    return `<div class="tax-modal-overlay" onclick="if(event.target===this)TaxUI.closeImport()">
      <div class="tax-modal tax-modal--sm">
        <div class="tax-modal-header">
          <span>${src.icon} ${src.name} — Choose Network</span>
          <button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button>
        </div>
        <div class="tax-modal-body">
          <div class="acc-net-picker">
            ${src.networks.map(n => `
              <button class="acc-net-btn" onclick="TaxUI.selectNetwork('${n.id}')">
                <span class="acc-net-icon">${n.icon}</span>
                <span class="acc-net-label">${n.label}</span>
              </button>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  const MODAL_INSTRUCTIONS = {
    binance: {
      icon: '🟡', name: 'Binance', steps: [
        '1. Log in to Binance', '2. Go to Orders → Trade History',
        '3. Click "Export" → choose ALL time', '4. Download CSV and upload below',
      ], warning: 'Make sure to export ALL time, not just the last 3 months.'
    },
    kraken: {
      icon: '🐙', name: 'Kraken', steps: [
        '1. Log in to Kraken', '2. Go to History → Export',
        '3. Select "All Ledgers" → All time', '4. Download and upload below',
      ], warning: 'Export Ledgers (not just trades) to include deposits, withdrawals and staking.'
    },
    bybit: {
      icon: '🔵', name: 'Bybit', steps: [
        '1. Log in to Bybit', '2. Go to Assets → Order History',
        '3. Export → All time', '4. Upload below',
      ], warning: null
    },
    coinbase: {
      icon: '🔵', name: 'Coinbase', steps: [
        '1. Log in to Coinbase', '2. Go to Reports → Generate',
        '3. Select Transaction History → All time', '4. Download CSV and upload below',
      ], warning: null
    },
    revolut: {
      icon: '🟤', name: 'Revolut', steps: [
        '1. Öppna Revolut-appen', '2. Gå till Account → Statement',
        '3. Välj "Excel" eller "CSV" → välj hela perioden',
        '4. Ladda ned och ladda upp nedan',
      ], warning: 'Exportera kryptotransaktioner under Crypto-fliken separat om tillgängligt.'
    },
    mexc: {
      icon: '🟩', name: 'MEXC', steps: [
        '1. Logga in på MEXC', '2. Gå till Orders → Order History',
        '3. Klicka "Export" → välj All time', '4. Ladda ned CSV och ladda upp nedan',
      ], warning: null
    },
    csv: {
      icon: '📄', name: 'CSV File', steps: [
        'Expected columns: date, type, asset, amount, price_sek (or price), fee',
        'Common column names are auto-detected.',
      ], warning: null
    },
  };

  function renderWalletModal(type, chain, net) {
    const src       = ACC_SOURCES.find(s => s.type === type) || {};
    const netLabel  = net ? net.label : (chain === 'sol' ? 'Solana' : 'Ethereum');
    const netIcon   = net ? net.icon  : (chain === 'sol' ? '◎' : 'Ξ');
    const addrPlh   = chain === 'sol' ? 'Solana-adress (base58…)' :
                      chain === 'sui' ? 'Sui-adress (0x…)' : '0x… Ethereum-adress';
    const isSui     = chain === 'sui';
    const chainId   = net?.chainId || null;
    const tab       = S.walletModalTab || 'auto';
    const fromMode  = S.walletImportFrom || 'beginning';
    const today     = new Date().toISOString().slice(0, 10);

    // Build warning banners
    let warnings = '';
    if (chain === 'sol' && !localStorage.getItem('tcmd_helius_key')) {
      warnings += `<div class="tax-warn-box">⚠️ Ingen Helius API-nyckel. Lägg till i Admin → API-nycklar för Solana-import.</div>`;
    } else if (chain === 'eth' && !localStorage.getItem('tcmd_etherscan_key') && !window.TCMD_KEYS?.etherscan) {
      warnings += `<div class="tax-warn-box" style="flex-direction:column;gap:4px">
        <div><strong>⚠️ Etherscan API-nyckel krävs för EVM-import.</strong></div>
        <div style="color:#fde68a;font-weight:400">${typeof AuthManager !== 'undefined' && AuthManager.isAdmin()
          ? 'Gå till <strong>Admin → API-nycklar → Etherscan</strong> för att lägga till din nyckel.'
          : 'Kontakta din administratör för att konfigurera Etherscan API-nyckeln.'
        }</div></div>`;
    }
    if (isSui) warnings += `<div class="tax-warn-box">⚠️ Sui-import kommer snart.</div>`;

    return `<div class="tax-modal-overlay" onclick="if(event.target===this)TaxUI.closeImport()">
      <div class="tax-modal">

        <!-- ── Header ────────────────────────────────────── -->
        <div class="tax-modal-header">
          <div style="display:flex;align-items:center;gap:8px">
            ${src.networks?.length > 1 ? `<button class="tax-modal-back" onclick="TaxUI.selectNetwork(null)" title="Tillbaka">←</button>` : ''}
            <span style="font-size:18px">${src.icon}</span>
            <span>${src.name}${net ? `<span class="acc-net-badge" style="margin-left:6px">${netIcon} ${netLabel}</span>` : ''}</span>
          </div>
          <button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button>
        </div>

        <!-- ── Tabs ───────────────────────────────────────── -->
        <div class="tax-wallet-tabs">
          <button class="tax-wallet-tab ${tab === 'auto' ? 'active' : ''}"
            onclick="TaxUI.setWalletTab('auto')">☁ Automatisk import</button>
          <button class="tax-wallet-tab ${tab === 'empty' ? 'active' : ''}"
            onclick="TaxUI.setWalletTab('empty')">📋 Tom plånbok</button>
        </div>

        <!-- ── Body ──────────────────────────────────────── -->
        <div class="tax-modal-body">
          ${tab === 'auto' ? `
            <div class="tax-form-group">
              <label>Plånboksadress <span class="tax-label-required">*</span></label>
              <input type="text" id="tax-wallet-addr" class="tax-input"
                placeholder="${addrPlh}" autocomplete="off" spellcheck="false">
            </div>

            <div class="tax-form-group">
              <label>Importera transaktioner</label>
              <div class="tax-import-from-row">
                <button class="tax-import-from-btn ${fromMode === 'beginning' ? 'active' : ''}"
                  onclick="TaxUI.setImportFrom('beginning')">
                  <span class="tax-import-from-icon">${fromMode === 'beginning' ? '●' : '○'}</span>
                  Från början
                </button>
                <button class="tax-import-from-btn ${fromMode === 'date' ? 'active' : ''}"
                  onclick="TaxUI.setImportFrom('date')">
                  <span class="tax-import-from-icon">${fromMode === 'date' ? '●' : '○'}</span>
                  Från datum
                </button>
              </div>
              ${fromMode === 'date' ? `
              <input type="date" id="tax-wallet-since" class="tax-input" style="margin-top:8px"
                value="${S.walletImportDate || ''}" max="${today}"
                onchange="TaxUI.setWalletImportDate(this.value)">` : ''}
            </div>

            <div class="tax-form-group">
              <label>Plånboksnamn <span style="font-weight:400;color:var(--text-muted);text-transform:none">(valfritt)</span></label>
              <input type="text" id="tax-wallet-label" class="tax-input"
                placeholder="Min ${netLabel}-plånbok">
            </div>

            ${warnings}

            <div class="tax-info-box" style="margin-top:4px;margin-bottom:0">
              <span>🔒</span>
              <span>Skrivskyddad — privata nycklar används <strong>aldrig</strong>. Bara den offentliga adressen används.</span>
            </div>
            <div id="tax-import-status" style="margin-top:12px"></div>

          ` : `
            <p class="tax-modal-desc" style="margin-bottom:20px">
              Skapa en tom plånbok och lägg till transaktioner manuellt. Inga transaktioner importeras automatiskt.
            </p>
            <div class="tax-form-group">
              <label>Plånboksnamn <span class="tax-label-required">*</span></label>
              <input type="text" id="tax-wallet-label-empty" class="tax-input"
                placeholder="Min ${netLabel}-plånbok" autocomplete="off">
            </div>
            <div id="tax-import-status" style="margin-top:12px"></div>
          `}
        </div>

        <!-- ── Footer ────────────────────────────────────── -->
        <div class="tax-modal-footer">
          <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeImport()">Avbryt</button>
          ${tab === 'auto'
            ? `<button class="tax-btn tax-btn-primary"
                onclick="TaxUI.importWallet('${chain}',${chainId ? `'${chainId}'` : 'null'})"
                ${isSui ? 'disabled title="Sui-import kommer snart"' : ''}>
                Importera historik
               </button>`
            : `<button class="tax-btn tax-btn-primary"
                onclick="TaxUI.createEmptyWallet('${chain}',${chainId ? `'${chainId}'` : 'null'})">
                Skapa plånbok
               </button>`}
        </div>

      </div></div>`;
  }

  function renderCSVModal(parser) {
    const info = MODAL_INSTRUCTIONS[parser] || MODAL_INSTRUCTIONS.csv;
    return `<div class="tax-modal-overlay">
      <div class="tax-modal">
        <div class="tax-modal-header"><span>${info.icon} Import ${info.name}</span><button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button></div>
        <div class="tax-modal-body">
          <div class="tax-import-steps">
            ${info.steps.map(s => `<div class="tax-import-step">${s}</div>`).join('')}
          </div>
          ${info.warning ? `<div class="tax-warn-box">⚠️ ${info.warning}</div>` : ''}
          <div class="tax-form-group" style="margin-top:12px">
            <label>Account Label (optional)</label>
            <input type="text" id="tax-csv-label" class="tax-input" placeholder="${info.name} account">
          </div>
          <div class="tax-form-group">
            <label>Upload CSV</label>
            <div class="tax-dropzone" id="tax-dropzone" onclick="document.getElementById('tax-csv-file').click()">
              <div class="tax-dropzone-icon">📂</div>
              <div class="tax-dropzone-text">Click to select or drag & drop</div>
              <div class="tax-dropzone-sub" id="tax-dz-sub">Supports .csv — full history required</div>
            </div>
            <input type="file" id="tax-csv-file" accept=".csv,.txt" style="display:none" onchange="TaxUI.onCSVSelected(event,'${parser}')">
          </div>
          <div id="tax-import-status"></div>
        </div>
        <div class="tax-modal-footer">
          <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeImport()">Cancel</button>
          <button class="tax-btn tax-btn-primary" id="tax-csv-import-btn" disabled onclick="TaxUI.importCSV('${parser}')">Import Transactions</button>
        </div>
      </div></div>`;
  }

  // ════════════════════════════════════════════════════════════
  // TRANSACTIONS PAGE
  // ════════════════════════════════════════════════════════════
  const CAT_META = {
    buy:          { icon: '↓',  color: '#22c55e', label: 'Köp',          labelEn: 'Buy'         },
    sell:         { icon: '↑',  color: '#ef4444', label: 'Sälj',         labelEn: 'Sell'        },
    trade:        { icon: '↔',  color: '#8b5cf6', label: 'Byte',         labelEn: 'Swap'        },
    receive:      { icon: '⬇',  color: '#06b6d4', label: 'Mottagen',     labelEn: 'Receive'     },
    send:         { icon: '⬆',  color: '#f59e0b', label: 'Skickad',      labelEn: 'Send'        },
    income:       { icon: '★',  color: '#f59e0b', label: 'Inkomst',      labelEn: 'Income'      },
    fee:          { icon: '💸', color: '#94a3b8', label: 'Avgift',        labelEn: 'Fee'         },
    transfer_in:  { icon: '←',  color: '#64748b', label: 'Överföring in',labelEn: 'Transfer In' },
    transfer_out: { icon: '→',  color: '#64748b', label: 'Överföring ut',labelEn: 'Transfer Out'},
    spam:         { icon: '🚫', color: '#475569', label: 'Spam',          labelEn: 'Spam'        },
    approval:     { icon: '✓',  color: '#475569', label: 'Godkännande',  labelEn: 'Approval'    },
    staking:      { icon: '🥩', color: '#22d3ee', label: 'Staking',       labelEn: 'Staking'     },
    nft_sale:     { icon: '🖼️',color: '#a78bfa', label: 'NFT-försäljning',labelEn: 'NFT Sale'  },
    bridge:       { icon: '🌉', color: '#818cf8', label: 'Bridge',        labelEn: 'Bridge'      },
    defi_unknown: { icon: '🧩', color: '#f59e0b', label: 'DeFi',          labelEn: 'DeFi'        },
  };

  function renderTransactions() {
    const allTxns  = TaxEngine.getTransactions();
    const accounts = TaxEngine.getAccounts();
    const filtered = filterTxns(allTxns);
    const sorted   = sortTxnsArr(filtered);
    const paged    = sorted.slice(S.txPage * S.txPageSize, (S.txPage + 1) * S.txPageSize);
    const selCount = S.selectedTxIds.size;

    // ── Top filter bar (Divly-style pill dropdowns) ──────────
    const typeLabel   = S.txFilter.category !== 'all'
      ? (CAT_META[S.txFilter.category]?.label || S.txFilter.category) : 'Alla typer';
    const walletLabel = S.txFilter.account !== 'all'
      ? (accounts.find(a => a.id === S.txFilter.account)?.label || 'Plånbok') : 'Alla plånböcker';
    const labelLabel  = S.txLabelFilter !== 'all' ? S.txLabelFilter : 'Alla etiketter';
    const hasDateFilter = S.txFilter.dateFrom || S.txFilter.dateTo;
    const dateLabel   = hasDateFilter
      ? `${S.txFilter.dateFrom || '…'} – ${S.txFilter.dateTo || '…'}` : 'Alla datum';
    const reviewActive = S.txFilter.needsReview;

    // ── Bulk action bar (shown when rows are selected) ───────
    const bulkBar = selCount > 0 ? `
      <div class="tx-bulk-bar">
        <span class="tx-bulk-count">${selCount} valda</span>
        <button class="tx-bulk-btn" onclick="TaxUI.mergeSameHash()">SÄTT IHOP ${selCount}</button>
        <button class="tx-bulk-btn" onclick="TaxUI.mergeTrade()">SÄTT IHOP TILL TRADE</button>
        <button class="tx-bulk-btn" onclick="TaxUI.mergeTransfer()">SLÅ IHOP TILL EN ÖVERFÖRING</button>
        <button class="tx-bulk-btn" onclick="TaxUI.bulkReclassify('')">MASSREDIGERING ${selCount}</button>
        <button class="tx-bulk-btn" onclick="TaxUI.mergeMultipleTransfers()">SÄTT IHOP FLERA ÖVERFÖRINGAR</button>
        <button class="tx-bulk-btn tx-bulk-btn--danger" onclick="TaxUI.deleteSelected()">TA BORT ${selCount}</button>
        <button class="tx-bulk-btn tx-bulk-btn--ghost" onclick="TaxUI.clearSelection()">✕</button>
      </div>` : '';

    // ── Add transaction dropdown ─────────────────────────────
    const addTxMenu = S.addTxMenuOpen ? `
      <div class="tx-add-menu">
        <button class="tx-add-menu-item" onclick="TaxUI.addManualRow('receive')">Insättning</button>
        <button class="tx-add-menu-item" onclick="TaxUI.addManualRow('send')">Uttag</button>
        <button class="tx-add-menu-item" onclick="TaxUI.addManualRow('trade')">Trade</button>
        <button class="tx-add-menu-item" onclick="TaxUI.addManualRow('transfer_in')">Överföring</button>
      </div>` : '';

    // ── Manual entry form rows ───────────────────────────────
    const manualFormHtml = S.manualTxRows.length > 0 ? renderManualTxForm() : '';

    // ── Table rows including expandable panels ────────────────
    const tableRows = paged.map(t => {
      const row = renderTxRow(t);
      const expanded = S.expandedTxId === t.id ? renderExpandedTxRow(t) : '';
      return row + expanded;
    }).join('');

    return `
      <div class="tax-page tax-page--transactions" style="display:flex;flex-direction:column;height:100%;overflow:hidden">

        <!-- ── Top filter bar ────────────────────────────────── -->
        <div class="tx-filter-topbar" style="flex-shrink:0">
          <div class="tx-filter-pills">
            <div class="tx-filter-pill-wrap">
              <button class="tx-filter-pill ${S.txFilter.category !== 'all' ? 'active' : ''}"
                onclick="TaxUI.toggleTxTypeMenu(event)">
                ${typeLabel} <span class="tx-pill-caret">▾</span>
              </button>
            </div>
            <div class="tx-filter-pill-wrap">
              <button class="tx-filter-pill ${S.txFilter.account !== 'all' ? 'active' : ''}"
                onclick="TaxUI.toggleTxWalletMenu(event)">
                ${walletLabel} <span class="tx-pill-caret">▾</span>
              </button>
            </div>
            <div class="tx-filter-pill-wrap">
              <button class="tx-filter-pill ${S.txLabelFilter !== 'all' ? 'active' : ''}"
                onclick="TaxUI.toggleTxLabelMenu(event)">
                ${labelLabel} <span class="tx-pill-caret">▾</span>
              </button>
            </div>
            <button class="tx-filter-pill ${reviewActive ? 'active' : ''}"
              onclick="TaxUI.setFilter('needsReview', ${!reviewActive})">
              ${reviewActive ? '⚠️ Behöver granskning' : 'Filter'}
            </button>
            <div class="tx-filter-pill-wrap">
              <button class="tx-filter-pill ${hasDateFilter ? 'active' : ''}"
                onclick="TaxUI.openCal('from')">
                📅 ${dateLabel}
              </button>
            </div>
            ${S.txFilter.search ? `
              <button class="tx-filter-pill active" onclick="TaxUI.setFilter('search','')">
                🔍 "${S.txFilter.search}" ✕
              </button>` : `
              <div class="tx-search-wrap">
                <span class="tx-search-icon">🔍</span>
                <input type="text" class="tx-search-input" placeholder="Sök tillgång, hash…"
                  value="${S.txFilter.search}" oninput="TaxUI.setFilter('search',this.value)">
              </div>`}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">⚙️ Bearbeta</button>
            <div style="position:relative">
              <button class="tx-add-btn" onclick="TaxUI.toggleAddTxMenu()">
                LÄGG TILL TRANSAKTION <span class="tx-pill-caret">▾</span>
              </button>
              ${addTxMenu}
            </div>
          </div>
        </div>

        ${S.calOpen ? renderCalendar() : ''}
        ${bulkBar}

        <!-- ── Table meta + pagination ───────────────────────── -->
        <div class="tax-table-meta" style="flex-shrink:0">
          <span class="tax-muted">${filtered.length.toLocaleString()} transaktioner</span>
          ${filtered.length < allTxns.length ? `<span class="tax-filter-chip">${allTxns.length.toLocaleString()} totalt</span>` : ''}
          <span style="flex:1"></span>
          ${renderPagination(filtered.length)}
        </div>

        <!-- ── Main table ─────────────────────────────────────── -->
        ${paged.length === 0 && S.manualTxRows.length === 0
          ? renderEmpty('Inga transaktioner', allTxns.length === 0 ? 'Lägg till konton från sidan Konton.' : 'Inga matchningar.', '📋')
          : `<div class="tax-table-wrap" style="flex:1;overflow-y:auto;min-height:0">
              <table class="tax-table tax-table--tx" style="width:100%">
                <thead style="position:sticky;top:0;z-index:2;background:var(--tax-bg,#0d1021)">
                  <tr>
                    <th class="tx-col-check">
                      <input type="checkbox" ${selCount > 0 && selCount === sorted.length ? 'checked' : ''}
                        onchange="TaxUI.toggleSelectAll(this.checked)"
                        title="Markera alla ${sorted.length.toLocaleString()} transaktioner">
                    </th>
                    <th class="tx-col-info">Info</th>
                    <th class="tx-col-type">Typ</th>
                    <th class="tx-col-date sortable" onclick="TaxUI.sortTxns('date')">Datum ${sortIcon('date')}</th>
                    <th class="tx-col-sent">Skickad</th>
                    <th class="tx-col-recv">Mottagen</th>
                    <th class="tx-col-gl ta-r">Vinst/Förlust</th>
                    <th class="tx-col-wallet">Plånbok</th>
                    <th class="tx-col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  ${manualFormHtml}
                  ${tableRows}
                </tbody>
              </table>
            </div>`
        }

        ${S.editTxId ? renderEditModal() : ''}
      </div>
    `;
  }

  // Price source → short label + colour for the confidence dot in price column
  const PRICE_SOURCE_LABELS = {
    trade_exact:            { label: 'Exchange',     dot: '#22c55e' },
    market_api_coingecko:   { label: 'CoinGecko',    dot: '#22c55e' },
    market_api_dex:         { label: 'DEX (GT)',     dot: '#34d399' },  // GeckoTerminal
    swap_implied:           { label: 'Swap derived', dot: '#a78bfa' },
    pair_derived:           { label: 'Derived',      dot: '#a78bfa' },
    stable_historical_fx:   { label: 'FX',           dot: '#34d399' },
    stable_approx:          { label: 'Approx',       dot: '#fbbf24' },
    manual:                 { label: 'Manual',       dot: '#60a5fa' },
    missing:                { label: 'Missing',      dot: '#f87171' },
  };

  function renderTxRow(t) {
    const cm       = CAT_META[t.category] || { icon: '•', color: '#94a3b8', label: t.category };
    const isInternal = t.isInternalTransfer;
    const checked  = S.selectedTxIds.has(t.id);
    const expanded = S.expandedTxId === t.id;
    const accounts = TaxEngine.getAccounts();
    const acc      = accounts.find(a => a.id === t.accountId);
    const accLabel = acc?.label || acc?.type || '—';

    // Resolve display symbol
    const td = TaxEngine.resolveTokenDisplay ? TaxEngine.resolveTokenDisplay(t.assetSymbol) : { symbol: t.assetSymbol, name: '' };
    const displaySym = td.symbol || t.assetSymbol || '—';

    // Sent / Received columns — derived from category + amounts
    const isOutgoing = ['sell','send','transfer_out','fee'].includes(t.category);
    const isSwap     = t.category === 'trade';
    let sentCell = '—', recvCell = '—';
    const fmtAmt = (sym, amt) =>
      `<span class="tx-asset-amt">${TaxEngine.formatCrypto(amt, 6)}</span> <span class="tx-asset-sym-sm">${sym}</span>`;
    if (isSwap) {
      sentCell = fmtAmt(displaySym, t.amount);
      recvCell = t.inAsset ? fmtAmt(t.inAsset, t.inAmount || 0) : '—';
    } else if (isOutgoing) {
      sentCell = fmtAmt(displaySym, t.amount);
    } else {
      recvCell = fmtAmt(displaySym, t.amount);
    }

    // Gain/loss cell (for disposals only)
    const hasGL = t.category === 'sell' || t.category === 'trade';
    let glCell = '—';
    if (hasGL && t.gainSEK != null) {
      const isGain = t.gainSEK >= 0;
      glCell = `<span class="tx-gl ${isGain ? 'tx-gl--gain' : 'tx-gl--loss'}">${isGain ? '+' : ''}${TaxEngine.formatSEK(t.gainSEK)}</span>`;
    } else if (hasGL) {
      glCell = '<span class="tax-missing" title="Kör pipeline för att beräkna">—</span>';
    }

    // Warning indicator
    const warnIcon = t.needsReview
      ? `<span class="tx-warn-dot" title="${t.reviewReason || 'Behöver granskning'}">⚠</span>` : '';

    // Price source dot
    const psMeta = PRICE_SOURCE_LABELS[t.priceSource] || null;
    const psDot = psMeta ? `<span class="tx-ps-dot" title="${psMeta.label}" style="background:${psMeta.dot}"></span>` : '';

    return `
      <tr class="tx-row ${t.needsReview ? 'tx-row--review' : ''} ${isInternal ? 'tx-row--internal' : ''} ${checked ? 'tx-row--selected' : ''} ${expanded ? 'tx-row--expanded' : ''}"
          onclick="TaxUI.expandTxRow('${t.id}')">
        <td class="tx-col-check" onclick="event.stopPropagation()">
          <input type="checkbox" ${checked ? 'checked' : ''}
            onchange="TaxUI.toggleSelectTx('${t.id}',this.checked)">
        </td>
        <td class="tx-col-info">
          ${warnIcon}
          ${t.isDuplicate ? '<span class="tx-badge tx-badge--dup">DUP</span>' : ''}
          ${isInternal ? '<span class="tx-badge tx-badge--int">↔</span>' : ''}
          ${psDot}
        </td>
        <td class="tx-col-type">
          <span class="tx-type-badge" style="background:${cm.color}20;color:${cm.color};border:1px solid ${cm.color}40">
            ${cm.icon} ${cm.label}
          </span>
        </td>
        <td class="tx-col-date">
          <span class="tx-date-primary">${fmtDateShort(t.date).split(' ')[0]}</span>
          <span class="tx-date-time">${fmtDateShort(t.date).split(' ')[1] || ''}</span>
        </td>
        <td class="tx-col-sent tx-mono">${sentCell}</td>
        <td class="tx-col-recv tx-mono">${recvCell}</td>
        <td class="tx-col-gl ta-r">${glCell}</td>
        <td class="tx-col-wallet">
          <span class="tx-wallet-label" title="${accLabel}">${accLabel.length > 14 ? accLabel.slice(0,12)+'…' : accLabel}</span>
        </td>
        <td class="tx-col-actions" onclick="event.stopPropagation()">
          <div class="tax-row-actions">
            <button class="tax-icon-btn" onclick="TaxUI.editTx('${t.id}')" title="Redigera">✏️</button>
            <button class="tax-icon-btn tax-icon-del" onclick="TaxUI.deleteTx('${t.id}')" title="Ta bort">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }

  // ── Expandable row panel ────────────────────────────────────
  function renderExpandedTxRow(t) {
    const tab = S.expandedTxTab || 'description';
    const cm  = CAT_META[t.category] || { label: t.category };
    const val = t.costBasisSEK || (t.priceSEKPerUnit && t.amount ? t.priceSEKPerUnit * t.amount : 0);
    const psMeta = PRICE_SOURCE_LABELS[t.priceSource] || null;

    // Tab: TRANSAKTIONSBESKRIVNING
    const descTab = `
      <div class="tx-expand-grid">
        <div class="tx-expand-kv"><span class="tx-expand-k">Typ</span><span class="tx-expand-v">${cm.label}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Datum</span><span class="tx-expand-v">${fmtDateShort(t.date)}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Tillgång</span><span class="tx-expand-v">${t.assetSymbol || '—'}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Antal</span><span class="tx-expand-v tax-mono">${TaxEngine.formatCrypto(t.amount, 8)}</span></div>
        ${t.inAsset ? `<div class="tx-expand-kv"><span class="tx-expand-k">Mottagen tillgång</span><span class="tx-expand-v">${t.inAsset} ${t.inAmount ? TaxEngine.formatCrypto(t.inAmount, 8) : ''}</span></div>` : ''}
        <div class="tx-expand-kv"><span class="tx-expand-k">Pris (SEK)</span><span class="tx-expand-v tax-mono">${t.priceSEKPerUnit ? TaxEngine.formatSEK(t.priceSEKPerUnit, 2) : '—'} ${psMeta ? `<span style="font-size:10px;color:var(--tax-muted)">(${psMeta.label})</span>` : ''}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Värde (SEK)</span><span class="tx-expand-v tax-mono">${val ? TaxEngine.formatSEK(val) : '—'}</span></div>
        ${t.feeSEK ? `<div class="tx-expand-kv"><span class="tx-expand-k">Avgift (SEK)</span><span class="tx-expand-v tax-mono">${TaxEngine.formatSEK(t.feeSEK, 2)}</span></div>` : ''}
        ${t.txHash ? `<div class="tx-expand-kv" style="grid-column:1/-1"><span class="tx-expand-k">TxHash</span><span class="tx-expand-v tax-mono" style="font-size:10px;word-break:break-all">${t.txHash}</span></div>` : ''}
        ${t.notes ? `<div class="tx-expand-kv" style="grid-column:1/-1"><span class="tx-expand-k">Anteckningar</span><span class="tx-expand-v">${t.notes}</span></div>` : ''}
      </div>
      ${t.needsReview ? `
        <div class="tx-warning-card">
          <div class="tx-warning-row"><span class="tx-warning-label">Typ av varning</span><span class="tx-warning-val">${t.reviewReason || 'Behöver granskning'}</span></div>
          <div class="tx-warning-row"><span class="tx-warning-label">Detaljer</span><span class="tx-warning-val">${t.reviewDetails || 'Kontrollera och klassificera denna transaktion.'}</span></div>
          <div class="tx-warning-actions">
            <button class="tx-warn-action-btn" onclick="TaxUI.markReviewed('${t.id}')">IGNORERA VARNING</button>
          </div>
        </div>` : ''}`;

    // Tab: SKATTEBERÄKNINGAR
    const taxTab = `
      <div class="tx-expand-grid">
        <div class="tx-expand-kv"><span class="tx-expand-k">Skatteår</span><span class="tx-expand-v">${t.date ? new Date(t.date).getFullYear() : '—'}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Kategori (SKV)</span><span class="tx-expand-v">${cm.label} (${t.category})</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Kostnadsbas (SEK)</span><span class="tx-expand-v tax-mono">${t.costBasisSEK ? TaxEngine.formatSEK(t.costBasisSEK) : '—'}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Genomsnittskurs</span><span class="tx-expand-v tax-mono">${t.avgCostSEK ? TaxEngine.formatSEK(t.avgCostSEK, 4) : '—'}</span></div>
        <div class="tx-expand-kv"><span class="tx-expand-k">Vinst/Förlust</span><span class="tx-expand-v tax-mono ${t.gainSEK >= 0 ? 'tx-gl--gain' : 'tx-gl--loss'}">${t.gainSEK != null ? TaxEngine.formatSEK(t.gainSEK) : '—'}</span></div>
        ${t.isInternalTransfer ? '<div class="tx-expand-kv" style="grid-column:1/-1"><span class="tx-expand-k">Intern överföring</span><span class="tx-expand-v">Ej skattepliktig — matchad som intern transfer.</span></div>' : ''}
      </div>`;

    return `
      <tr class="tx-expand-row">
        <td colspan="9" style="padding:0">
          <div class="tx-expand-panel">
            <div class="tx-expand-tabs">
              <button class="tx-expand-tab ${tab === 'description' ? 'active' : ''}"
                onclick="event.stopPropagation();TaxUI.setExpandedTab('description')">
                TRANSAKTIONSBESKRIVNING
              </button>
              <button class="tx-expand-tab ${tab === 'tax' ? 'active' : ''}"
                onclick="event.stopPropagation();TaxUI.setExpandedTab('tax')">
                SKATTEBERÄKNINGAR
              </button>
            </div>
            <div class="tx-expand-body">
              ${tab === 'description' ? descTab : taxTab}
            </div>
          </div>
        </td>
      </tr>`;
  }

  // ── Manual transaction entry form ──────────────────────────
  function renderManualTxForm() {
    const accounts = TaxEngine.getAccounts();
    const typeOptions = ['receive','send','trade','transfer_in','transfer_out','buy','sell','income','fee']
      .map(k => `<option value="${k}">${CAT_META[k]?.label || k}</option>`).join('');
    const walletOptions = accounts.map(a => `<option value="${a.id}">${a.label || a.type}</option>`).join('');

    return S.manualTxRows.map((row, i) => `
      <tr class="tx-manual-row">
        <td></td>
        <td>
          <select class="tx-manual-select" onchange="TaxUI.updateManualRow(${i},'type',this.value)">
            ${typeOptions.replace(`value="${row.type}"`, `value="${row.type}" selected`)}
          </select>
        </td>
        <td>
          <select class="tx-manual-select" onchange="TaxUI.updateManualRow(${i},'label',this.value)">
            <option value="">Ingen etikett</option>
            <option value="staking" ${row.label==='staking'?'selected':''}>Staking</option>
            <option value="mining" ${row.label==='mining'?'selected':''}>Mining</option>
            <option value="airdrop" ${row.label==='airdrop'?'selected':''}>Airdrop</option>
            <option value="gift" ${row.label==='gift'?'selected':''}>Gåva</option>
          </select>
        </td>
        <td>
          <select class="tx-manual-select" onchange="TaxUI.updateManualRow(${i},'wallet',this.value)">
            <option value="">Välj plånbok</option>
            ${walletOptions.replace(`value="${row.wallet}"`, `value="${row.wallet}" selected`)}
          </select>
        </td>
        <td>
          <input type="datetime-local" class="tx-manual-input tx-manual-date"
            value="${row.date || ''}" onchange="TaxUI.updateManualRow(${i},'date',this.value)">
        </td>
        <td>
          <div style="display:flex;gap:4px">
            <input type="number" class="tx-manual-input" style="width:72px" placeholder="Belopp"
              value="${row.sentAmt || ''}" oninput="TaxUI.updateManualRow(${i},'sentAmt',this.value)">
            <input type="text" class="tx-manual-input" style="width:52px" placeholder="CCY"
              value="${row.sentCcy || ''}" oninput="TaxUI.updateManualRow(${i},'sentCcy',this.value)">
          </div>
        </td>
        <td>
          <div style="display:flex;gap:4px">
            <input type="number" class="tx-manual-input" style="width:72px" placeholder="Belopp"
              value="${row.recAmt || ''}" oninput="TaxUI.updateManualRow(${i},'recAmt',this.value)">
            <input type="text" class="tx-manual-input" style="width:52px" placeholder="CCY"
              value="${row.recCcy || ''}" oninput="TaxUI.updateManualRow(${i},'recCcy',this.value)">
          </div>
        </td>
        <td>
          <div style="display:flex;gap:4px">
            <input type="number" class="tx-manual-input" style="width:60px" placeholder="Avgift"
              value="${row.feeAmt || ''}" oninput="TaxUI.updateManualRow(${i},'feeAmt',this.value)">
            <input type="text" class="tx-manual-input" style="width:48px" placeholder="CCY"
              value="${row.feeCcy || ''}" oninput="TaxUI.updateManualRow(${i},'feeCcy',this.value)">
          </div>
        </td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="tax-icon-btn" title="Duplicera" onclick="TaxUI.duplicateManualRow(${i})">⧉</button>
            <button class="tax-icon-btn tax-icon-del" title="Ta bort" onclick="TaxUI.removeManualRow(${i})">✕</button>
          </div>
        </td>
      </tr>`).join('') + `
      <tr class="tx-manual-submit-row">
        <td colspan="9" style="padding:6px 12px">
          <div style="display:flex;gap:8px;align-items:center">
            <button class="tax-btn tax-btn-primary tax-btn-sm" onclick="TaxUI.submitManualRows()">
              ✓ Spara ${S.manualTxRows.length} transaktion${S.manualTxRows.length !== 1 ? 'er' : ''}
            </button>
            <button class="tax-btn tax-btn-ghost tax-btn-sm" onclick="TaxUI.addManualRow(null)">+ Lägg till rad</button>
            <button class="tax-btn tax-btn-ghost tax-btn-sm" onclick="TaxUI.cancelManualRows()">Avbryt</button>
          </div>
        </td>
      </tr>`;
  }

  function renderCalendar() {
    const y = S.calYear, m = S.calMonth;
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const blanks = first === 0 ? 6 : first - 1;
    const selDate = S.calField === 'from' ? S.txFilter.dateFrom : S.txFilter.dateTo;
    let cells = '';
    for (let i = 0; i < blanks; i++) cells += '<div class="tax-cal-cell empty"></div>';
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells += `<div class="tax-cal-cell${selDate === ds ? ' selected' : ''}" onclick="TaxUI.selectDate('${ds}')">${d}</div>`;
    }
    return `<div class="tax-calendar-wrap"><div class="tax-calendar">
      <div class="tax-cal-header">
        <button class="tax-cal-nav" onclick="TaxUI.calNav(-1)">‹</button>
        <span>${MONTHS[m]} ${y}</span>
        <button class="tax-cal-nav" onclick="TaxUI.calNav(1)">›</button>
      </div>
      <div class="tax-cal-grid">
        ${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => `<div class="tax-cal-dow">${d}</div>`).join('')}
        ${cells}
      </div>
      <div class="tax-cal-footer"><button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.closeCal()">Close</button></div>
    </div></div>`;
  }

  function renderPagination(total) {
    const pages = Math.ceil(total / S.txPageSize);
    if (pages <= 1) return '';
    return `<div class="tax-pagination">
      <button class="tax-page-btn" ${S.txPage === 0 ? 'disabled' : ''} onclick="TaxUI.setPage(${S.txPage - 1})">‹</button>
      <span class="tax-page-info">${S.txPage + 1} / ${pages}</span>
      <button class="tax-page-btn" ${S.txPage >= pages - 1 ? 'disabled' : ''} onclick="TaxUI.setPage(${S.txPage + 1})">›</button>
    </div>`;
  }

  function renderEditModal() {
    const t = TaxEngine.getTransactions().find(tx => tx.id === S.editTxId);
    if (!t) return '';
    const cats = Object.entries(CAT_META);
    return `<div class="tax-modal-overlay">
      <div class="tax-modal">
        <div class="tax-modal-header"><span>✏️ Edit Transaction</span><button class="tax-modal-close" onclick="TaxUI.closeEdit()">✕</button></div>
        <div class="tax-modal-body">
          <div class="tax-form-grid">
            <div class="tax-form-group">
              <label>Date</label>
              <input type="datetime-local" id="e-date" class="tax-input" value="${(t.date || '').slice(0, 16)}">
            </div>
            <div class="tax-form-group">
              <label>Type</label>
              <select id="e-cat" class="tax-select">
                ${cats.map(([k, v]) => `<option value="${k}" ${t.category === k ? 'selected' : ''}>${v.label}</option>`).join('')}
              </select>
            </div>
            <div class="tax-form-group">
              <label>Asset</label>
              <input type="text" id="e-sym" class="tax-input" value="${t.assetSymbol || ''}">
            </div>
            <div class="tax-form-group">
              <label>Amount</label>
              <input type="number" id="e-amt" class="tax-input" value="${t.amount || 0}" step="any">
            </div>
            <div class="tax-form-group">
              <label>Price (SEK/unit)</label>
              <input type="number" id="e-price" class="tax-input" value="${t.priceSEKPerUnit || 0}" step="any">
            </div>
            <div class="tax-form-group">
              <label>Fee (SEK)</label>
              <input type="number" id="e-fee" class="tax-input" value="${t.feeSEK || 0}" step="any">
            </div>
          </div>
          ${t.category === 'trade' ? `
          <div class="tax-form-grid">
            <div class="tax-form-group">
              <label>Received Asset</label>
              <input type="text" id="e-inasset" class="tax-input" value="${t.inAsset || ''}">
            </div>
            <div class="tax-form-group">
              <label>Received Amount</label>
              <input type="number" id="e-inamt" class="tax-input" value="${t.inAmount || 0}" step="any">
            </div>
          </div>`: ''}
          <div class="tax-form-group">
            <label>Notes</label>
            <input type="text" id="e-notes" class="tax-input" value="${t.notes || ''}">
          </div>
          <label class="tax-check-label">
            <input type="checkbox" id="e-reviewed" ${!t.needsReview ? 'checked' : ''}>
            Mark as reviewed
          </label>
        </div>
        <div class="tax-modal-footer">
          <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeEdit()">Cancel</button>
          <button class="tax-btn tax-btn-primary" onclick="TaxUI.saveEdit('${t.id}')">Save</button>
        </div>
      </div></div>`;
  }

  // ════════════════════════════════════════════════════════════
  // ── Confidence badge for a priced/unpriced transaction ─────
  function confidenceBadge(txn) {
    const ps = txn.priceSource, pc = txn.priceConfidence;
    if (!ps || ps === 'missing') return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(239,68,68,.12);color:#f87171;font-weight:600" title="No price found">missing</span>';
    if (ps === 'manual')               return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(99,102,241,.15);color:#818cf8" title="Price entered manually">manual</span>';
    if (ps === 'trade_exact')          return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(34,197,94,.12);color:#4ade80" title="Exact exchange price">exact</span>';
    if (ps === 'swap_implied')         return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(251,191,36,.12);color:#fbbf24" title="Derived from swap counterpart">swap-leg</span>';
    if (ps === 'back_derived')         return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(251,191,36,.10);color:#fbbf24" title="Inferred from later disposal price">back-derived</span>';
    if (ps === 'stable_historical_fx' || ps === 'stable_approx') return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(34,197,94,.10);color:#4ade80" title="Stablecoin × FX rate">stable</span>';
    if (ps === 'spam_zero' || pc === 'spam_zero') return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(107,114,128,.12);color:#9ca3af" title="Auto-detected spam">spam</span>';
    // market_api / dex_market → "inferred"
    return '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(99,102,241,.12);color:#a5b4fc" title="Historical market price">inferred</span>';
  }

  // ── Suggested-action button for a single review row ─────────
  function suggestedActionBtn(issue) {
    const { txn, suggestedAction, reason } = issue;
    if (reason === 'received_not_sold') {
      return `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.markReviewed('${txn.id}')" title="Ignore — this token was never sold, no K4 impact">Ignore</button>`;
    }
    switch (suggestedAction) {
      case 'rerun_pipeline':
        return `<button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.2)" onclick="TaxUI.triggerPipeline()" title="Has a priced swap partner — re-run pipeline to resolve">Re-run pipeline</button>`;
      case 'batch_price_lookup':
        return `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.bulkShowPriceSearch('missing_sek_price')" title="Known token — fetch historical price from API">Fetch price</button>`;
      case 'mark_spam':
        return `<button class="tax-btn tax-btn-xs" style="background:rgba(107,114,128,.1);color:#9ca3af;border:1px solid rgba(107,114,128,.2)" onclick="TaxUI.markSpam('${txn.id}')" title="Looks like spam or worthless token — set to zero value">Mark spam</button>`;
      case 'enter_price':
      default:
        return `<button class="tax-btn tax-btn-xs tax-btn-primary" onclick="TaxUI.editTx('${txn.id}')" title="Enter SEK price manually">Enter price</button>`;
    }
  }

  // ── Render a single review row ────────────────────────────────
  function renderReviewRow(issue) {
    const { txn, isK4Blocker: itemK4 } = issue;
    const td = TaxEngine.resolveTokenDisplay ? TaxEngine.resolveTokenDisplay(txn.assetSymbol) : { symbol: txn.assetSymbol, name: '' };
    const displaySym  = td.symbol || txn.assetSymbol || '?';
    const displayName = td.name || txn.assetName || '';
    const acct        = TaxEngine.getAccounts().find(a => a.id === txn.accountId);
    const acctLabel   = acct ? (acct.label || acct.type || acct.id.slice(-6)) : 'Unknown wallet';
    const blockInfo   = issue.priceBlockReason ? BLOCK_REASON_LABELS[issue.priceBlockReason] : null;
    return `
    <div class="tax-review-item">
      <div class="tax-ri-left" style="flex:1;min-width:0">
        <span class="tax-asset-sym" title="${txn.assetSymbol}">${displaySym}</span>
        ${displayName && displayName !== displaySym ? `<span style="font-size:11px;color:var(--tax-muted);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${displayName}">${displayName}</span>` : ''}
        <span class="tax-mono" style="font-size:12px">${TaxEngine.formatCrypto(txn.amount, 6)}</span>
        <span class="tax-muted" style="font-size:11px">${fmtDateShort(txn.date)}</span>
        ${txn.category ? `<span class="tax-badge" style="font-size:10px">${txn.category}</span>` : ''}
        <span class="tax-badge" style="font-size:10px;opacity:.6">${acctLabel}</span>
        ${itemK4 ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.12);color:#f87171;font-weight:600">K4</span>` : ''}
        ${txn.isDuplicate ? `<span class="tax-badge" style="background:rgba(239,68,68,.1);color:#f87171;font-size:10px">DUP</span>` : ''}
        ${confidenceBadge(txn)}
        ${blockInfo ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(148,163,184,.08);color:#64748b;border:1px solid rgba(148,163,184,.15)" title="${blockInfo.tip}">${blockInfo.label}</span>` : ''}
      </div>
      <div class="tax-ri-right">
        ${suggestedActionBtn(issue)}
        <button class="tax-btn tax-btn-xs" style="color:#94a3b8" onclick="TaxUI.editTx('${txn.id}')" title="Edit transaction">✏️</button>
        <button class="tax-btn tax-btn-xs" style="color:#64748b" onclick="TaxUI.markSpam('${txn.id}')" title="Mark as spam (zero value)">🚫</button>
        <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.markReviewed('${txn.id}')" title="Dismiss">OK</button>
      </div>
    </div>`;
  }

  // REVIEW PAGE — exceptions only
  // ════════════════════════════════════════════════════════════
  function renderReview() {
    const taxResult  = S.taxResult || null;
    const issues     = TaxEngine.getReviewIssues(null, taxResult);
    const groups     = groupByReason(issues);
    const collapsed  = S.collapsedGroups || new Set(['received_not_sold']);

    const k4Blockers     = issues.filter(i => i.isK4Blocker || ['negative_balance','unknown_acquisition'].includes(i.reason)).length;
    const warnings       = issues.filter(i => ['duplicate','unmatched_transfer','outlier','split_trade'].includes(i.reason)).length;
    const lowPri         = issues.filter(i => i.priority === 'low' || ['received_not_sold','spam_token'].includes(i.reason)).length;
    const trueIssues     = issues.length - lowPri;
    const receivedUnsold = issues.filter(i => i.reason === 'received_not_sold').length;
    const missingTotal   = issues.filter(i => i.reason === 'missing_sek_price').length;

    // Determine how many of the missing-price items can potentially be auto-resolved
    const canAutoInfer = issues.filter(i =>
      i.reason === 'missing_sek_price' && ['market_api_failed','swap_inference_failed'].includes(i.priceBlockReason)
    ).length;

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Review</h1>
          <span class="tax-page-subtitle">${trueIssues} exception${trueIssues !== 1 ? 's' : ''} require attention${lowPri > 0 ? ` · ${lowPri} informational` : ''}</span>
          ${issues.length > 0 ? `
            <div class="tax-page-actions" style="gap:8px">
              ${canAutoInfer > 0 ? `<button class="tax-btn tax-btn-sm" style="background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.25)" onclick="TaxUI.bulkAutoInfer()">🔁 Auto-infer ${canAutoInfer}</button>` : ''}
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">⚙️ Re-run pipeline</button>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.markAllReviewed()">✓ Mark all OK</button>
            </div>` : ''}
        </div>

        ${issues.length === 0 ? `
          <div class="tax-review-done">
            <div style="font-size:48px">✅</div>
            <div class="tax-review-done-title">All clear!</div>
            <div class="tax-review-done-sub">No exceptions. Tax calculations are based on complete data.</div>
          </div>
        ` : `
          <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
            ${k4Blockers > 0 ? `<div style="padding:6px 12px;border-radius:8px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#f87171;font-size:12px;font-weight:600">🔴 ${k4Blockers} K4 blocker${k4Blockers !== 1 ? 's' : ''}</div>` : ''}
            ${warnings > 0 ? `<div style="padding:6px 12px;border-radius:8px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.25);color:#fbbf24;font-size:12px;font-weight:600">🟡 ${warnings} warning${warnings !== 1 ? 's' : ''}</div>` : ''}
            ${receivedUnsold > 0 ? `<div style="padding:6px 12px;border-radius:8px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.15);color:#818cf8;font-size:12px;cursor:pointer" onclick="TaxUI.toggleReviewGroup('received_not_sold')">📥 ${receivedUnsold} received-not-sold ${collapsed.has('received_not_sold') ? '▶' : '▼'}</div>` : ''}
            ${canAutoInfer > 0 ? `<div style="padding:6px 12px;border-radius:8px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.15);color:#a5b4fc;font-size:12px">💡 ${canAutoInfer} may auto-resolve</div>` : ''}
          </div>

          <div class="tax-review-groups">
            ${groups.map(({ reason, meta, items, subGroups }) => {
              const isK4Critical = items.some(i => i.isK4Blocker) || ['negative_balance','unknown_acquisition'].includes(reason);
              const isCritical   = isK4Critical || ['missing_sek_price','unknown_asset','ambiguous_swap'].includes(reason);
              const isLowPri     = ['received_not_sold','spam_token'].includes(reason);
              const isCollapsed  = collapsed.has(reason);
              const borderColor  = isK4Critical ? 'rgba(239,68,68,.3)' : isCritical ? 'rgba(239,68,68,.2)' : isLowPri ? 'rgba(99,102,241,.08)' : 'rgba(99,102,241,.15)';
              const badgeBg      = isK4Critical ? 'rgba(239,68,68,.25)' : isLowPri ? 'rgba(99,102,241,.12)' : 'rgba(251,191,36,.15)';
              const badgeColor   = isK4Critical ? '#f87171' : isLowPri ? '#818cf8' : '#fbbf24';

              // Per-group bulk action buttons
              const bulkActions = (meta.bulkActions || []).map(action => {
                switch (action) {
                  case 'mark_spam':       return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkMarkSpam('${reason}')">🚫 Mark all spam</button>`;
                  case 'enter_price':     return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkShowPriceSearch('${reason}')">💰 Batch price lookup</button>`;
                  case 'mark_zero_cost':  return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkZeroCost('${reason}')">0️⃣ Set zero cost</button>`;
                  case 'mark_income':     return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkReclassify('${reason}','income')">💼 Reclassify as income</button>`;
                  case 'ignore_received': return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkMarkReviewed('${reason}')">✓ Ignore all</button>`;
                  case 'confirm_spam':    return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkMarkReviewed('${reason}')">✓ Confirm spam</button>`;
                  default: return '';
                }
              }).join('');

              // For missing_sek_price, add an auto-infer button when applicable
              const extraBulk = reason === 'missing_sek_price'
                ? `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.bulkAutoInfer()">🔁 Auto-infer all</button>`
                : '';

              return `
              <div class="tax-review-group" style="border-color:${borderColor}">
                <div class="tax-review-group-header" style="cursor:pointer" onclick="TaxUI.toggleReviewGroup('${reason}')">
                  <span class="tax-review-group-icon">${meta.icon}</span>
                  <div style="flex:1">
                    <div class="tax-review-group-title">
                      ${meta.label}
                      <span class="tax-section-count" style="background:${badgeBg};color:${badgeColor}">${items.length}</span>
                      ${isK4Critical ? '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,.15);color:#f87171;margin-left:4px;font-weight:600">K4 BLOCKER</span>' : ''}
                      ${isLowPri ? '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(99,102,241,.08);color:#818cf8;margin-left:4px">informational</span>' : ''}
                    </div>
                    <div class="tax-review-group-why">${meta.why}</div>
                  </div>
                  <span style="color:var(--tax-muted);font-size:12px;margin-left:8px">${isCollapsed ? '▶' : '▼'}</span>
                </div>
                ${isCollapsed ? '' : `
                <div class="tax-review-fix-tip">
                  💡 ${meta.fix}
                  ${reason === 'duplicate' ? `<button class="tax-btn tax-btn-xs" style="margin-left:8px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)" onclick="TaxUI.deleteDuplicates()">🗑 Delete all duplicates</button>` : ''}
                  <span style="display:inline-flex;gap:6px;margin-left:8px">${extraBulk}${bulkActions}</span>
                </div>
                <div class="tax-review-items">
                  ${subGroups && subGroups.length > 1
                    ? subGroups.map(sg => `
                        <div style="padding:6px 12px 4px;background:rgba(148,163,184,.04);border-bottom:1px solid rgba(148,163,184,.08)">
                          <span style="font-size:11px;font-weight:600;color:#64748b">${sg.label}</span>
                          <span style="font-size:10px;color:#475569;margin-left:6px">${sg.items.length} transaction${sg.items.length !== 1 ? 's' : ''}</span>
                          ${sg.tip ? `<span style="font-size:10px;color:#475569;margin-left:8px">· ${sg.tip}</span>` : ''}
                        </div>
                        ${sg.items.map(issue => renderReviewRow(issue)).join('')}
                      `).join('')
                    : items.map(issue => renderReviewRow(issue)).join('')
                  }
                </div>`}
              </div>`;
            }).join('')}
          </div>
        `}

        ${S.editTxId ? renderEditModal() : ''}
      </div>
    `;
  }

  // Human-readable labels for priceBlockReason values
  const BLOCK_REASON_LABELS = {
    no_market_listing:      { label: 'No market listing',     tip: 'Not listed on CoinGecko/CoinMarketCap — price must come from swap context or be entered manually.' },
    no_priced_swap_leg:     { label: 'No priced swap leg',    tip: 'Part of a swap where the counterpart asset also has no price — enter the price of either side.' },
    market_api_failed:      { label: 'Price API failed',      tip: 'Listed token but price API returned no data for this date — try Batch Price Lookup.' },
    swap_inference_failed:  { label: 'Inference failed',      tip: 'Has a priced swap partner but derivation failed — try re-running the pipeline.' },
    no_swap_context:        { label: 'No transaction context', tip: 'Standalone transaction with no swap data — price must be entered manually.' },
  };

  function groupByReason(issues) {
    const groups = {};
    for (const issue of issues) {
      if (!groups[issue.reason]) groups[issue.reason] = { reason: issue.reason, meta: issue.meta, items: [], hasK4: false, subGroups: null };
      groups[issue.reason].items.push(issue);
      if (issue.isK4Blocker) groups[issue.reason].hasK4 = true;
    }
    // For missing_sek_price, build sub-groups by priceBlockReason
    if (groups.missing_sek_price) {
      const subMap = {};
      for (const issue of groups.missing_sek_price.items) {
        const key = issue.priceBlockReason || 'no_swap_context';
        if (!subMap[key]) subMap[key] = [];
        subMap[key].push(issue);
      }
      // Sub-group order: API failed first (easiest to fix) → no_priced_swap_leg → no_market_listing → rest
      const SUB_ORDER = ['swap_inference_failed','market_api_failed','no_priced_swap_leg','no_market_listing','no_swap_context'];
      groups.missing_sek_price.subGroups = Object.entries(subMap).sort(([a],[b]) => {
        const ai = SUB_ORDER.indexOf(a), bi = SUB_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }).map(([key, items]) => ({ key, ...BLOCK_REASON_LABELS[key], items }));
    }
    // Return in priority order
    const ORDER = [
      'unknown_acquisition','negative_balance','missing_sek_price','unknown_asset',
      'duplicate','ambiguous_swap','unmatched_transfer','outlier','split_trade',
      'unknown_contract','unsupported_defi','special_transaction','bridge_review',
      'unclassified','received_not_sold','spam_token',
    ];
    return Object.values(groups).sort((a, b) => {
      const ai = ORDER.indexOf(a.reason); const bi = ORDER.indexOf(b.reason);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }

  // ════════════════════════════════════════════════════════════
  // REPORTS PAGE — K4 Section D, per-asset grouping
  // ════════════════════════════════════════════════════════════
  function renderReports() {
    const result = getOrComputeTaxResult();
    const { summary, disposals } = result;
    const k4 = TaxEngine.generateK4Report(result);
    const issues = TaxEngine.getReviewIssues(null, result).length;
    const deductibleLoss = summary.deductibleLoss || (summary.totalLosses * 0.70);

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Tax Reports</h1>
          <span class="tax-page-subtitle">${S.taxYear} — Skatteverket K4</span>
        </div>

        ${issues > 0 ? `
        <div class="tax-warn-box" style="margin-bottom:16px">
          ⚠️ ${issues} transactions still need review. Tax results may be incomplete.
          <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.navigate('review')" style="margin-left:8px">Fix →</button>
        </div>` : ''}

        <div class="tax-user-info-bar" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px 16px;background:rgba(255,255,255,.03);border:1px solid var(--tax-border);border-radius:10px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--tax-muted);white-space:nowrap">K4 Uppgifter:</span>
          <input id="tax-user-name" class="tax-input" type="text" placeholder="Namn" value="${S.userName || ''}" onchange="TaxUI.setUserInfo('name', this.value)" style="width:200px;height:30px;font-size:12px">
          <input id="tax-user-pnr" class="tax-input" type="text" placeholder="Personnummer (YYYYMMDD-XXXX)" value="${S.userPnr || ''}" onchange="TaxUI.setUserInfo('pnr', this.value)" style="width:220px;height:30px;font-size:12px">
        </div>

        <div class="tax-report-hero">
          <div class="tax-rh-year">${S.taxYear}</div>
          <div class="tax-rh-title">Sammanfattning — Inkomstdeklaration 1</div>
          <div class="tax-rh-grid">
            <div class="tax-rh-item">
              <div class="tax-rh-label">Summa vinst (K4 Sektion D)</div>
              <div class="tax-rh-label-sub">→ Ruta 7.5 i deklarationen</div>
              <div class="tax-rh-val tax-green">${TaxEngine.formatSEK(k4.totalGains)}</div>
            </div>
            <div class="tax-rh-item">
              <div class="tax-rh-label">Summa förlust (K4 Sektion D)</div>
              <div class="tax-rh-label-sub">→ Ruta 8.4 i deklarationen</div>
              <div class="tax-rh-val tax-red">${TaxEngine.formatSEK(k4.totalLosses)}</div>
            </div>
            <div class="tax-rh-item">
              <div class="tax-rh-label">Avdragsgill förlust (70%)</div>
              <div class="tax-rh-label-sub">Skrivs in i ruta 8.4</div>
              <div class="tax-rh-val tax-amber">${TaxEngine.formatSEK(deductibleLoss)}</div>
            </div>
            <div class="tax-rh-item tax-rh-highlight">
              <div class="tax-rh-label">Skattepliktig vinst (netto)</div>
              <div class="tax-rh-label-sub">Vinst − avdragsgill förlust</div>
              <div class="tax-rh-val">${TaxEngine.formatSEK(summary.taxableGain)}</div>
            </div>
          </div>
          <div class="tax-rh-tax-est">
            <span class="tax-rh-tax-label">Beräknad skatt (30%)</span>
            <span class="tax-rh-tax-val">${TaxEngine.formatSEK(summary.estimatedTax)}</span>
          </div>
          ${(summary.totalProceeds || 0) > 0 ? `
          <div class="tax-rh-detail-row">
            <span>Totalt försäljningspris: <strong>${TaxEngine.formatSEK(summary.totalProceeds)}</strong></span>
            <span>Totalt omkostnadsbelopp: <strong>${TaxEngine.formatSEK(summary.totalCostBasis || 0)}</strong></span>
            <span>Antal avyttringar: <strong>${disposals.length}</strong></span>
          </div>` : ''}
        </div>

        <!-- K4 Preview Table -->
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>K4 Sektion D — Kryptovalutor</h2>
            ${k4.formsNeeded > 1 ? `<span class="tax-badge" style="background:rgba(99,102,241,.15);color:#818cf8">${k4.formsNeeded} blanketter</span>` : ''}
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
              <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.downloadK4PDF()" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none">📄 K4 PDF (officiell)</button>
              <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.downloadAccountantReport()" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);border:none" title="Detaljerad rapport med alla transaktioner och kostnadsbas">📊 Revisionsrapport PDF</button>
              <button class="tax-btn tax-btn-sm tax-btn-secondary" onclick="TaxUI.downloadK4CSV()">⬇ K4 CSV</button>
              <button class="tax-btn tax-btn-sm tax-btn-secondary" onclick="TaxUI.downloadAuditCSV()">⬇ Transaktionslogg</button>
              <button class="tax-btn tax-btn-sm tax-btn-secondary" onclick="TaxUI.downloadHoldingsCSV()">⬇ Innehavsrapport</button>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.printReport()">🖨 Skriv ut</button>
            </div>
          </div>

          <div class="tax-k4-explainer">
            Förenklad metod: en rad per tillgång och vinstsida. Fyll i värdena i K4-blankettens Sektion D.
            Genomsnittsmetoden (SFS 1999:1229 44 kap. 7§) har använts.
          </div>

          ${k4.k4Rows.length === 0
        ? renderEmpty(`Inga avyttringar ${S.taxYear}`, 'No disposals found for this tax year.', '📊')
        : `<div class="tax-table-wrap"><table class="tax-table tax-k4-preview">
                <thead><tr>
                  <th>Beteckning/Valutakod</th>
                  <th class="ta-r">Antal/Belopp</th>
                  <th class="ta-r">Försäljningspris (SEK)</th>
                  <th class="ta-r">Omkostnadsbelopp (SEK)</th>
                  <th class="ta-r">Vinst</th>
                  <th class="ta-r">Förlust</th>
                </tr></thead>
                <tbody>
                  ${k4.k4Rows.map((r, i) => `
                    <tr class="${(i + 1) % ROWS_PER_K4_FORM === 0 && i !== k4.k4Rows.length - 1 ? 'tax-k4-page-break' : ''}">
                      <td>
                        <div class="tax-asset-cell">
                          <span class="tax-asset-name">${r.displayName || r.sym}</span>
                          <span class="tax-badge" style="margin-left:6px;${r.side === 'gain' ? 'background:rgba(34,197,94,.1);color:#4ade80' : 'background:rgba(239,68,68,.1);color:#f87171'}">${r.side === 'gain' ? 'Vinst' : 'Förlust'}</span>
                        </div>
                      </td>
                      <td class="ta-r tax-mono">${TaxEngine.formatCrypto(r.qty, 8)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(r.proc)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(r.cost)}</td>
                      <td class="ta-r tax-mono ${r.gain > 0 ? 'tax-green' : ''}">${r.gain ? TaxEngine.formatSEK(r.gain) : ''}</td>
                      <td class="ta-r tax-mono ${r.loss > 0 ? 'tax-red' : ''}">${r.loss ? TaxEngine.formatSEK(r.loss) : ''}</td>
                    </tr>`).join('')}
                  <tr class="tax-k4-sum-row">
                    <td colspan="4"><strong>Summa</strong></td>
                    <td class="ta-r tax-green"><strong>${TaxEngine.formatSEK(k4.totalGains)}</strong></td>
                    <td class="ta-r tax-red"><strong>${TaxEngine.formatSEK(k4.totalLosses)}</strong></td>
                  </tr>
                  <tr class="tax-k4-net-row">
                    <td colspan="4" style="font-size:11px;color:var(--tax-muted)">
                      Skattepliktig vinst = ${TaxEngine.formatSEK(k4.totalGains)} − (${TaxEngine.formatSEK(k4.totalLosses)} × 70%)
                    </td>
                    <td colspan="2" class="ta-r" style="font-size:12px;font-weight:600;color:#e2e8f0">
                      = ${TaxEngine.formatSEK(summary.taxableGain)}
                    </td>
                  </tr>
                </tbody>
              </table></div>`
      }
        </div>

        <div class="tax-disclaimer">
          <span>⚠️</span>
          <div><strong>OBS!</strong> Dessa beräkningar är uppskattningar. Genomsnittsmetoden (SFS 1999:1229 44 kap. 7§) har använts. Kontrollera alltid med en auktoriserad skatterådgivare innan du lämnar in din deklaration. Du är ansvarig för korrekta uppgifter till Skatteverket.</div>
        </div>
      </div>
    `;
  }

  const ROWS_PER_K4_FORM = 7; // for page break marker

  // ════════════════════════════════════════════════════════════
  // ADMIN PAGE  (inline replica of the admin panel for admins)
  // ════════════════════════════════════════════════════════════

  function renderAdminPage() {
    // Kick off the async admin panel render in the container after mount
    setTimeout(() => {
      const el = document.getElementById('tax-admin-inner');
      if (el && typeof renderAdminPanel === 'function') renderAdminPanel();
      // Patch renderAdminPanel to target tax-admin-inner when we're in the tax admin page
      if (el) { window._taxAdminTarget = el; }
    }, 0);

    return `
      <div class="tax-page tax-page--admin">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Admin</h1>
          <span class="tax-page-subtitle">Users, API keys, and system settings</span>
        </div>
        <div id="tax-admin-inner" class="tax-admin-inner">
          <div style="color:var(--text-muted);padding:24px;text-align:center">Loading admin panel…</div>
        </div>
      </div>`;
  }

  // ════════════════════════════════════════════════════════════
  // ACTIONS
  // ════════════════════════════════════════════════════════════

  // ── Add-Account modal (Koinly-style search + grid) ────────
  function openAddAccountModal()  { S.addAccountModal = true; _accSearch = ''; _accFilter = 'all'; render(); }
  function closeAddAccountModal() { S.addAccountModal = false; render(); }
  function accSearch(q) {
    _accSearch = q || '';
    const grid = document.querySelector('.acc-modal-grid');
    // Live filter without full re-render for performance
    if (grid) { render(); return; }
    render();
  }
  function accFilter(f) { _accFilter = f; render(); }

  function openImport(type) {
    S.importModal = type; S.importNetwork = null;
    S.walletModalTab = 'auto'; S.walletImportFrom = 'beginning'; S.walletImportDate = '';
    render();
  }
  function selectNetwork(netId) { S.importNetwork = netId; render(); }
  function closeImport() { S.importModal = null; S.importNetwork = null; _pendingCSVText = null; render(); }

  // Wallet modal tab & import-date helpers
  function setWalletTab(tab) { S.walletModalTab = tab; render(); }
  function setImportFrom(mode) { S.walletImportFrom = mode; render(); }
  function setWalletImportDate(date) { S.walletImportDate = date; }

  function createEmptyWallet(chain, chainId) {
    const label = document.getElementById('tax-wallet-label-empty')?.value?.trim();
    if (!label) { showTaxToast('⚠️', 'Ange ett plånboksnamn'); return; }
    const src = ACC_SOURCES.find(s => s.type === S.importModal);
    const net = src?.networks?.find(n => n.id === S.importNetwork) || src?.networks?.[0];
    const accType = chain === 'sol' ? (S.importModal || 'phantom')
      : chain === 'sui' ? 'sui'
      : (S.importModal === 'phantom' ? 'phantom_eth' : (S.importModal || 'metamask'));
    TaxEngine.addAccount({ type: accType, label, address: '', network: net?.id || chain });
    closeImport();
    showTaxToast('✅', 'Tom plånbok skapad', label);
  }

  function setFilter(key, val) { S.txFilter[key] = val; S.txPage = 0; reRenderMain(); }
  function sortTxns(field) {
    S.txSort.dir = S.txSort.field === field ? (S.txSort.dir === 'asc' ? 'desc' : 'asc') : 'desc';
    S.txSort.field = field;
    reRenderMain();
  }
  function setPage(p) { S.txPage = p; reRenderMain(); }

  // ── Expanded row & tabs ────────────────────────────────────
  function expandTxRow(id) {
    S.expandedTxId = S.expandedTxId === id ? null : id;
    S.expandedTxTab = 'description';
    reRenderMain();
  }
  function setExpandedTab(tab) { S.expandedTxTab = tab; reRenderMain(); }

  // ── Add-transaction menu ───────────────────────────────────
  function toggleAddTxMenu() {
    S.addTxMenuOpen = !S.addTxMenuOpen;
    reRenderMain();
  }

  // ── Filter menus (pill dropdowns — inline for now) ─────────
  function toggleTxTypeMenu(event) {
    // Simple inline prompt; a full dropdown overlay would need more state
    const val = window.prompt(
      'Ange typ (buy/sell/trade/receive/send/income/fee/transfer_in/transfer_out/staking/bridge/nft_sale/spam/defi_unknown)\n\nLämna tomt för "Alla typer":',
      S.txFilter.category === 'all' ? '' : S.txFilter.category
    );
    if (val === null) return; // cancelled
    S.txFilter.category = val.trim() || 'all';
    S.txPage = 0;
    reRenderMain();
  }
  function toggleTxWalletMenu(event) {
    const accounts = TaxEngine.getAccounts();
    const opts = ['all', ...accounts.map(a => a.id)];
    const labels = ['Alla plånböcker', ...accounts.map(a => a.label || a.type)];
    const current = opts.indexOf(S.txFilter.account);
    const next = (current + 1) % opts.length;
    S.txFilter.account = opts[next];
    S.txPage = 0;
    reRenderMain();
  }
  function toggleTxLabelMenu(event) {
    const labels = ['all', 'staking', 'mining', 'airdrop', 'gift'];
    const current = labels.indexOf(S.txLabelFilter);
    S.txLabelFilter = labels[(current + 1) % labels.length];
    S.txPage = 0;
    reRenderMain();
  }

  // ── Manual row CRUD ────────────────────────────────────────
  function addManualRow(type) {
    const today = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    S.manualTxRows.push({
      _id: Date.now() + Math.random(),
      type: type || 'receive',
      label: '',
      wallet: TaxEngine.getAccounts()[0]?.id || '',
      date: today,
      sentAmt: '', sentCcy: '',
      recAmt: '',  recCcy: '',
      feeAmt: '',  feeCcy: 'ETH',
    });
    S.addTxMenuOpen = false;
    reRenderMain();
  }
  function removeManualRow(i) { S.manualTxRows.splice(i, 1); reRenderMain(); }
  function duplicateManualRow(i) { S.manualTxRows.splice(i + 1, 0, { ...S.manualTxRows[i], _id: Date.now() }); reRenderMain(); }
  function updateManualRow(i, key, val) { if (S.manualTxRows[i]) S.manualTxRows[i][key] = val; }
  function cancelManualRows() { S.manualTxRows = []; reRenderMain(); }
  function submitManualRows() {
    const toAdd = S.manualTxRows.map(row => {
      const isOutgoing = ['sell','send','transfer_out','fee'].includes(row.type);
      const isSwap = row.type === 'trade';
      const assetSym = isOutgoing || isSwap ? (row.sentCcy || '').toUpperCase() : (row.recCcy || '').toUpperCase();
      const amount = parseFloat(isOutgoing || isSwap ? row.sentAmt : row.recAmt) || 0;
      return TaxEngine.normalizeTransaction({
        txHash: `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
        type: row.type,
        assetSymbol: assetSym,
        amount,
        inAsset: isSwap ? (row.recCcy || '').toUpperCase() : undefined,
        inAmount: isSwap ? (parseFloat(row.recAmt) || 0) : undefined,
        feeSEK: 0,
        notes: row.label ? `Etikett: ${row.label}` : 'Manuell transaktion',
        needsReview: true,
      }, row.wallet, 'manual');
    }).filter(t => t && t.assetSymbol && t.amount > 0);

    if (toAdd.length > 0) {
      TaxEngine.addTransactions(toAdd);
      S.taxResult = null;
    }
    S.manualTxRows = [];
    reRenderMain();
    if (toAdd.length > 0) {
      showTaxToast('✅', `${toAdd.length} transaktion${toAdd.length !== 1 ? 'er' : ''} tillagda`, 'Kör pipeline för att beräkna skatt.', 'success');
    }
  }

  // ── Bulk merge helpers ─────────────────────────────────────
  function mergeSameHash() {
    const ids = [...S.selectedTxIds];
    if (ids.length < 2) { showTaxToast('ℹ️', 'Välj minst 2 transaktioner'); return; }
    // If all have same txHash, mark as internal transfer pair
    const txns = TaxEngine.getTransactions().filter(t => ids.includes(t.id));
    const hashes = [...new Set(txns.map(t => t.txHash).filter(Boolean))];
    if (hashes.length === 1) {
      // Mark both as internal transfers
      ids.forEach(id => TaxEngine.updateTransaction(id, { isInternalTransfer: true, needsReview: false }));
      showTaxToast('✅', 'Markerade som intern överföring', `${ids.length} transaktioner`);
    } else {
      showTaxToast('ℹ️', 'Olika TxHash', 'Välj transaktioner med samma TxHash för att slå ihop.');
    }
    S.selectedTxIds.clear();
    S.taxResult = null;
    reRenderMain();
  }
  function mergeTrade() {
    const ids = [...S.selectedTxIds];
    if (ids.length !== 2) { showTaxToast('ℹ️', 'Välj exakt 2 transaktioner för att skapa ett trade'); return; }
    const txns = TaxEngine.getTransactions().filter(t => ids.includes(t.id));
    const out = txns.find(t => ['sell','send'].includes(t.category));
    const inT = txns.find(t => ['buy','receive'].includes(t.category));
    if (!out || !inT) { showTaxToast('ℹ️', 'En måste vara utgående och en inkommande'); return; }
    TaxEngine.updateTransaction(out.id, {
      category: 'trade', type: 'trade',
      inAsset: inT.assetSymbol, inAmount: inT.amount,
      needsReview: false,
    });
    TaxEngine.deleteTransaction(inT.id);
    S.selectedTxIds.clear();
    S.taxResult = null;
    reRenderMain();
    showTaxToast('✅', 'Byte skapat', `${out.assetSymbol} → ${inT.assetSymbol}`);
  }
  function mergeTransfer() {
    const ids = [...S.selectedTxIds];
    if (ids.length !== 2) { showTaxToast('ℹ️', 'Välj exakt 2 transaktioner'); return; }
    const txns = TaxEngine.getTransactions().filter(t => ids.includes(t.id));
    ids.forEach(id => TaxEngine.updateTransaction(id, { isInternalTransfer: true, needsReview: false }));
    S.selectedTxIds.clear();
    S.taxResult = null;
    reRenderMain();
    showTaxToast('✅', 'Markerade som intern överföring');
  }
  function mergeMultipleTransfers() {
    const ids = [...S.selectedTxIds];
    ids.forEach(id => TaxEngine.updateTransaction(id, { isInternalTransfer: true, needsReview: false }));
    S.selectedTxIds.clear();
    S.taxResult = null;
    reRenderMain();
    showTaxToast('✅', `${ids.length} transaktioner markerade som interna överföringar`);
  }
  function openCal(field) { S.calField = field; S.calOpen = true; S.calMonth = new Date().getMonth(); S.calYear = new Date().getFullYear(); reRenderMain(); }
  function closeCal() { S.calOpen = false; reRenderMain(); }
  function calNav(d) { S.calMonth += d; if (S.calMonth > 11) { S.calMonth = 0; S.calYear++; } if (S.calMonth < 0) { S.calMonth = 11; S.calYear--; } reRenderMain(); }
  function selectDate(ds) { if (S.calField === 'from') S.txFilter.dateFrom = ds; else S.txFilter.dateTo = ds; S.calOpen = false; reRenderMain(); }

  function editTx(id) { S.editTxId = id; reRenderMain(); }
  function closeEdit() { S.editTxId = null; S.taxResult = null; render(); }
  function deleteTx(id) {
    if (!confirm('Delete this transaction? This will affect tax calculations.')) return;
    TaxEngine.deleteTransaction(id); S.selectedTxIds.delete(id); S.taxResult = null; reRenderMain();
  }

  // ── Selection & Bulk Delete ─────────────────────────────
  function toggleSelectAll(checked) {
    const allTxns = TaxEngine.getTransactions();
    const filtered = filterTxns(allTxns);
    const sorted = sortTxnsArr(filtered);
    // Select/deselect ALL filtered transactions, not just the current page
    if (checked) {
      for (const t of sorted) S.selectedTxIds.add(t.id);
    } else {
      for (const t of sorted) S.selectedTxIds.delete(t.id);
    }
    reRenderMain();
  }

  function toggleSelectTx(id, checked) {
    if (checked) S.selectedTxIds.add(id);
    else S.selectedTxIds.delete(id);
    reRenderMain();
  }

  function deleteSelected() {
    const count = S.selectedTxIds.size;
    if (!count) return;
    if (!confirm(`Delete ${count.toLocaleString()} selected transaction${count > 1 ? 's' : ''}?\n\nThis cannot be undone and will affect tax calculations.`)) return;
    const txns = TaxEngine.getTransactions().filter(t => !S.selectedTxIds.has(t.id));
    TaxEngine.saveTransactions(txns);
    S.selectedTxIds.clear();
    S.taxResult = null;
    S.portfolioSnap = null; S.portfolioHist = null;
    showTaxToast('🗑', 'Deleted', `${count.toLocaleString()} transactions removed.`, 'success');
    render();
  }

  function deleteAllFiltered(count) {
    const allTxns = TaxEngine.getTransactions();
    const filtered = filterTxns(allTxns);
    const total = allTxns.length;
    const isAll = filtered.length === total;
    const label = isAll
      ? `ALL ${total.toLocaleString()} transactions`
      : `${filtered.length.toLocaleString()} filtered transactions (${total.toLocaleString()} total)`;
    if (!confirm(`⚠️ Delete ${label}?\n\nThis cannot be undone and will affect your tax calculations.`)) return;
    const filteredIds = new Set(filtered.map(t => t.id));
    TaxEngine.saveTransactions(allTxns.filter(t => !filteredIds.has(t.id)));
    S.selectedTxIds.clear();
    S.taxResult = null;
    S.portfolioSnap = null; S.portfolioHist = null;
    showTaxToast('🗑', 'Deleted', `${filtered.length.toLocaleString()} transactions removed.`, 'success');
    render();
  }

  function clearSelection() {
    S.selectedTxIds.clear();
    reRenderMain();
  }
  function saveEdit(id) {
    const d = document.getElementById('e-date')?.value;
    const cat = document.getElementById('e-cat')?.value;
    const sym = document.getElementById('e-sym')?.value?.toUpperCase();
    const amt = parseFloat(document.getElementById('e-amt')?.value) || 0;
    const price = parseFloat(document.getElementById('e-price')?.value) || 0;
    const fee = parseFloat(document.getElementById('e-fee')?.value) || 0;
    const notes = document.getElementById('e-notes')?.value || '';
    const rev = document.getElementById('e-reviewed')?.checked;
    const inAsset = document.getElementById('e-inasset')?.value?.toUpperCase() || undefined;
    const inAmount = parseFloat(document.getElementById('e-inamt')?.value) || undefined;
    TaxEngine.updateTransaction(id, {
      date: d ? new Date(d).toISOString() : undefined, category: cat,
      assetSymbol: sym, amount: amt, priceSEKPerUnit: price,
      costBasisSEK: price * amt, feeSEK: fee, notes,
      needsReview: !rev, reviewReason: rev ? null : undefined,
      manualCategory: true, priceSource: 'manual',
      ...(inAsset ? { inAsset, inAmount } : {}),
    });
    S.editTxId = null; S.taxResult = null; render();
    showTaxToast('✅', 'Transaction updated');
  }

  function markReviewed(id) { TaxEngine.updateTransaction(id, { needsReview: false, reviewReason: null, userReviewed: true }); S.taxResult = null; render(); }
  function markAllReviewed() {
    // Single map + single save — never call updateTransaction in a loop.
    // Calling it N times = N×map(8000 items) + N IDB batch-writes → instant crash.
    // userReviewed:true tells shouldReview() never to re-flag on recalculate,
    // even if the transaction still has a missing price or unknown asset.
    const updated = TaxEngine.getTransactions()
      .map(t => t.needsReview ? { ...t, needsReview: false, reviewReason: null, userReviewed: true } : t);
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    render();
  }
  function deleteDuplicates() {
    const txns = TaxEngine.getTransactions();
    const dups = txns.filter(t => t.isDuplicate);
    if (!dups.length) { showTaxToast('ℹ️', 'No duplicates', 'No duplicate transactions found.', 'info'); return; }
    if (!confirm(`Delete ${dups.length} duplicate transactions? This cannot be undone.`)) return;
    const clean = txns.filter(t => !t.isDuplicate);
    TaxEngine.saveTransactions(clean);
    S.taxResult = null;
    showTaxToast('🗑', 'Duplicates removed', `${dups.length} duplicate transactions deleted.`, 'success');
    render();
  }

  // Mark all transactions in a review group as spam (for unknown tokens, scam airdrops etc)
  function markGroupSpam(reason) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult);
    const affected = issues.filter(i => i.reason === reason);
    if (!affected.length) return;
    if (!confirm(`Mark ${affected.length} transactions as spam/ignored? They will be excluded from tax calculations.`)) return;
    const ids = new Set(affected.map(i => i.txnId));
    const updated = TaxEngine.getTransactions().map(t =>
      ids.has(t.id) ? { ...t, category: 'spam', autoClassified: true, needsReview: false, userReviewed: true } : t
    );
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    showTaxToast('🚫', 'Marked as spam', `${affected.length} transactions excluded from calculations.`, 'success');
    render();
  }
  // ── Bulk review actions ─────────────────────────────────────

  // Mark a single transaction as spam + zero value (non-destructive — keeps the record)
  function markSpam(id) {
    TaxEngine.updateTransaction(id, {
      category: 'spam',
      priceSEKPerUnit: 0, costBasisSEK: 0,
      priceSource: 'missing', priceConfidence: 'spam_zero',
      needsReview: false, reviewReason: 'spam_token', userReviewed: true,
    });
    S.taxResult = null;
    render();
  }

  // Re-run the SEK pricing step for all transactions in a review group.
  // This hits CoinGecko / CoinCap / GeckoTerminal for the affected symbols
  // and saves any prices found, then re-renders the review list.
  async function bulkShowPriceSearch(reason) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult);
    const affected = issues.filter(i => i.reason === reason);
    if (!affected.length) {
      showTaxToast('ℹ️', 'Nothing to price', 'No transactions found for this group.', 'info');
      return;
    }

    const ids = new Set(affected.map(i => i.txnId));
    const txnsToPrice = TaxEngine.getTransactions().filter(t => ids.has(t.id));
    const symbols = [...new Set(txnsToPrice.map(t => t.assetSymbol).filter(Boolean))];

    showTaxToast('⏳', 'Looking up prices…',
      `Fetching SEK prices for ${symbols.length} symbol${symbols.length !== 1 ? 's' : ''}: ${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '…' : ''}`,
      'info');

    try {
      // Run just the price-fetch step on the affected transactions.
      // fetchAllSEKPrices mutates the txn objects in-place, so we pass
      // copies and merge the updated prices back by id.
      const priced = await TaxEngine.fetchAllSEKPrices(txnsToPrice, (pct) => {
        // Could update a progress indicator here — for now just a console log
        if (pct % 20 === 0) console.log(`[BulkPrice] ${pct}%`);
      });

      // Merge updated prices back into the full transaction list
      const pricedMap = new Map((priced || txnsToPrice).map(t => [t.id, t]));
      const allTxns = TaxEngine.getTransactions().map(t =>
        pricedMap.has(t.id) ? pricedMap.get(t.id) : t
      );
      TaxEngine.saveTransactions(allTxns);

      // Count how many actually got a price
      const found = (priced || txnsToPrice).filter(t => (t.priceSEKPerUnit || 0) > 0).length;
      const still = affected.length - found;

      S.taxResult = null;
      showTaxToast(
        found > 0 ? '✅' : '⚠️',
        found > 0 ? `Found ${found} price${found !== 1 ? 's' : ''}` : 'No new prices found',
        still > 0
          ? `${still} transaction${still !== 1 ? 's' : ''} still need manual entry — check CoinMarketCap or CoinGecko for the date of each trade.`
          : 'All prices resolved! Re-run the pipeline to update K4.',
        found > 0 ? 'success' : 'warning'
      );
      render();
    } catch (e) {
      console.error('[BulkPrice]', e);
      showTaxToast('❌', 'Price lookup failed', e.message, 'error');
    }
  }

  // Mark all transactions in a review group as spam (zero value, excluded from K4)
  function bulkMarkSpam(reason) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult);
    const affected = issues.filter(i => i.reason === reason);
    if (!affected.length) return;
    if (!confirm(`Mark ${affected.length} transactions as spam / zero value?\nThey will be excluded from K4 calculations but kept for audit purposes.`)) return;
    const ids = new Set(affected.map(i => i.txnId));
    const updated = TaxEngine.getTransactions().map(t =>
      ids.has(t.id) ? { ...t,
        category: 'spam',
        priceSEKPerUnit: 0, costBasisSEK: 0,
        priceSource: 'missing', priceConfidence: 'spam_zero',
        needsReview: false, reviewReason: 'spam_token', userReviewed: true,
      } : t
    );
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    showTaxToast('🚫', 'Marked as spam', `${affected.length} transactions set to zero value.`, 'success');
    render();
  }

  // Mark all items in a reason group as reviewed (dismiss without editing)
  function bulkMarkReviewed(reason) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult);
    const affected = issues.filter(i => i.reason === reason);
    if (!affected.length) return;
    const ids = new Set(affected.map(i => i.txnId));
    const updated = TaxEngine.getTransactions().map(t =>
      ids.has(t.id) ? { ...t, needsReview: false, reviewReason: null, userReviewed: true } : t
    );
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    showTaxToast('✅', 'Dismissed', `${affected.length} items marked as reviewed.`, 'success');
    render();
  }

  // Set zero cost basis on all disposals in a group (when acquisition history is fully missing)
  function bulkZeroCost(reason) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult);
    const affected = issues.filter(i => i.reason === reason);
    if (!affected.length) return;
    if (!confirm(`Set zero cost basis for ${affected.length} transactions?\nThis means full proceeds will be treated as taxable gain (per Skatteverket rules when acquisition is unknown).`)) return;
    const ids = new Set(affected.map(i => i.txnId));
    const updated = TaxEngine.getTransactions().map(t => {
      if (!ids.has(t.id)) return t;
      return { ...t,
        priceSEKPerUnit: t.priceSEKPerUnit || 0,
        costBasisSEK: 0,
        zeroCostBasis: true,
        needsReview: false, reviewReason: null, userReviewed: true,
      };
    });
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    showTaxToast('0️⃣', 'Zero cost set', `${affected.length} transactions will use full proceeds as gain.`, 'info');
    render();
  }

  // Reclassify all transactions in a reason group to a new category
  function bulkReclassify(reason, newCategory) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult);
    const affected = issues.filter(i => i.reason === reason);
    if (!affected.length) return;
    if (!confirm(`Reclassify ${affected.length} transactions as "${newCategory}"?`)) return;
    const ids = new Set(affected.map(i => i.txnId));
    const updated = TaxEngine.getTransactions().map(t =>
      ids.has(t.id) ? { ...t,
        category: newCategory,
        needsReview: false, reviewReason: null, userReviewed: true,
      } : t
    );
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    showTaxToast('🔄', 'Reclassified', `${affected.length} transactions set to "${newCategory}".`, 'success');
    render();
  }

  // Toggle a review group's collapsed state
  function toggleReviewGroup(reason) {
    if (!S.collapsedGroups) S.collapsedGroups = new Set(['received_not_sold']);
    if (S.collapsedGroups.has(reason)) S.collapsedGroups.delete(reason);
    else S.collapsedGroups.add(reason);
    render();
  }

  // Auto-infer prices for all still-missing transactions by re-applying the full
  // pricing chain on just the unpriced subset, then merging results back.
  async function bulkAutoInfer() {
    const allTxns    = TaxEngine.getTransactions();
    const unpriced   = allTxns.filter(t => !t.priceSEKPerUnit && !t.costBasisSEK && !t.isInternalTransfer);
    if (!unpriced.length) {
      showTaxToast('ℹ️', 'Nothing to infer', 'All transactions already have prices.', 'info'); return;
    }
    showTaxToast('⏳', 'Running inference…',
      `Applying swap-leg + propagation + back-derive on ${unpriced.length} unpriced transactions…`, 'info');
    try {
      // fetchAllSEKPrices re-runs the full pricing chain (all passes)
      const repriced = await TaxEngine.fetchAllSEKPrices(allTxns, () => {});
      TaxEngine.saveTransactions(repriced);
      const resolved = repriced.filter(t => {
        const was = allTxns.find(x => x.id === t.id);
        return was && !was.priceSEKPerUnit && t.priceSEKPerUnit > 0;
      }).length;
      S.taxResult = null;
      showTaxToast(
        resolved > 0 ? '✅' : '⚠️',
        resolved > 0 ? `Resolved ${resolved} transaction${resolved !== 1 ? 's' : ''}` : 'No new prices found',
        resolved > 0
          ? `${resolved} previously unpriced transaction${resolved !== 1 ? 's' : ''} now have inferred SEK prices.`
          : 'Could not derive prices — enter them manually or mark as spam.',
        resolved > 0 ? 'success' : 'warning'
      );
      render();
    } catch (e) {
      console.error('[AutoInfer]', e);
      showTaxToast('❌', 'Inference failed', e.message, 'error');
    }
  }

  function removeAccount(id) {
    const acc = TaxEngine.getAccounts().find(a => a.id === id);
    const txCount = TaxEngine.getTransactions().filter(t => t.accountId === id).length;
    const label = acc?.label || (acc?.address ? acc.address.slice(0, 10) + '…' : 'this account');
    const msg = txCount > 0
      ? `Remove "${label}"?\n\nThis will permanently delete ${txCount.toLocaleString()} transaction${txCount !== 1 ? 's' : ''} associated with this account.\n\nThis cannot be undone.`
      : `Remove "${label}"? This cannot be undone.`;
    if (!confirm(msg)) return;
    TaxEngine.removeAccount(id);
    S.taxResult = null;
    S.portfolioSnap = null;
    S.portfolioHist = null;
    if (S.portfolioRefreshTimer) { clearInterval(S.portfolioRefreshTimer); S.portfolioRefreshTimer = null; }
    render();
    showTaxToast('🗑', 'Account removed', txCount > 0 ? `${txCount.toLocaleString()} transactions deleted.` : '', 'success');
  }

  function clearAllData() {
    const txCount = TaxEngine.getTransactions().length;
    const accCount = TaxEngine.getAccounts().length;
    if (accCount === 0 && txCount === 0) {
      showTaxToast('ℹ️', 'Nothing to clear', 'No accounts or transactions found.'); return;
    }
    if (!confirm(`⚠️ Clear ALL data?\n\nThis will permanently delete:\n• ${accCount} account${accCount !== 1 ? 's' : ''}\n• ${txCount.toLocaleString()} transaction${txCount !== 1 ? 's' : ''}\n\nYour portfolio and tax reports will be wiped.\nThis cannot be undone.`)) return;
    TaxEngine.clearAllData();
    S.taxResult = null;
    S.portfolioSnap = null;
    S.portfolioHist = null;
    if (S.portfolioRefreshTimer) { clearInterval(S.portfolioRefreshTimer); S.portfolioRefreshTimer = null; }
    render();
    showTaxToast('🗑', 'All data cleared', `${accCount} account${accCount !== 1 ? 's' : ''} and ${txCount.toLocaleString()} transactions deleted.`, 'success');
  }

  // ── CSV import ────────────────────────────────────────────
  function onCSVSelected(ev, parser) {
    const file = ev.target.files[0];
    if (!file) return;
    _pendingCSVParser = parser;
    const reader = new FileReader();
    reader.onload = e => {
      _pendingCSVText = e.target.result;
      const sub = document.getElementById('tax-dz-sub');
      if (sub) sub.textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      const btn = document.getElementById('tax-csv-import-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Import Transactions'; }
      const lines = _pendingCSVText.trim().split('\n').length - 1;
      const st = document.getElementById('tax-import-status');
      if (st) st.innerHTML = `<div class="tax-import-preview">✅ Found ~${lines} rows</div>`;
    };
    reader.readAsText(file);
  }

  function importCSV(parser) {
    if (!_pendingCSVText) return;
    const st = document.getElementById('tax-import-status');
    if (st) st.innerHTML = '<div class="tax-import-status-loading">⏳ Importing…</div>';

    const label = document.getElementById('tax-csv-label')?.value || '';
    const acc = TaxEngine.addAccount({ type: parser === 'generic' ? 'csv' : parser, label });

    let txns = [];
    try {
      const P = TaxEngine;
      if (parser === 'binance') txns = P.parseBinanceCSV(_pendingCSVText, acc.id);
      else if (parser === 'kraken') txns = P.parseKrakenCSV(_pendingCSVText, acc.id);
      else if (parser === 'bybit') txns = P.parseBybitCSV(_pendingCSVText, acc.id);
      else if (parser === 'coinbase') txns = P.parseCoinbaseCSV(_pendingCSVText, acc.id);
      else if (parser === 'revolut') txns = P.parseRevolutCSV(_pendingCSVText, acc.id);
      else if (parser === 'mexc') txns = P.parseMEXCCSV(_pendingCSVText, acc.id);
      else txns = P.parseGenericCSV(_pendingCSVText, acc.id);
    } catch (e) {
      if (st) st.innerHTML = `<div class="tax-import-error">❌ Parse error: ${e.message}</div>`;
      return;
    }

    const added = TaxEngine.addTransactions(txns);
    TaxEngine.setImportStatus(acc.id, {
      status: 'synced',
      totalFetched: txns.length,
      totalTxns: added,
      source: parser,
    });
    _pendingCSVText = null;
    S.importModal = null;
    S.taxResult = null;
    S.page = 'transactions';
    render();
    showTaxToast('✅', `Imported ${added} transactions`, `${txns.length - added} duplicates skipped`);
    // Auto-run pipeline
    setTimeout(triggerPipeline, 500);
  }

  async function importWallet(chain, chainId) {
    const addr = document.getElementById('tax-wallet-addr')?.value?.trim();
    const label = document.getElementById('tax-wallet-label')?.value?.trim() || '';
    if (!addr) { showTaxToast('⚠️', 'Enter wallet address'); return; }

    // Determine account type from current modal source + selected network
    const src = ACC_SOURCES.find(s => s.type === S.importModal);
    const net = src?.networks?.find(n => n.id === S.importNetwork) || src?.networks?.[0];
    const accType = chain === 'sol' ? (S.importModal || 'phantom')
      : chain === 'sui' ? 'sui'
      : (S.importModal === 'phantom' ? 'phantom_eth' : (S.importModal || 'metamask'));

    const st = document.getElementById('tax-import-status');
    if (st) st.innerHTML = '<div class="tax-import-status-loading">⏳ Fetching full transaction history…</div>';

    const btn = document.querySelector('.tax-modal-footer .tax-btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

    const acc = TaxEngine.addAccount({
      type: accType,
      label: label || (net ? `${src?.name} (${net.label})` : src?.name) || accType,
      address: addr,
      network: net?.id || chain,
    });
    let res;
    try {
      const onProgress = p => {
        if (st) st.innerHTML = `<div class="tax-import-status-loading">⏳ ${p.msg}</div>`;
      };
      if (chain === 'sui') {
        // Sui: placeholder — will be implemented when Sui indexer is added
        throw new Error('Sui import is not yet implemented. Coming soon!');
      }
      const chainIdForImport = net?.chainId || (chain === 'sol' ? undefined : 1);
      res = chain === 'sol'
        ? await TaxEngine.importSolanaWallet(addr, acc.id, onProgress)
        : await TaxEngine.importEthWallet(addr, acc.id, onProgress, chainIdForImport);
    } catch (e) {
      if (st) st.innerHTML = `<div class="tax-import-error">❌ ${e.message}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = 'Import Full History'; }
      return;
    }

    if (res.error && !res.txns?.length) {
      if (st) st.innerHTML = `<div class="tax-import-error">❌ ${res.error}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = 'Import Full History'; }
      return;
    }

    // Apply since-date filter if user requested partial import
    let importedTxns = res.txns || [];
    if (S.walletImportFrom === 'date' && S.walletImportDate) {
      const cutoffMs = new Date(S.walletImportDate).getTime();
      importedTxns = importedTxns.filter(t => {
        const d = t.date || t.timestamp || '';
        return d ? new Date(d).getTime() >= cutoffMs : true;
      });
    }

    const added = TaxEngine.addTransactions(importedTxns);
    // Update lastSyncAt
    TaxEngine.updateAccount?.(acc.id, { lastSyncAt: new Date().toISOString() });
    S.importModal = null; S.importNetwork = null;
    S.walletImportFrom = 'beginning'; S.walletImportDate = '';
    S.taxResult = null; S.page = 'transactions';
    render();
    showTaxToast('✅', `Imported ${added} transactions`, `Total fetched: ${res.totalFetched || 0}`);
    setTimeout(triggerPipeline, 500);
  }

  // ── Download / Print ──────────────────────────────────────
  function downloadK4CSV() {
    const result = getOrComputeTaxResult();
    const userInfo = {};
    try { if (typeof AuthManager !== 'undefined') { const u = AuthManager.getUser(); if (u) userInfo.name = u.name; } } catch { }
    const csv = TaxEngine.generateK4CSV(result, userInfo);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `SKV2104_K4_D_krypto_${S.taxYear}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }
  function downloadAuditCSV() {
    const result = getOrComputeTaxResult();
    const csv = TaxEngine.generateAuditCSV(result);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `TCMD_transaktionslogg_${S.taxYear}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }
  function printReport() { window.print(); }

  async function downloadK4PDF() {
    const settings = TaxEngine.getSettings();
    const name = settings.userName || S.userName || '';
    const pnr  = settings.personnummer || S.userPnr || '';

    if (!name || !pnr) {
      showTaxToast('⚠️', 'Profil saknas', 'Fyll i Namn och Personnummer under ⚙️ Inställningar för att generera K4 PDF.', 'warning');
      return;
    }

    if (typeof K4PdfFiller === 'undefined') {
      showTaxToast('❌', 'PDF-biblioteket saknas', 'Ladda om sidan och försök igen.', 'error');
      return;
    }

    const result = getOrComputeTaxResult();
    try {
      showTaxToast('⏳', 'Genererar K4 PDF…', '', 'info');
      const k4  = TaxEngine.generateK4Report(result);
      const buf = await K4PdfFiller.generate(k4, { name, pnr, year: S.taxYear });
      const blob = new Blob([buf], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const pnrSafe = pnr.replace(/[^0-9]/g, '');
      a.download = `K4_${S.taxYear}_${pnrSafe}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
      showTaxToast('✅', 'K4 PDF nedladdad', `K4_${S.taxYear}_${pnrSafe}.pdf`, 'success');
    } catch (e) {
      console.error('[K4PDF]', e);
      showTaxToast('❌', 'Kunde inte generera K4 PDF', e.message, 'error');
    }
  }

  async function downloadAccountantReport() {
    const settings = TaxEngine.getSettings();
    const name = settings.userName || S.userName || '';
    const pnr  = settings.personnummer || S.userPnr || '';

    if (!name || !pnr) {
      showTaxToast('⚠️', 'Profil saknas', 'Fyll i Namn och Personnummer under ⚙️ Inställningar för att generera revisionsrapport.', 'warning');
      return;
    }

    if (typeof K4PdfFiller === 'undefined' || typeof K4PdfFiller.generateAccountantReport !== 'function') {
      showTaxToast('❌', 'PDF-biblioteket saknas', 'Ladda om sidan och försök igen.', 'error');
      return;
    }

    const result = getOrComputeTaxResult();
    const allTxns = TaxEngine.getTransactions ? TaxEngine.getTransactions() : [];
    try {
      showTaxToast('⏳', 'Genererar revisionsrapport…', '', 'info');
      const buf = await K4PdfFiller.generateAccountantReport(
        result,
        { name, pnr, year: S.taxYear },
        allTxns
      );
      const blob = new Blob([buf], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const pnrSafe = pnr.replace(/[^0-9]/g, '');
      a.download = `K4_revisionsrapport_${S.taxYear}_${pnrSafe}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
      showTaxToast('✅', 'Revisionsrapport nedladdad', `K4_revisionsrapport_${S.taxYear}_${pnrSafe}.pdf`, 'success');
    } catch (e) {
      console.error('[AccountantReport]', e);
      showTaxToast('❌', 'Kunde inte generera revisionsrapport', e.message, 'error');
    }
  }

  function downloadHoldingsCSV() {
    const result = getOrComputeTaxResult();
    const { currentHoldings = [] } = result;
    const lines = ['Tillgång,Antal,Genomsnittligt anskaffningsvärde (SEK),Totalt anskaffningsvärde (SEK)'];
    for (const h of [...currentHoldings].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      if ((h.quantity || 0) <= 0) continue;
      const avgCost = h.quantity > 0 ? (h.totalCostSEK / h.quantity) : 0;
      lines.push(`${h.symbol},${h.quantity.toFixed(8)},${avgCost.toFixed(2)},${h.totalCostSEK.toFixed(2)}`);
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `TCMD_innehav_${S.taxYear}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  function setUserInfo(field, val) {
    if (field === 'name') S.userName = val;
    if (field === 'pnr') S.userPnr = val;
    // Persist to Supabase
    if (typeof SupabaseDB !== 'undefined' && SupabaseDB.setUserData) {
      SupabaseDB.setUserData('tax_user_info', { name: S.userName || '', personnummer: S.userPnr || '' });
    }
  }

  async function manualCloudSync() {
    if (typeof SUPABASE_READY === 'undefined' || !SUPABASE_READY) {
      showTaxToast('ℹ️', 'Cloud sync unavailable', 'Supabase is not configured.', 'info');
      return;
    }
    const txns = TaxEngine.getTransactions();
    showTaxToast('⏳', 'Syncing to cloud…', `${txns.length.toLocaleString()} transactions`, 'info');
    try {
      await TaxEngine.syncToCloud(txns);
      S._cloudSyncedAt = new Date().toISOString();
      showTaxToast('✅', 'Cloud sync complete', `${txns.length.toLocaleString()} transactions backed up — available in all browsers.`, 'success');
      render();
    } catch (e) {
      showTaxToast('❌', 'Cloud sync failed', e.message, 'error');
    }
  }

  async function resyncAccount(accountId) {
    if (!confirm('This will delete all imported transactions for this account and re-import. Continue?')) return;
    TaxEngine.resyncAccount(accountId);
    const acc = TaxEngine.getAccounts().find(a => a.id === accountId);
    if (acc) {
      showTaxToast('🔄', 'Re-syncing', `Re-importing ${acc.name}…`, 'info');
      if (acc.type === 'solana' || acc.type === 'phantom_sol') {
        await importWallet('SOL');
      } else if (acc.type === 'metamask' || acc.type === 'phantom_eth' || acc.type === 'eth') {
        await importWallet('ETH');
      } else {
        showTaxToast('ℹ️', 'Manual re-import needed', 'Please upload the CSV file again.', 'info');
        render();
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────
  function getOrComputeTaxResult() {
    if (!S.taxResult || S.taxResult.year !== S.taxYear) {
      S.taxResult = TaxEngine.computeTaxYear(S.taxYear);
    }
    return S.taxResult;
  }

  function filterTxns(txns) {
    const f = S.txFilter;
    return txns.filter(t => {
      if (f.search) {
        const q = f.search.toLowerCase();
        if (!t.assetSymbol?.toLowerCase().includes(q) && !t.txHash?.toLowerCase().includes(q) && !t.notes?.toLowerCase().includes(q)) return false;
      }
      if (f.category !== 'all' && t.category !== f.category) return false;
      if (f.account !== 'all' && t.accountId !== f.account) return false;
      if (f.dateFrom && t.date < f.dateFrom) return false;
      if (f.dateTo && t.date > f.dateTo + 'T23:59:59') return false;
      if (f.needsReview && !t.needsReview) return false;
      return true;
    });
  }

  function sortTxnsArr(txns) {
    const { field, dir } = S.txSort;
    return [...txns].sort((a, b) => {
      let av = a[field], bv = b[field];
      if (field === 'amount' || field === 'feeSEK') { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }
  // aliased for event handlers
  function sortIcon(f) {
    if (S.txSort.field !== f) return '<span class="sort-icon">⇅</span>';
    return S.txSort.dir === 'asc' ? '<span class="sort-icon active">↑</span>' : '<span class="sort-icon active">↓</span>';
  }

  function fmtDate(iso) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('sv-SE'); }
  function fmtDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('sv-SE') + ' ' + d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  }

  function renderEmpty(title, sub, icon) {
    return `<div class="tax-empty"><div class="tax-empty-icon">${icon}</div><div class="tax-empty-title">${title}</div><div class="tax-empty-sub">${sub}</div></div>`;
  }

  function reRenderMain() {
    const panel = document.getElementById('tax-panel');
    if (!panel) return;
    const mainEl = panel.querySelector('.tax-main');
    if (mainEl) { mainEl.innerHTML = renderPage(); bindEvents(); }
  }

  function showTaxToast(icon, title, msg = '', type = 'success') {
    if (typeof showToast === 'function') showToast(icon, title, msg, type);
  }

  // ── Event binding ─────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll('.tax-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.page !== 'portfolio') destroyPortfolioCharts();
        S.page = btn.dataset.page;
        history.replaceState(null, '', '#tax/' + btn.dataset.page);
        render();
      });
    });
    const yp = document.getElementById('tax-year-picker');
    if (yp) yp.addEventListener('change', () => {
      S.taxYear = parseInt(yp.value); S.taxResult = null;
      TaxEngine.saveSettings({ ...TaxEngine.getSettings(), taxYear: S.taxYear });
      render();
    });
    // Drag-drop on CSV dropzone
    const dz = document.getElementById('tax-dropzone');
    if (dz) {
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) {
          const fakeEv = { target: { files: [file] } };
          onCSVSelected(fakeEv, S.importModal);
        }
      });
    }
  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    // Load per-user tax data from Supabase into in-memory caches
    await Promise.all([
      TaxEngine.loadTransactions(),
      TaxEngine.loadAccounts(),
      TaxEngine.loadSettings(),
      TaxEngine.loadImportStatuses(),
    ]);
    S.taxYear = TaxEngine.getSettings().taxYear;
    S.taxResult = null;
    bindPipelineEvents();

    // Load user info (name/personnummer) for K4 header
    try {
      if (typeof SupabaseDB !== 'undefined' && SupabaseDB.getUserData) {
        const info = await SupabaseDB.getUserData('tax_user_info');
        if (info) {
          S.userName = info.name || '';
          S.userPnr = info.personnummer || '';
        }
      }
    } catch { }

    // Restore tax sub-page from URL hash (e.g. #tax/reports → reports page)
    const VALID_PAGES = ['portfolio', 'accounts', 'transactions', 'reports', 'review'];
    const hashParts = window.location.hash.replace('#', '').split('/');
    if (hashParts[0] === 'tax' && VALID_PAGES.includes(hashParts[1])) {
      S.page = hashParts[1];
    }

    render();
  }

  function navigate(page) {
    if (page !== 'portfolio') {
      destroyPortfolioCharts();
      if (S.portfolioRefreshTimer) { clearInterval(S.portfolioRefreshTimer); S.portfolioRefreshTimer = null; }
    }
    S.page = page;
    history.replaceState(null, '', '#tax/' + page);
    render();
  }

  // ── Public ────────────────────────────────────────────────
  return {
    init, render, navigate, triggerPipeline,
    openAddAccountModal, closeAddAccountModal, accSearch, accFilter,
    openImport, selectNetwork, closeImport,
    setWalletTab, setImportFrom, setWalletImportDate, createEmptyWallet,
    importWallet, importCSV, onCSVSelected,
    setFilter, sortTxns, setPage,
    openCal, closeCal, calNav, selectDate,
    editTx, closeEdit, saveEdit, deleteTx,
    toggleSelectAll, toggleSelectTx, deleteSelected, deleteAllFiltered, clearSelection,
    markReviewed, markAllReviewed, markSpam,
    markGroupSpam, bulkMarkSpam, bulkMarkReviewed, bulkZeroCost, bulkReclassify, bulkShowPriceSearch,
    bulkAutoInfer, toggleReviewGroup,
    deleteDuplicates, removeAccount, clearAllData,
    downloadK4CSV, downloadK4PDF, downloadAccountantReport, downloadAuditCSV, downloadHoldingsCSV, printReport,
    setUserInfo, resyncAccount, manualCloudSync,
    // Transactions page — expanded row & manual entry
    expandTxRow, setExpandedTab,
    toggleAddTxMenu, toggleTxTypeMenu, toggleTxWalletMenu, toggleTxLabelMenu,
    addManualRow, removeManualRow, duplicateManualRow, updateManualRow, cancelManualRows, submitManualRows,
    // Bulk merge
    mergeSameHash, mergeTrade, mergeTransfer, mergeMultipleTransfers,
    // Portfolio dashboard
    portSetRange, filterAssets, toggleSmallBalances,
    // expose for inline onclick patterns
    filterTxns, sortTxnsArr: txns => sortTxnsArr(txns),
  };

})();

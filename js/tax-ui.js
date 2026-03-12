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
    userName: '',
    userPnr: '',
  };

  let _pendingCSVText = null;
  let _pendingCSVParser = null;

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
        <div class="tax-page-header">
          <h1 class="tax-page-title">Portfolio</h1>
          <span class="tax-page-subtitle">Inkomstår ${S.taxYear}</span>
          <div class="tax-page-actions">
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">⚙️ Recalculate</button>
          </div>
        </div>

        ${issues > 0 ? `
        <div class="tax-review-banner" onclick="TaxUI.navigate('review')">
          <span>⚠️</span>
          <span><strong>${issues} transactions</strong> need review — tax result may be incomplete</span>
          <span class="tax-rb-link">Fix now →</span>
        </div>` : ''}

        <!-- ── TOP ROW: chart + summary panel ─────────────── -->
        <div class="tax-port-top">
          <!-- Left: value headline + chart canvas + time range -->
          <div class="tax-port-chart-card">
            <div class="tax-port-value-header">
              <div>
                <div class="tax-port-val-label">Total value</div>
                <div class="tax-port-val-number" id="tax-port-total-val">
                  ${totalVal !== null ? TaxEngine.formatSEK(totalVal) : '<span class="tax-port-loading-val">Loading…</span>'}
                </div>
              </div>
            </div>
            <div class="tax-port-chart-wrap">
              <canvas id="tax-port-chart" height="180"></canvas>
              <div class="tax-port-chart-overlay" id="tax-port-overlay" style="display:none">Loading chart…</div>
            </div>
            <div class="tax-port-time-row">
              ${['1D', '1W', '1M', '1Y', 'YTD', 'All'].map(r => `
                <button class="tax-port-tb ${S.portfolioRange === r ? 'active' : ''}"
                  onclick="TaxUI.portSetRange('${r}')">${r}</button>`).join('')}
              <span style="flex:1"></span>
              <span class="tax-port-legend-dot" style="background:#6366f1"></span>
              <span class="tax-port-legend-lbl">Total value</span>
              <span class="tax-port-legend-dot" style="background:rgba(148,163,184,0.4)"></span>
              <span class="tax-port-legend-lbl">Net cost basis</span>
            </div>
          </div>

          <!-- Right: summary panel -->
          <div class="tax-port-summary-panel">
            <div class="tax-port-sum-title">Performance <span class="tax-port-auto-tag">🔄 Auto</span></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">24h P&amp;L</span>
              <span class="tax-port-sum-val" id="tax-ps-24h"><span class="tax-port-loading-val">—</span></span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Total return</span>
              <span class="tax-port-sum-val" id="tax-ps-return">${fmtVal(totalReturn)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Unrealized gains</span>
              <span class="tax-port-sum-val ${unrealized !== null ? (unrealized >= 0 ? 'tax-port-pos' : 'tax-port-neg') : ''}" id="tax-ps-unrealized">${fmtVal(unrealized)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Fiat invested</span>
              <span class="tax-port-sum-val" id="tax-ps-fiatin">${fmtVal(fiatIn)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Fiat proceeds</span>
              <span class="tax-port-sum-val" id="tax-ps-fiatout">${fmtVal(fiatOut)}</span>
            </div>
            <div class="tax-port-sum-div"></div>
            <div class="tax-port-sum-row">
              <span class="tax-port-sum-lbl">Fees paid</span>
              <span class="tax-port-sum-val" id="tax-ps-fees">${fmtVal(fees)}</span>
            </div>
          </div>
        </div>

        <!-- ── STAT CARDS ──────────────────────────────────── -->
        <div class="tax-stat-grid">
          <div class="tax-stat-card">
            <div class="tax-stat-label">Holdings</div>
            <div class="tax-stat-value">${currentHoldings.length} assets</div>
          </div>
          <div class="tax-stat-card ${summary.netGainLoss >= 0 ? 'gain' : 'loss'}">
            <div class="tax-stat-label">Net Gain/Loss ${S.taxYear}</div>
            <div class="tax-stat-value">${TaxEngine.formatSEK(summary.netGainLoss)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Estimated tax (30%)</div>
            <div class="tax-stat-value tax-red">${TaxEngine.formatSEK(summary.estimatedTax)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Transactions ${S.taxYear}</div>
            <div class="tax-stat-value">${summary.totalTransactions.toLocaleString()}</div>
          </div>
        </div>

        <!-- ── CHARTS ROW: donut + winners/losers ─────────── -->
        <div class="tax-port-mid">
          <div class="tax-chart-card">
            <div class="tax-chart-card-title">Asset allocation</div>
            <div class="tax-alloc-inner">
              <div class="tax-alloc-donut-wrap">
                <canvas id="tax-alloc-chart"></canvas>
                <div class="tax-alloc-center" id="tax-alloc-center">
                  <div class="tax-alloc-center-lbl">All assets</div>
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
                  <span class="tax-alloc-sym">Other</span>
                  <span class="tax-alloc-pct">&lt;1%</span>
                  <span class="tax-alloc-val">${TaxEngine.formatSEK(sortedHoldings.slice(8).reduce((s, h) => s + (h.currentValueSEK ?? h.totalCostSEK), 0))}</span>
                </div>` : ''}
              </div>
            </div>
          </div>
          <div class="tax-chart-card">
            <div class="tax-chart-card-title" id="tax-perf-title">Winners and losers</div>
            <div class="tax-perf-wrap">
              <canvas id="tax-perf-chart"></canvas>
              <p id="tax-perf-loading" class="tax-port-loading-val"
                 style="padding:12px 0;font-size:12px;${snap ? 'display:none' : ''}">Loading prices…</p>
            </div>
            <div id="tax-perf-note" class="tax-port-accuracy-note"
                 style="${snap && !tableHoldings.some(h => h.unrealizedPct === null) ? 'display:none' : ''}">
              ⓘ Improve accuracy by categorizing transactions
            </div>
          </div>
        </div>

        <!-- ── ASSETS TABLE ────────────────────────────────── -->
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>Assets</h2>
            <input class="tax-search-input" id="tax-asset-search" placeholder="Find asset"
              oninput="TaxUI.filterAssets(this.value)">
          </div>
          ${sortedHoldings.length === 0
        ? renderEmpty('No holdings found', 'Import transactions to see your portfolio.', '💼')
        : `<div class="tax-table-wrap"><table class="tax-table">
                <thead><tr>
                  <th>Asset</th>
                  <th class="ta-r">Price</th>
                  <th class="ta-r">Cost</th>
                  <th class="ta-r">Holdings</th>
                  <th class="ta-r">Profit / Loss</th>
                  <th class="ta-r">24h Change</th>
                </tr></thead>
                <tbody id="tax-assets-tbody">
                  ${sortedHoldings.map(renderAssetRow).join('')}
                </tbody>
              </table></div>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" style="margin-top:10px"
                onclick="TaxUI.toggleSmallBalances()">Show tokens with small balances ▾</button>`
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
    { type: 'polygon_bc',  icon: '🟣',  name: 'Polygon',        category: 'blockchains',tag: '',        desc: 'Polygon (MATIC) address',   color: '#8247E5', networks: [{ id: 'polygon', label: 'Polygon', icon: '🟣', chain: 'eth', chainId: 137 }] },
    { type: 'base_bc',     icon: '🔵',  name: 'Base',           category: 'blockchains',tag: '',        desc: 'Coinbase L2 address',       color: '#0052FF', networks: [{ id: 'base', label: 'Base', icon: '🔵', chain: 'eth', chainId: 8453 }] },
    // ── Exchanges ─────────────────────────────────────────────
    { type: 'binance',     icon: '🟡',  name: 'Binance',        category: 'exchanges',  tag: 'popular', desc: 'Upload trade history CSV',  color: '#f0b90b', networks: [] },
    { type: 'coinbase',    icon: '🔵',  name: 'Coinbase',       category: 'exchanges',  tag: 'popular', desc: 'Upload transaction CSV',    color: '#0052ff', networks: [] },
    { type: 'kraken',      icon: '🐙',  name: 'Kraken',         category: 'exchanges',  tag: 'popular', desc: 'Upload ledger CSV',         color: '#5741d9', networks: [] },
    { type: 'bybit',       icon: '🔸',  name: 'Bybit',          category: 'exchanges',  tag: 'popular', desc: 'Upload order history CSV',  color: '#f7a600', networks: [] },
    { type: 'kucoin',      icon: '🟢',  name: 'KuCoin',         category: 'exchanges',  tag: '',        desc: 'Upload trade history CSV',  color: '#26de81', networks: [] },
    { type: 'cryptocom',   icon: '🔷',  name: 'Crypto.com',     category: 'exchanges',  tag: '',        desc: 'Upload transaction CSV',    color: '#002d74', networks: [] },
    // ── Services ──────────────────────────────────────────────
    { type: 'csv',         icon: '📄',  name: 'CSV / Generic',  category: 'services',   tag: '',        desc: 'Any exchange or wallet CSV', color: '#64748b', networks: [] },
  ];

  // State for the add-account search modal
  let _accSearch = '';
  let _accFilter = 'all'; // all | exchanges | blockchains | wallets | services

  function renderAccounts() {
    const accounts = TaxEngine.getAccounts();
    const txns = TaxEngine.getTransactions();

    return `
      <div class="tax-page tax-page--accounts">
        <div class="tax-page-header">
          <h1 class="tax-page-title">ACCOUNTS</h1>
          <button class="acc-add-btn" onclick="TaxUI.openAddAccountModal()">
            <span>＋</span> Add account
          </button>
        </div>

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
    csv: {
      icon: '📄', name: 'CSV File', steps: [
        'Expected columns: date, type, asset, amount, price_sek (or price), fee',
        'Common column names are auto-detected.',
      ], warning: null
    },
  };

  function renderWalletModal(type, chain, net) {
    const src = ACC_SOURCES.find(s => s.type === type) || {};
    const netLabel = net ? net.label : (chain === 'sol' ? 'Solana' : 'Ethereum');
    const netIcon  = net ? net.icon  : (chain === 'sol' ? '◎' : 'Ξ');
    const addrPlaceholder = chain === 'sol' ? 'Solana public key (base58)' :
      chain === 'sui' ? 'Sui address (0x…)' : '0x… Ethereum address';

    const isSui = chain === 'sui';
    const chainId = net?.chainId || null;

    return `<div class="tax-modal-overlay" onclick="if(event.target===this)TaxUI.closeImport()">
      <div class="tax-modal">
        <div class="tax-modal-header">
          <div style="display:flex;align-items:center;gap:8px">
            ${src.networks?.length > 1 ? `<button class="tax-modal-back" onclick="TaxUI.selectNetwork(null)" title="Back">←</button>` : ''}
            <span>${src.icon} ${src.name} <span class="acc-net-badge">${netIcon} ${netLabel}</span></span>
          </div>
          <button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button>
        </div>
        <div class="tax-modal-body">
          <div class="tax-info-box" style="margin-bottom:14px">
            <span>🔒</span>
            <span>Read-only — private keys are <strong>never</strong> accessed. Only the public address is used.</span>
          </div>
          <div class="tax-form-group">
            <label>Public Wallet Address</label>
            <input type="text" id="tax-wallet-addr" class="tax-input" placeholder="${addrPlaceholder}">
          </div>
          <div class="tax-form-group">
            <label>Label <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
            <input type="text" id="tax-wallet-label" class="tax-input" placeholder="e.g. My ${netLabel} wallet">
          </div>
          ${chain === 'sol' && !localStorage.getItem('tcmd_helius_key') ? `
          <div class="tax-warn-box">⚠️ No Helius API key. Add it in Admin → API Keys to enable Solana import.</div>` : ''}
          ${chain === 'eth' && !localStorage.getItem('tcmd_etherscan_key') && !window.TCMD_KEYS?.etherscan ? `
          <div class="tax-warn-box" style="flex-direction:column;gap:4px">
            <div><strong>⚠️ Etherscan API key required for EVM wallet import.</strong></div>
            <div style="color:#fde68a;font-weight:400">${typeof AuthManager !== 'undefined' && AuthManager.isAdmin()
              ? `Go to <strong>Admin → API Keys → 🦊 Etherscan</strong> to add your key.`
              : 'Contact your administrator to configure the Etherscan API key.'
            }</div>
          </div>` : ''}
          ${isSui ? `<div class="tax-warn-box">⚠️ Sui import coming soon — history will be fetched via Sui indexer.</div>` : ''}
          <div id="tax-import-status"></div>
        </div>
        <div class="tax-modal-footer">
          <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeImport()">Cancel</button>
          <button class="tax-btn tax-btn-primary" onclick="TaxUI.importWallet('${chain}',${chainId ? `'${chainId}'` : 'null'})"
            ${isSui ? 'disabled title="Sui import coming soon"' : ''}>
            Import Full History
          </button>
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
    buy: { icon: '↓', color: '#22c55e', label: 'Buy' },
    sell: { icon: '↑', color: '#ef4444', label: 'Sell' },
    trade: { icon: '↔', color: '#8b5cf6', label: 'Swap' },
    receive: { icon: '⬇', color: '#06b6d4', label: 'Receive' },
    send: { icon: '⬆', color: '#f59e0b', label: 'Send' },
    income: { icon: '★', color: '#f59e0b', label: 'Income' },
    fee: { icon: '💸', color: '#94a3b8', label: 'Fee' },
    transfer_in: { icon: '←', color: '#64748b', label: 'Transfer In' },
    transfer_out: { icon: '→', color: '#64748b', label: 'Transfer Out' },
    spam: { icon: '🚫', color: '#475569', label: 'Spam' },
    approval: { icon: '✓', color: '#475569', label: 'Approval' },
    staking: { icon: '🥩', color: '#22d3ee', label: 'Staking' },
    nft_sale: { icon: '🖼️', color: '#a78bfa', label: 'NFT Sale' },
    bridge: { icon: '🌉', color: '#818cf8', label: 'Bridge' },
    defi_unknown: { icon: '🧩', color: '#f59e0b', label: 'DeFi' },
  };

  function renderTransactions() {
    const allTxns = TaxEngine.getTransactions();
    const accounts = TaxEngine.getAccounts();
    const filtered = filterTxns(allTxns);
    const sorted = sortTxnsArr(filtered);
    const paged = sorted.slice(S.txPage * S.txPageSize, (S.txPage + 1) * S.txPageSize);
    const selCount = S.selectedTxIds.size;

    return `
      <div class="tax-page" style="display:flex;flex-direction:column;height:100%;overflow:hidden">
        <div class="tax-page-header" style="flex-shrink:0">
          <h1 class="tax-page-title">Transactions</h1>
          <div class="tax-page-actions" style="display:flex;gap:8px;align-items:center">
            ${selCount > 0 ? `
              <span style="font-size:12px;color:var(--tax-muted)">${selCount} selected</span>
              <button class="tax-btn tax-btn-sm" style="background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)" onclick="TaxUI.deleteSelected()">🗑 Delete selected</button>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.clearSelection()">Clear</button>
            ` : ''}
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.openImport('csv')">+ Add CSV</button>
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">⚙️ Process</button>
          </div>
        </div>

        <div class="tax-filter-bar" style="flex-shrink:0">
          <div class="tax-search-wrap">
            <span class="tax-search-icon">🔍</span>
            <input type="text" class="tax-input tax-search-input" placeholder="Search asset, hash, notes…"
              value="${S.txFilter.search}" oninput="TaxUI.setFilter('search',this.value)">
          </div>
          <select class="tax-select tax-filter-select" onchange="TaxUI.setFilter('category',this.value)">
            <option value="all">All types</option>
            ${Object.entries(CAT_META).map(([k, v]) => `<option value="${k}" ${S.txFilter.category === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
          <select class="tax-select tax-filter-select" onchange="TaxUI.setFilter('account',this.value)">
            <option value="all">All accounts</option>
            ${accounts.map(a => `<option value="${a.id}" ${S.txFilter.account === a.id ? 'selected' : ''}>${a.label || a.type}</option>`).join('')}
          </select>
          <div class="tax-date-range">
            <input type="text" class="tax-input tax-date-input" placeholder="From" value="${S.txFilter.dateFrom}" readonly onclick="TaxUI.openCal('from')">
            <span style="color:var(--text-muted)">→</span>
            <input type="text" class="tax-input tax-date-input" placeholder="To" value="${S.txFilter.dateTo}" readonly onclick="TaxUI.openCal('to')">
          </div>
          <label class="tax-check-label">
            <input type="checkbox" ${S.txFilter.needsReview ? 'checked' : ''} onchange="TaxUI.setFilter('needsReview',this.checked)">
            Review only
          </label>
        </div>

        ${S.calOpen ? renderCalendar() : ''}

        <div class="tax-table-meta" style="flex-shrink:0">
          <span class="tax-muted">${filtered.length.toLocaleString()} transactions</span>
          ${filtered.length < allTxns.length ? `<span class="tax-filter-chip">${allTxns.length.toLocaleString()} total</span>` : ''}
          <span style="flex:1"></span>
          ${renderPagination(filtered.length)}
        </div>

        ${paged.length === 0
        ? renderEmpty('No transactions', allTxns.length === 0 ? 'Add accounts from the Accounts page.' : 'No matches.', '📋')
        : `<div class="tax-table-wrap" style="flex:1;overflow-y:auto;min-height:0">
              <table class="tax-table" style="width:100%">
              <thead style="position:sticky;top:0;z-index:2;background:var(--tax-bg,#0d1021)">
                <tr>
                <th style="width:32px;padding:0 6px">
                  <input type="checkbox" ${selCount === paged.length && paged.length > 0 ? 'checked' : ''}
                    onchange="TaxUI.toggleSelectAll(this.checked)" title="Select all on page">
                </th>
                <th>Type</th>
                <th class="sortable" onclick="TaxUI.sortTxns('date')">Date ${sortIcon('date')}</th>
                <th>Asset</th>
                <th class="ta-r">Amount</th>
                <th class="ta-r">Price (SEK)</th>
                <th class="ta-r">Value (SEK)</th>
                <th class="ta-r">Fee</th>
                <th></th>
              </tr></thead>
              <tbody>${paged.map(renderTxRow).join('')}</tbody>
            </table></div>`
      }

        ${S.editTxId ? renderEditModal() : ''}
      </div>
    `;
  }

  function renderTxRow(t) {
    const cm = CAT_META[t.category] || { icon: '•', color: '#94a3b8', label: t.category };
    const val = t.costBasisSEK || (t.priceSEKPerUnit * t.amount) || 0;
    const isInternal = t.isInternalTransfer;
    const checked = S.selectedTxIds.has(t.id);
    return `
      <tr class="${t.needsReview ? 'tax-row-review' : ''} ${isInternal ? 'tax-row-internal' : ''} ${checked ? 'tax-row-selected' : ''}">
        <td style="width:32px;padding:0 6px">
          <input type="checkbox" ${checked ? 'checked' : ''}
            onchange="TaxUI.toggleSelectTx('${t.id}',this.checked)">
        </td>
        <td>
          <span class="tax-cat-badge" style="background:${cm.color}22;color:${cm.color}">${cm.icon} ${cm.label}</span>
          ${isInternal ? '<span class="tax-transfer-tag">↔ internal</span>' : ''}
          ${t.isDuplicate ? '<span class="tax-badge" style="background:rgba(239,68,68,.1);color:#f87171;font-size:10px">DUP</span>' : ''}
        </td>
        <td class="tax-muted tax-nowrap">${fmtDateShort(t.date)}</td>
        <td>
          <div class="tax-asset-cell-col">
            <span class="tax-asset-sym">${t.assetSymbol || '—'}</span>
            ${t.category === 'trade' && t.inAsset ? `<span style="font-size:11px;color:#8b5cf6">→ ${t.inAsset}</span>` : ''}
          </div>
        </td>
        <td class="ta-r tax-mono">${TaxEngine.formatCrypto(t.amount, 8)}</td>
        <td class="ta-r tax-mono">${t.priceSEKPerUnit ? TaxEngine.formatSEK(t.priceSEKPerUnit, 2) : '<span class="tax-missing">—</span>'}</td>
        <td class="ta-r tax-mono">${val ? TaxEngine.formatSEK(val) : '<span class="tax-missing">—</span>'}</td>
        <td class="ta-r tax-mono">${t.feeSEK ? TaxEngine.formatSEK(t.feeSEK, 2) : '—'}</td>
        <td>
          <div class="tax-row-actions">
            ${t.needsReview ? '<span title="Needs review" style="font-size:13px">⚠️</span>' : ''}
            <button class="tax-icon-btn" onclick="TaxUI.editTx('${t.id}')">✏️</button>
            <button class="tax-icon-btn tax-icon-del" onclick="TaxUI.deleteTx('${t.id}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
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
  // REVIEW PAGE — exceptions only
  // ════════════════════════════════════════════════════════════
  function renderReview() {
    const issues = TaxEngine.getReviewIssues();
    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Review</h1>
          <span class="tax-page-subtitle">${issues.length} exceptions require attention</span>
          ${issues.length > 0 ? `<div class="tax-page-actions"><button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.markAllReviewed()">Mark all OK</button></div>` : ''}
        </div>

        ${issues.length === 0 ? `
          <div class="tax-review-done">
            <div style="font-size:48px">✅</div>
            <div class="tax-review-done-title">All clear!</div>
            <div class="tax-review-done-sub">No exceptions. Tax calculations are based on complete data.</div>
          </div>
        ` : `
          <div class="tax-info-box" style="margin-bottom:20px">
            <span>ℹ️</span>
            <span>Only genuine exceptions are shown here. Normal trades, transfers, and fees are classified automatically. Fix these ${issues.length} items for an accurate tax result.</span>
          </div>

          <div class="tax-review-groups">
            ${groupByReason(issues).map(({ reason, meta, items }) => `
              <div class="tax-review-group">
                <div class="tax-review-group-header">
                  <span class="tax-review-group-icon">${meta.icon}</span>
                  <div>
                    <div class="tax-review-group-title">${meta.label} <span class="tax-section-count">${items.length}</span></div>
                    <div class="tax-review-group-why">${meta.why}</div>
                  </div>
                </div>
                <div class="tax-review-fix-tip">💡 ${meta.fix}
                  ${reason === 'duplicate' ? `<button class="tax-btn tax-btn-xs" style="margin-left:8px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)" onclick="TaxUI.deleteDuplicates()">🗑 Delete all duplicates</button>` : ''}
                </div>
                <div class="tax-review-items">
                  ${items.map(({ txn }) => `
                    <div class="tax-review-item">
                      <div class="tax-ri-left">
                        <span class="tax-asset-sym">${txn.assetSymbol}</span>
                        <span class="tax-mono" style="font-size:12px">${TaxEngine.formatCrypto(txn.amount, 8)}</span>
                        <span class="tax-muted">${fmtDateShort(txn.date)}</span>
                        ${txn.isDuplicate ? `<span class="tax-badge" style="background:rgba(239,68,68,.1);color:#f87171;font-size:10px">DUP</span>` : ''}
                      </div>
                      <div class="tax-ri-right">
                        <button class="tax-btn tax-btn-xs tax-btn-primary" onclick="TaxUI.editTx('${txn.id}')">Edit</button>
                        <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.markReviewed('${txn.id}')">OK</button>
                        <button class="tax-btn tax-btn-xs" style="color:#f87171" onclick="TaxUI.deleteTx('${txn.id}')" title="Delete">🗑</button>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        `}

        ${S.editTxId ? renderEditModal() : ''}
      </div>
    `;
  }

  function groupByReason(issues) {
    const groups = {};
    for (const issue of issues) {
      if (!groups[issue.reason]) groups[issue.reason] = { reason: issue.reason, meta: issue.meta, items: [] };
      groups[issue.reason].items.push(issue);
    }
    return Object.values(groups);
  }

  // ════════════════════════════════════════════════════════════
  // REPORTS PAGE — K4 Section D, per-asset grouping
  // ════════════════════════════════════════════════════════════
  function renderReports() {
    const result = getOrComputeTaxResult();
    const { summary, disposals } = result;
    const k4 = TaxEngine.generateK4Report(result);
    const issues = TaxEngine.getReviewIssues().length;
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
              <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.downloadK4PDF()" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none">📄 Ladda ner K4 PDF</button>
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

  function openImport(type) { S.importModal = type; S.importNetwork = null; render(); }
  function selectNetwork(netId) { S.importNetwork = netId; render(); }
  function closeImport() { S.importModal = null; S.importNetwork = null; _pendingCSVText = null; render(); }

  function setFilter(key, val) { S.txFilter[key] = val; S.txPage = 0; reRenderMain(); }
  function sortTxns(field) {
    S.txSort.dir = S.txSort.field === field ? (S.txSort.dir === 'asc' ? 'desc' : 'asc') : 'desc';
    S.txSort.field = field;
    reRenderMain();
  }
  function setPage(p) { S.txPage = p; reRenderMain(); }
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
    const paged = sorted.slice(S.txPage * S.txPageSize, (S.txPage + 1) * S.txPageSize);
    if (checked) {
      for (const t of paged) S.selectedTxIds.add(t.id);
    } else {
      for (const t of paged) S.selectedTxIds.delete(t.id);
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
    if (!confirm(`Delete ${count} selected transaction${count > 1 ? 's' : ''}? This cannot be undone and will affect tax calculations.`)) return;
    const txns = TaxEngine.getTransactions().filter(t => !S.selectedTxIds.has(t.id));
    TaxEngine.saveTransactions(txns);
    S.selectedTxIds.clear();
    S.taxResult = null;
    showTaxToast('🗑', 'Deleted', `${count} transactions removed.`, 'success');
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
  function removeAccount(id) {
    if (!confirm('Remove account? All its transactions will also be deleted.')) return;
    TaxEngine.removeAccount(id); S.taxResult = null; render();
    showTaxToast('✅', 'Account removed');
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
      res = chain === 'sol'
        ? await TaxEngine.importSolanaWallet(addr, acc.id, onProgress)
        : await TaxEngine.importEthWallet(addr, acc.id, onProgress);
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

    const added = TaxEngine.addTransactions(res.txns || []);
    // Update lastSyncAt
    TaxEngine.updateAccount?.(acc.id, { lastSyncAt: new Date().toISOString() });
    S.importModal = null; S.importNetwork = null; S.taxResult = null; S.page = 'transactions';
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
    const result = getOrComputeTaxResult();
    const userInfo = { name: S.userName || '', personnummer: S.userPnr || '' };
    try {
      if (!userInfo.name && typeof AuthManager !== 'undefined') {
        const u = AuthManager.getUser();
        if (u) userInfo.name = u.name;
      }
    } catch { }
    try {
      showTaxToast('⏳', 'Genererar K4 PDF', 'Fyller i Skatteverkets blankett…', 'info');
      await K4PDFGenerator.downloadK4PDF(result, userInfo, S.taxYear);
      showTaxToast('✅', 'K4 PDF klar', 'Filen har laddats ner.', 'success');
    } catch (e) {
      console.error('[K4PDF]', e);
      showTaxToast('❌', 'Kunde inte generera K4 PDF', e.message, 'error');
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
    importWallet, importCSV, onCSVSelected,
    setFilter, sortTxns, setPage,
    openCal, closeCal, calNav, selectDate,
    editTx, closeEdit, saveEdit, deleteTx,
    toggleSelectAll, toggleSelectTx, deleteSelected, clearSelection,
    markReviewed, markAllReviewed, deleteDuplicates, removeAccount,
    downloadK4CSV, downloadK4PDF, downloadAuditCSV, downloadHoldingsCSV, printReport,
    setUserInfo, resyncAccount,
    // Portfolio dashboard
    portSetRange, filterAssets, toggleSmallBalances,
    // expose for inline onclick patterns
    filterTxns, sortTxnsArr: txns => sortTxnsArr(txns),
  };

})();

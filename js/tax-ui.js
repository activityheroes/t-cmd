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
    // Review page: active tab filter
    reviewTab: 'blockers',  // 'blockers' | 'warnings' | 'info' | 'all'
    // Review page: multi-select state
    reviewSelectedIds: new Set(),          // txn IDs selected via checkboxes
    reviewAssetCollapsed: new Set(),       // keys "reason:subType:sym" — asset sub-headers collapsed by default
    reviewGroupExpanded: new Set(),        // keys for sub-groups expanded beyond row limit
    // Review page: pending "apply to similar" toast
    pendingSimilarAction: null,            // { ids: Set, action: string, label: string }
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
    // Use computeStatusSummary as the single source of truth for the sidebar badge.
    // Show hard blocker count (rows that genuinely block the K4 export) NOT the
    // total review count, so the badge only fires when action is truly required.
    let sidebarBlockerCount = 0;
    if (S.taxResult && S.k4Report && TaxEngine.computeStatusSummary) {
      const ss = TaxEngine.computeStatusSummary(S.taxResult, S.k4Report);
      sidebarBlockerCount = ss.hardBlockerCount;
    } else if (S.taxResult) {
      // Fallback: count raw missing_history + MANUAL rows
      sidebarBlockerCount = (S.taxResult.disposals || []).filter(d =>
        d.blocksCurrentK4 === true
      ).length;
    }
    const years = TaxEngine.getAvailableTaxYears();
    const pages = [
      { id: 'portfolio',     icon: '💼', label: 'Portfolio' },
      { id: 'accounts',      icon: '🔗', label: 'Accounts' },
      { id: 'transactions',  icon: '📋', label: 'Transactions' },
      { id: 'review',        icon: '🔍', label: 'Review' },
      { id: 'reports',       icon: '📊', label: 'Reports' },
    ];

    // ── Filing status pill — reads from statusSummary, not health ──
    const k4Report = S.k4Report;
    const ss = (S.taxResult && k4Report && TaxEngine.computeStatusSummary)
      ? TaxEngine.computeStatusSummary(S.taxResult, k4Report) : null;
    const STATUS_PILL = {
      k4_ready_verified: { icon: '✅', label: 'K4-redo — verifierat',       c: '#4ade80', bg: 'rgba(34,197,94,.08)',   border: 'rgba(34,197,94,.2)'   },
      k4_ready_with_backlog: { icon: '📋', label: 'K4-redo delmängd',       c: '#60a5fa', bg: 'rgba(96,165,250,.07)', border: 'rgba(96,165,250,.2)'  },
      needs_review:      { icon: '🔍', label: 'Granska innan inlämning',   c: '#fbbf24', bg: 'rgba(251,191,36,.1)',  border: 'rgba(251,191,36,.3)'  },
      invalid:           { icon: '🔴', label: 'Beräkning ofullständig',    c: '#f87171', bg: 'rgba(239,68,68,.1)',   border: 'rgba(239,68,68,.3)'   },
      ok:                { icon: '✅', label: 'Klar',                       c: '#4ade80', bg: 'rgba(34,197,94,.08)',  border: 'rgba(34,197,94,.2)'   },
      warnings:          { icon: '⚠️', label: 'Klar med varningar',        c: '#fbbf24', bg: 'rgba(251,191,36,.07)', border: 'rgba(251,191,36,.2)'  },
    };
    const pill = ss ? (STATUS_PILL[ss.overallStatus] || null) : null;

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

      ${pill ? `
      <button onclick="TaxUI.navigate('reports')"
        style="display:flex;align-items:center;gap:8px;width:100%;margin:8px 0 4px;padding:8px 12px;border-radius:8px;
               background:${pill.bg};border:1px solid ${pill.border};cursor:pointer;text-align:left">
        <span style="font-size:14px">${pill.icon}</span>
        <span style="font-size:11px;font-weight:600;color:${pill.c};line-height:1.3">${pill.label}</span>
      </button>` : ''}

      <nav class="tax-nav">
        ${pages.map(p => `
          <button class="tax-nav-item ${S.page === p.id ? 'active' : ''}" data-page="${p.id}">
            <span class="tax-nav-icon">${p.icon}</span>
            <span class="tax-nav-label">${p.label}</span>
            ${p.id === 'review' && sidebarBlockerCount > 0 ? `<span class="tax-nav-badge">${sidebarBlockerCount}</span>` : ''}
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

        <!-- ── Review / health banner ─────────────────────── -->
        ${(() => {
          const h = (S.taxResult && TaxEngine.computeReportHealth)
            ? TaxEngine.computeReportHealth(S.taxResult) : null;
          if (h?.status === 'invalid') return `
            <div class="tax-review-banner tax-review-banner--error" onclick="TaxUI.navigate('review')" style="background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)">
              <span>🔴</span>
              <div style="flex:1">
                <strong style="color:#f87171">Beräkning troligen felaktig</strong>
                <span style="color:#94a3b8;font-size:12px;margin-left:6px">${h.k4Blockers} hårda blockerare med okänd kostnadsbas — siffrorna nedan är inte tillförlitliga</span>
              </div>
              <span class="tax-rb-link" style="color:#f87171">Åtgärda →</span>
            </div>`;
          if (h?.status === 'needs_review' || h?.status === 'warnings') {
            const ss = h.statusSummary || {};
            const parts = [];
            if (ss.hardBlockerCount > 0)       parts.push(`⛔ ${ss.hardBlockerCount} hårda blockerare`);
            if (ss.reviewRecommendedCount > 0)  parts.push(`🟡 ${ss.reviewRecommendedCount} valfri granskning`);
            if (ss.autoResolvableCount > 0)     parts.push(`✨ ${ss.autoResolvableCount} auto-lösningsbara`);
            return `
            <div class="tax-review-banner" onclick="TaxUI.navigate('review')">
              <span>🟡</span>
              <span>${parts.join(' · ') || 'Granskning behövs'}</span>
              <span class="tax-rb-link">Åtgärda →</span>
            </div>`;
          }
          if (issues > 0) return `
            <div class="tax-review-banner" onclick="TaxUI.navigate('review')">
              <span>⚠️</span>
              <span><strong>${issues} transaktioner</strong> behöver granskning — skatteberäkningen kan vara ofullständig</span>
              <span class="tax-rb-link">Åtgärda →</span>
            </div>`;
          return '';
        })()}

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
              <span class="tax-port-tax-pill-lbl">Skatt ${S.taxYear} (est. 30%, K4)</span>
              <span class="tax-port-tax-pill-val tax-red">${TaxEngine.formatSEK(summary.k4EstimatedTax || 0)}</span>
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
            <div class="tax-stat-label">K4-verifierad vinst ${S.taxYear}</div>
            <div class="tax-stat-value tax-port-pos">${TaxEngine.formatSEK(summary.k4TotalGains || 0)}</div>
            ${(summary.excludedCount || 0) > 0 ? `<div style="font-size:10px;color:#f59e0b;margin-top:2px">⚠️ ${summary.excludedCount} rad(er) exkluderade</div>` : ''}
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label" title="Inkluderar uppskattade och exkluderade rader">Uppskattad total P&L ${S.taxYear}</div>
            <div class="tax-stat-value ${(summary.totalGains - summary.totalLosses) >= 0 ? 'tax-port-pos' : ''}" style="font-size:13px;opacity:0.75">${TaxEngine.formatSEK((summary.totalGains || 0) - (summary.totalLosses || 0))}</div>
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
          <div class="tax-section-header" style="flex-wrap:wrap;gap:6px">
            <h2>Mina tillgångar</h2>
            <!-- Filter toggle -->
            <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
              <button class="tax-btn tax-btn-sm ${_portFilter === 'valued' ? 'tax-btn-primary' : 'tax-btn-ghost'}"
                data-port-filter="valued" onclick="TaxUI.setPortFilter('valued')"
                title="Visa bara tokens som finns i plånboken NU och har ett känt marknadsvärde">
                📍 Nuvarande
              </button>
              <button class="tax-btn tax-btn-sm ${_portFilter === 'all' ? 'tax-btn-primary' : 'tax-btn-ghost'}"
                data-port-filter="all" onclick="TaxUI.setPortFilter('all')" title="Visa alla innehav med positivt saldo">
                Alla innehav
              </button>
              <button class="tax-btn tax-btn-sm ${_portFilter === 'priced' ? 'tax-btn-primary' : 'tax-btn-ghost'}"
                data-port-filter="priced" onclick="TaxUI.setPortFilter('priced')" title="Visa tokens med känt pris (inkl. noll-saldo)">
                Med pris
              </button>
            </div>
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
                  <th style="width:36px"></th>
                </tr></thead>
                <tbody id="tax-assets-tbody">
                  ${sortedHoldings.map(h => renderAssetRow(h, _portFilter)).join('')}
                </tbody>
              </table></div>
              <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
                <button class="tax-btn tax-btn-sm tax-btn-ghost"
                  onclick="TaxUI.toggleSmallBalances()">Visa tokens med litet saldo ▾</button>
                <span style="font-size:10px;color:#475569">
                  ${sortedHoldings.filter(h => (h.currentValueSEK || 0) > 0).length} tillgångar med värde
                  · ${sortedHoldings.length} totalt importerade
                  ${_portFilter !== 'all' ? `<button class="tax-btn tax-btn-sm tax-btn-ghost" style="padding:0 6px;height:18px;font-size:9px;margin-left:4px" onclick="TaxUI.setPortFilter('all')">Visa alla →</button>` : ''}
                </span>
              </div>`
      }
        </div>
      </div>
    `;
  }

  function renderAssetRow(h, portFilter) {
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
    // Explorer link for this asset (Solana tokens only via SYM_TO_MINT reverse map)
    const solMint = TaxEngine.SYM_TO_MINT && TaxEngine.SYM_TO_MINT[displaySym];
    const solscanTokenUrl = solMint ? `https://solscan.io/token/${solMint}` : null;
    // CoinGecko fallback for non-Solana tokens with known symbols
    const geckoUrl = !solMint && displaySym ? `https://www.coingecko.com/en/coins/${displaySym.toLowerCase()}` : null;
    const assetExplorerUrl = solscanTokenUrl || geckoUrl;
    const assetExplorerName = solscanTokenUrl ? 'Solscan' : 'CoinGecko';
    // 3-dot menu id (unique per row)
    const menuId = `asset-menu-${displaySym.replace(/[^a-z0-9]/gi, '_')}`;
    const hasPrice  = (h.currentValueSEK || 0) > 0 || (h.currentPriceSEK || 0) > 0;
    const hasValue  = (h.currentValueSEK || 0) > 0;
    const hideRow   = (portFilter === 'priced' && !hasPrice)
                   || (portFilter === 'valued' && !hasValue);
    return `<tr data-has-price="${hasPrice ? '1' : '0'}" data-has-value="${hasValue ? '1' : '0'}" style="${hideRow ? 'display:none' : ''}">
      <td>
        <div class="tax-asset-cell">
          <img class="tax-alloc-icon" src="${icon}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt="${displaySym}">
          <span class="tax-asset-icon" style="display:none;font-size:9px">${displaySym.slice(0, 3)}</span>
          <div>
            <div class="tax-asset-sym">${displayName}</div>
            <div class="tax-asset-name" style="display:flex;align-items:center;gap:4px">
              ${displaySym}
              ${assetExplorerUrl ? `<a href="${assetExplorerUrl}" target="_blank" rel="noopener noreferrer"
                class="tax-explorer-icon" title="View ${displaySym} on ${assetExplorerName}">↗</a>` : ''}
            </div>
          </div>
          <div class="tax-asset-menu-wrap" style="position:relative;margin-left:auto">
            <button class="tax-asset-menu-btn" title="Åtgärder"
              onclick="event.stopPropagation();(function(id){var m=document.getElementById(id);if(m)m.style.display=m.style.display==='block'?'none':'block'})('${menuId}')">⋮</button>
            <div id="${menuId}" class="tax-asset-dropdown" style="display:none">
              <button onclick="TaxUI.filterTxsByAsset('${displaySym}')">📋 Visa transaktioner</button>
              ${assetExplorerUrl ? `<a href="${assetExplorerUrl}" target="_blank" rel="noopener noreferrer">🔍 ${assetExplorerName} ↗</a>` : ''}
              ${solMint ? `<a href="https://solana.fm/address/${solMint}" target="_blank" rel="noopener noreferrer">🔍 SolanaFM ↗</a>` : ''}
            </div>
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
      <td style="text-align:center;padding:4px">
        <button class="tax-btn tax-btn-xs tax-btn-ghost"
          onclick="TaxUI.openAssetAudit('${h.symbol}')"
          title="Granska anskaffnings- och avyttringshistorik för ${displaySym}"
          style="padding:2px 6px;font-size:10px;opacity:.6;transition:opacity .15s"
          onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.6">🔍</button>
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

  // ── Portfolio filter state ──────────────────────────────────
  // 'valued' → (default) only tokens with positive current wallet value
  // 'all'    → all tokens with remaining computed quantity
  // 'priced' → tokens with any known price (incl. no-value holdings)
  let _portFilter = 'valued';
  function setPortFilter(mode) {
    _portFilter = mode;
    const tbody = document.getElementById('tax-assets-tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-has-price]').forEach(row => {
      const hasPrice = row.dataset.hasPrice === '1';
      const hasValue = row.dataset.hasValue === '1';
      if (mode === 'priced')      row.style.display = hasPrice ? '' : 'none';
      else if (mode === 'valued') row.style.display = hasValue ? '' : 'none';
      else row.style.display = '';
    });
    // Update button active state
    document.querySelectorAll('[data-port-filter]').forEach(btn => {
      btn.classList.toggle('tax-btn-primary', btn.dataset.portFilter === mode);
      btn.classList.toggle('tax-btn-ghost',   btn.dataset.portFilter !== mode);
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
  // ASSET AUDIT LEDGER
  // Per-token drilldown: acquisitions → disposals → current balance
  // Opens as an overlay modal
  // ════════════════════════════════════════════════════════════
  function openAssetAudit(rawSym) {
    const result = getOrComputeTaxResult();
    if (!result) return;

    const allTxns = TaxEngine.getTransactions();
    const sym = rawSym; // canonical symbol as stored in engine

    // ── Acquisitions: all txns where this asset was received ────
    const ACQ_CATS = ['buy','receive','income','staking','airdrop','transfer_in','bridge_in','trade_in'];
    const rawAcqs = allTxns.filter(t => {
      if (t.isInternalTransfer) return false;
      if (t.assetSymbol === sym && ACQ_CATS.includes(t.category)) return true;
      if (t.category === 'trade' && t.inAsset === sym && (t.inAmount || 0) > 0) return true;
      return false;
    });
    // Also pull from assetAcquisitions map (richer metadata)
    const engineAcqs = (result.assetAcquisitions || {})[sym] || [];

    // ── Disposals: all disposals for this symbol (all years) ───
    const symDisposals = result.disposals.filter(d => d.assetSymbol === sym);

    // ── Current holding ────────────────────────────────────────
    const holding = result.currentHoldings.find(h => h.symbol === sym || h.symbol === TaxEngine.resolveTokenDisplay?.(sym)?.symbol);
    const remainingQty = holding ? holding.quantity : 0;
    const avgCost      = holding ? holding.avgCostSEK : 0;
    const totalCostBasis = holding ? holding.totalCostSEK : 0;

    // ── Summary stats ──────────────────────────────────────────
    const totalAcqQty  = engineAcqs.reduce((s, a) => s + (a.amount || 0), 0);
    const totalDispQty = symDisposals.reduce((s, d) => s + (d.amountSold || 0), 0);
    const totalGainLoss = symDisposals.reduce((s, d) => s + (d.gainLossSEK || 0), 0);
    const trustedAcqs  = engineAcqs.filter(a => a.isTrusted).length;
    const untrustedAcqs = engineAcqs.filter(a => !a.isTrusted).length;
    // Airdrop-specific stats for this asset
    const airdropAcqs      = engineAcqs.filter(a => a.isAirdrop);
    const spamAirdropAcqs  = airdropAcqs.filter(a => a.airdropSubtype === 'spam');
    const realAirdropAcqs  = airdropAcqs.filter(a => a.airdropSubtype !== 'spam');
    const hasAirdropHistory = airdropAcqs.length > 0;

    // ── Category label ─────────────────────────────────────────
    const catLabel = { buy:'Köp', receive:'Mottagning', income:'Inkomst', staking:'Staking',
      airdrop:'Airdrop', transfer_in:'Transfer in', bridge_in:'Bridge in', trade_in:'Byte (in)', };

    const fmtDate = d => (d || '').slice(0, 10);
    const fmtAmt  = v => v != null ? TaxEngine.formatCrypto(v, 6) : '—';

    const html = `
    <div id="tax-audit-overlay" onclick="if(event.target===this)TaxUI.closeAssetAudit()"
         style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto">
      <div style="background:#0f172a;border:1px solid rgba(148,163,184,.15);border-radius:14px;width:100%;max-width:900px;padding:0;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.6)">

        <!-- Header -->
        <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid rgba(148,163,184,.1);background:rgba(255,255,255,.02)">
          <span style="font-size:20px;font-weight:800;color:#e2e8f0">${sym}</span>
          <span style="font-size:13px;color:#94a3b8">Granskningslogg</span>
          <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.filterTxsByAsset('${sym}')">Visa transaktioner →</button>
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.closeAssetAudit()">✕</button>
          </div>
        </div>

        <!-- Summary bar -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:rgba(148,163,184,.08);border-bottom:1px solid rgba(148,163,184,.1)">
          ${[
            ['Totalt anskaffat', `${fmtAmt(totalAcqQty)} ${sym}`],
            ['Totalt avyttrat', `${fmtAmt(totalDispQty)} ${sym}`],
            ['Kvarvarande (beräknat)', `${fmtAmt(remainingQty)} ${sym}`],
            ['Genomsnittskostnad', avgCost > 0 ? TaxEngine.formatSEK(avgCost) + '/st' : '—'],
            ['Total kostnadsbas', TaxEngine.formatSEK(totalCostBasis)],
            ['Realiserat vinst/förlust', `<span style="color:${totalGainLoss >= 0 ? '#4ade80' : '#f87171'}">${TaxEngine.formatSEK(totalGainLoss)}</span>`],
            ['Betrodda anskaffningar', `${trustedAcqs} ✓ / <span style="color:#fbbf24">${untrustedAcqs} ej betrodda</span>`],
          ].map(([lbl, val]) => `
          <div style="padding:10px 14px;background:#0f172a">
            <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${lbl}</div>
            <div style="font-size:12px;font-weight:600;color:#e2e8f0">${val}</div>
          </div>`).join('')}
        </div>

        <!-- Airdrop notice banner — shown only when asset has airdrop history -->
        ${hasAirdropHistory ? `
        <div style="padding:10px 20px;background:rgba(167,139,250,.06);border-bottom:1px solid rgba(167,139,250,.15)">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:13px">📬</span>
            <span style="font-size:11px;font-weight:600;color:#a78bfa">Airdrop-historik</span>
            <span style="font-size:11px;color:#94a3b8">
              ${realAirdropAcqs.length > 0 ? `${realAirdropAcqs.length} verklig(a) airdrop(s)` : ''}
              ${spamAirdropAcqs.length > 0 ? `· ${spamAirdropAcqs.length} spam (exkluderad)` : ''}
              — kostnadsbasen nedan är marknadsvärdet vid mottagning, ej ett köp.
            </span>
            ${spamAirdropAcqs.length > 0 ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,.12);color:#f87171">Spam exkluderas automatiskt från K4</span>` : ''}
          </div>
        </div>` : ''}

        <!-- Acquisitions -->
        <div style="padding:14px 20px">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">
            Anskaffningar (${engineAcqs.length})
          </div>
          ${engineAcqs.length === 0 ? `<div style="font-size:11px;color:#f87171;padding:8px 0">⚠ Inga anskaffningar importerade för denna tillgång</div>` : `
          <div style="max-height:200px;overflow-y:auto;border-radius:6px;border:1px solid rgba(148,163,184,.08)">
            <table style="width:100%;border-collapse:collapse;font-size:10px">
              <thead style="position:sticky;top:0;background:#0f172a">
                <tr style="color:#475569">
                  <th style="padding:5px 8px;text-align:left;border-bottom:1px solid rgba(148,163,184,.08)">Datum</th>
                  <th style="padding:5px 8px;text-align:left;border-bottom:1px solid rgba(148,163,184,.08)">Typ</th>
                  <th style="padding:5px 8px;text-align:right;border-bottom:1px solid rgba(148,163,184,.08)">Antal</th>
                  <th style="padding:5px 8px;text-align:right;border-bottom:1px solid rgba(148,163,184,.08)">Kostnad</th>
                  <th style="padding:5px 8px;text-align:left;border-bottom:1px solid rgba(148,163,184,.08)">Priskälla</th>
                  <th style="padding:5px 8px;text-align:center;border-bottom:1px solid rgba(148,163,184,.08)">K4-betrodd</th>
                </tr>
              </thead>
              <tbody>
                ${engineAcqs.map(a => {
                  const isSwapAcq    = a.category === 'trade_in';
                  const isAirdropAcq = a.isAirdrop || a.category === 'airdrop';
                  const adSubtype    = a.airdropSubtype;   // 'claimed'|'unsolicited'|'spam'|null
                  const adConf       = a.airdropConfidence; // 'high'|'medium'|'low'|null
                  // Badge shown after category label
                  const adBadge = isAirdropAcq
                    ? (adSubtype === 'spam'
                        ? `<span title="Spam-airdrop — ej inkluderad i skatteberäkning" style="margin-left:4px;font-size:7px;padding:1px 4px;border-radius:3px;background:rgba(239,68,68,.15);color:#f87171">SPAM</span>`
                        : adSubtype === 'unsolicited'
                          ? `<span title="Mottagen utan användaråtgärd (oönskad airdrop)" style="margin-left:4px;font-size:7px;padding:1px 4px;border-radius:3px;background:rgba(251,191,36,.12);color:#fbbf24">OÖNSKAD</span>`
                          : `<span title="Aktivt claimad airdrop" style="margin-left:4px;font-size:7px;padding:1px 4px;border-radius:3px;background:rgba(74,222,128,.12);color:#4ade80">CLAIMAD</span>`)
                    : '';
                  // Confidence dot for airdrops
                  const confDot = isAirdropAcq && adConf
                    ? ` <span title="Konfidens: ${adConf}" style="color:${adConf==='high'?'#4ade80':adConf==='medium'?'#fbbf24':'#f87171'};font-size:8px">●</span>`
                    : '';
                  // Cost label — distinguish airdrop FMV from real purchase cost
                  const costLabel = a.costSEK != null
                    ? TaxEngine.formatSEK(a.costSEK)
                      + (isSwapAcq
                          ? ' <span title="Kostnadsbas tilldelad från byte, ej direkt SEK-investering" style="color:#f59e0b;font-size:8px">via swap ⓘ</span>'
                          : isAirdropAcq
                            ? ' <span title="Marknadsvärde vid mottagning (ej köpkostnad)" style="color:#a78bfa;font-size:8px">FMV vid mottagning ⓘ</span>'
                            : '')
                    : '—';
                  return `
                <tr style="border-bottom:1px solid rgba(148,163,184,.04);${adSubtype==='spam'?'opacity:.5':''}">
                  <td style="padding:4px 8px;color:#64748b;font-family:monospace;white-space:nowrap">${fmtDate(a.date)}</td>
                  <td style="padding:4px 8px;color:#94a3b8;white-space:nowrap">${catLabel[a.category] || a.category}${adBadge}${confDot}</td>
                  <td style="padding:4px 8px;text-align:right;color:#e2e8f0;font-family:monospace">${fmtAmt(a.amount)}</td>
                  <td style="padding:4px 8px;text-align:right;color:#94a3b8;font-family:monospace">${costLabel}</td>
                  <td style="padding:4px 8px;color:#64748b;font-family:monospace;font-size:9px">${a.priceSource || '—'}</td>
                  <td style="padding:4px 8px;text-align:center">${a.isTrusted ? '<span style="color:#4ade80">✓</span>' : '<span style="color:#f59e0b">⚠</span>'}</td>
                </tr>`; }).join('')}
              </tbody>
            </table>
          </div>`}

          <!-- Disposals -->
          <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px">
            Avyttringar (${symDisposals.length})
          </div>
          ${symDisposals.length === 0 ? `<div style="font-size:11px;color:#64748b;padding:8px 0">Inga avyttringar registrerade</div>` : `
          <div style="max-height:220px;overflow-y:auto;border-radius:6px;border:1px solid rgba(148,163,184,.08)">
            <table style="width:100%;border-collapse:collapse;font-size:10px">
              <thead style="position:sticky;top:0;background:#0f172a">
                <tr style="color:#475569">
                  <th style="padding:5px 8px;text-align:left;border-bottom:1px solid rgba(148,163,184,.08)">Datum</th>
                  <th style="padding:5px 8px;text-align:right;border-bottom:1px solid rgba(148,163,184,.08)">Antal</th>
                  <th style="padding:5px 8px;text-align:right;border-bottom:1px solid rgba(148,163,184,.08)">Intäkt</th>
                  <th style="padding:5px 8px;text-align:right;border-bottom:1px solid rgba(148,163,184,.08)">KB</th>
                  <th style="padding:5px 8px;text-align:right;border-bottom:1px solid rgba(148,163,184,.08)">Vinst/Förlust</th>
                  <th style="padding:5px 8px;text-align:left;border-bottom:1px solid rgba(148,163,184,.08)">Status</th>
                  <th style="padding:5px 8px;text-align:left;border-bottom:1px solid rgba(148,163,184,.08)">Matematik ▾</th>
                </tr>
              </thead>
              <tbody>
                ${symDisposals.map(d => {
                  const gl = d.gainLossSEK;
                  const statusColor = d.valuationStatus === 'final' ? '#4ade80'
                    : d.valuationStatus === 'missing_history' ? '#f87171' : '#fbbf24';
                  const statusLabel = {
                    final: '✓ Klar', missing_history: '⛔ Saknad KB', estimated_reviewable: '⚠ Uppskattad',
                    blocked_outlier: '🚫 Blockerad', unknown_asset_identity: '❓ Okänd',
                  }[d.valuationStatus] || d.valuationStatus;
                  const mathLines = buildDisposalFullExplanation(d);
                  const mathId = `math-${d.id || Math.random().toString(36).slice(2)}`;
                  return `
                <tr style="border-bottom:1px solid rgba(148,163,184,.04);${d.valuationStatus !== 'final' ? 'background:rgba(251,191,36,.03)' : ''}">
                  <td style="padding:4px 8px;color:#64748b;font-family:monospace;white-space:nowrap">${fmtDate(d.date)}</td>
                  <td style="padding:4px 8px;text-align:right;color:#e2e8f0;font-family:monospace">${fmtAmt(d.amountSold)}</td>
                  <td style="padding:4px 8px;text-align:right;font-family:monospace;color:#94a3b8">${d.proceedsSEK != null ? TaxEngine.formatSEK(d.proceedsSEK) : '—'}</td>
                  <td style="padding:4px 8px;text-align:right;font-family:monospace;color:#94a3b8">${d.costBasisSEK != null ? TaxEngine.formatSEK(d.costBasisSEK) : '—'}</td>
                  <td style="padding:4px 8px;text-align:right;font-family:monospace;color:${gl == null ? '#475569' : gl >= 0 ? '#4ade80' : '#f87171'}">${gl != null ? TaxEngine.formatSEK(gl) : '—'}</td>
                  <td style="padding:4px 8px;white-space:nowrap"><span style="font-size:9px;color:${statusColor}">${statusLabel}</span></td>
                  <td style="padding:4px 8px;font-size:9px;max-width:240px">
                    <details>
                      <summary style="cursor:pointer;color:#475569;list-style:none;user-select:none">Visa math ▾</summary>
                      <div id="${mathId}" style="margin-top:4px;padding:6px 8px;background:rgba(0,0,0,.3);border-radius:4px;border:1px solid rgba(148,163,184,.08);color:#64748b;line-height:1.7">
                        ${mathLines.map(l => `<div>${l}</div>`).join('')}
                      </div>
                    </details>
                  </td>
                </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`}

          <!-- Reconciliation note -->
          <div style="margin-top:12px;padding:10px 12px;border-radius:6px;background:rgba(148,163,184,.04);border:1px solid rgba(148,163,184,.08);font-size:10px;color:#64748b;line-height:1.6">
            <strong style="color:#94a3b8">Avstämning:</strong>
            Anskaffat ${fmtAmt(totalAcqQty)} − avyttrat ${fmtAmt(totalDispQty)} = beräknat kvar ${fmtAmt(totalAcqQty - totalDispQty)}.
            Motorn visar ${fmtAmt(remainingQty)} kvar.
            ${Math.abs((totalAcqQty - totalDispQty) - remainingQty) > 0.001
              ? `<span style="color:#f59e0b"> ⚠ Delta: ${fmtAmt(Math.abs((totalAcqQty - totalDispQty) - remainingQty))} — möjlig saknad transaktion eller intern transfer.</span>`
              : `<span style="color:#4ade80"> ✓ Stämmer.</span>`}
          </div>
        </div>
      </div>
    </div>`;

    // Mount overlay
    let el = document.getElementById('tax-audit-overlay');
    if (el) el.remove();
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function closeAssetAudit() {
    const el = document.getElementById('tax-audit-overlay');
    if (el) el.remove();
  }

  // Build a short plain-language explanation for a disposal row (table view)
  function buildDisposalExplanation(d) {
    const parts = [];
    const evtMap = { trade:'Byte/swap', sell:'Försäljning', send:'Skickad', transfer_out:'Transfer ut',
      bridge_out:'Bridge ut', income:'Inkomst', staking:'Staking-utdelning' };
    const evtType = (d.eventType && evtMap[d.eventType]) || (d.proceedsSource ? 'Avyttring' : '—');
    parts.push(evtType);
    if (d.proceedsSource) parts.push(`Intäktskälla: ${d.proceedsSource}`);
    if (d.avgCostAtSale > 0) parts.push(`Avg.kostnad: ${TaxEngine.formatSEK(d.avgCostAtSale)}/st`);
    if (d.zeroCostReason) {
      const zMap = {
        acquisition_missing:'Ingen anskaffning hittad',
        acquisition_partial:'Delvis anskaffningshistorik',
        acquisition_untrusted:'Ej betrodd anskaffningskälla',
        confirmed_zero:'Anskaffat till 0 kr (airdrop)',
      };
      parts.push(zMap[d.zeroCostReason] || d.zeroCostReason);
    }
    if (d.reviewReasons?.length) parts.push(d.reviewReasons[0]);
    return parts.slice(0, 3).join(' · ');
  }

  // Build a FULL plain-language math breakdown for a disposal (audit modal)
  function buildDisposalFullExplanation(d) {
    const fmt   = v => TaxEngine.formatSEK(v);
    const fmtQ  = (v, sym) => `${TaxEngine.formatCrypto(v, 6)} ${sym || ''}`.trim();
    const lines = [];

    // ── Event type
    const evtMap = { trade:'Byte/swap', sell:'Försäljning', send:'Skickad',
      transfer_out:'Transfer ut', bridge_out:'Bridge ut' };
    const evtType = (d.eventType && evtMap[d.eventType]) || 'Avyttring';
    if (d.eventSubtype === 'token_account_close') {
      lines.push('🔒 Token-account stängd — Solana rent-refund, inte en avyttring');
      lines.push('ℹ Intäkter satta till 0 kr. Liten SOL-återbetalning (~0.002 SOL) exkluderas som brus.');
    } else if (d.eventSubtype === 'burn') {
      lines.push('🔥 Bränd/incinererad — intäkter satta till 0');
    } else if (d.jupiterMultiHop) {
      lines.push(`🔀 Jupiter multi-hop swap (${d.routeHops || '?'} hopp kollapsade → en ekonomisk avyttring)`);
    } else {
      lines.push(`Händelse: ${evtType}`);
    }

    // ── Proceeds math for swaps
    if (d.isTrade && d.inAsset && d.inAmount > 0) {
      const inAsset = d.inAsset;
      const inAmt   = d.inAmount;
      if (d.proceedsSEK != null) {
        const impliedPerUnit = inAmt > 0 ? d.proceedsSEK / inAmt : 0;
        lines.push(`Mottaget: ${fmtQ(inAmt, inAsset)}`);
        lines.push(`Intäkt = ${fmtQ(inAmt, inAsset)} × ${fmt(impliedPerUnit)}/${inAsset} = ${fmt(d.proceedsSEK)}`);
      } else {
        lines.push(`Mottaget: ${fmtQ(inAmt, inAsset)} (intäkt ej beräknad)`);
      }
    } else if (d.proceedsSEK != null) {
      lines.push(`Intäkt: ${fmt(d.proceedsSEK)}`);
    }

    // ── Cost basis math
    if (d.amountSold > 0 && d.costBasisSEK != null) {
      const cbPerUnit = d.amountSold > 0 ? d.costBasisSEK / d.amountSold : 0;
      const avgLabel  = d.zeroCostReason
        ? `(${d.zeroCostReason === 'acquisition_untrusted' ? 'ej betrodd källa' : d.zeroCostReason})`
        : (d.avgCostAtSale > 0 ? `Avg-kostnad ${fmt(d.avgCostAtSale)}/st` : '');
      lines.push(`KB = ${fmtQ(d.amountSold, d.assetSymbol)} × ${fmt(cbPerUnit)}/st ${avgLabel} = ${fmt(d.costBasisSEK)}`);
    } else if (d.zeroCostReason) {
      const zMap = { acquisition_missing:'Ingen anskaffningshistorik importerad',
        acquisition_partial:'Sålde mer än importerat', acquisition_untrusted:'Ej betrodd priskälla',
        confirmed_zero:'Anskaffat till 0 kr (airdrop)' };
      lines.push(`KB: ${zMap[d.zeroCostReason] || d.zeroCostReason}`);
    }

    // ── Gain/loss
    if (d.gainLossSEK != null) {
      const gl = d.gainLossSEK;
      lines.push(`Vinst/Förlust = ${fmt(d.proceedsSEK || 0)} − ${fmt(d.costBasisSEK || 0)} = ${gl >= 0 ? '+' : ''}${fmt(gl)}`);
    }

    // ── Prissource + confidence
    if (d.priceSource)    lines.push(`Priskälla: ${d.priceSource}`);
    if (d.proceedsSource && d.proceedsSource !== d.priceSource)
      lines.push(`Intäktskälla: ${d.proceedsSource}`);

    // ── Acquisition source context
    const acqSrc = d.proceedsSource || d.priceSource || '';
    if (acqSrc.includes('swap') || acqSrc.includes('SWAP') || d.isTrade) {
      lines.push('ℹ Kostnadsbas härledd från tidigare swaps — ej direkt SEK-insättning');
    }

    // ── Airdrop origin note — shown when the disposed asset was originally received
    //    as an airdrop (so the user understands why their cost basis looks unusual)
    if (d._airdropSubtype || d.airdropOriginSubtype) {
      const sub = d._airdropSubtype || d.airdropOriginSubtype;
      const conf = d._airdropConfidence || d.airdropOriginConfidence || '';
      if (sub === 'spam') {
        lines.push('⚠ Ursprungligen mottaget som SPAM-airdrop — kostnadsbas 0 kr');
      } else if (sub === 'unsolicited') {
        lines.push(`📬 Ursprungligen mottaget som oönskad airdrop (${conf} konfidens) — kostnadsbas = FMV vid mottagning`);
      } else if (sub === 'claimed') {
        lines.push('✅ Ursprungligen claimad airdrop — kostnadsbas = FMV vid mottagning');
      }
    }

    // ── Economic event reconstruction provenance (Solana)
    if (d.reconstructionSummary) {
      const confIcon = d.reconstructionConfidence === 'exact' ? '✅'
        : d.reconstructionConfidence === 'high'   ? '🔍'
        : d.reconstructionConfidence === 'medium' ? '⚠'
        : '🔴';
      lines.push(`${confIcon} Rekonstruktion: "${d.reconstructionSummary}"`);
      if (d.ignoredRouteLegs?.length) {
        lines.push(`   Ignorerat: ${d.ignoredRouteLegs.join(', ')}`);
      }
      if (d.reconstructionConfidence === 'low') {
        lines.push('🔴 Lågkonfidens rekonstruktion — exkluderad från K4 tills du bekräftar manuellt');
      }
    }

    // ── Tx-level classification gate (Step 3a)
    // Show what classifySolanaTransaction() decided about the entire tx
    if (d._reconstruction?.txType && d._reconstruction.txType !== 'unknown') {
      const txTypeLabels = {
        swap:              '🔄 Swap-transaktion',
        rent_refund:       '🏦 Kontoåterbetalning (hyra)',
        rent_deposit:      '🏦 Kontoinsättning (hyra)',
        fee_only:          '💸 Enbart nätverksavgift',
        internal_transfer: '↔️ Intern transfer',
        external_send:     '➡️ Extern SOL-sändning',
        token_receive:     '📥 Token mottagen',
      };
      const txLabel = txTypeLabels[d._reconstruction.txType] || d._reconstruction.txType;
      const dispGate = d._reconstruction.txLevelDisposalPermitted === false
        ? ' — avyttring blockerad (tx-nivå)'
        : '';
      lines.push(`${txLabel}${dispGate}`);
    }

    // ── SOL outflow classification (Solana Case F)
    if (d.solOutflowType) {
      const solConfIcon = d.solOutflowConfidence === 'high' ? '✅'
        : d.solOutflowConfidence === 'medium' ? '🔍'
        : '⚠';
      const solTypeLabel = {
        fee:                      'Nätverksavgift',
        rent_deposit:             'Hyresdepåposition (ATA)',
        swap_funding:             'Swapfinansiering (DEX-routing)',
        app_operational_send:     'Appoperativt SOL-utflöde',
        unclassified_sol_outflow: 'Oklassificerat SOL-utflöde',
        taxable_disposal_candidate: 'Potentiellt skattepliktigt SOL-utflöde',
      }[d.solOutflowType] || d.solOutflowType;
      lines.push(`${solConfIcon} SOL-klassificering: ${solTypeLabel}`);
    }

    // ── Transaction-level over-allocation warning
    if (d.txProceedsOverallocated) {
      lines.push(`🔴 INTÄKTS-DUBLETT: Samma tx-utdata tilldelad ${d.txRowCount || 2} rader — exkluderad från K4`);
      if (d.txHash) lines.push(`Tx: ${d.txHash.slice(0, 20)}…`);
    } else if (d.multipleDisposalsFromSingleSwap && d.txHash) {
      lines.push(`ℹ Flera avyttringar från samma tx (${d.txRowCount || 2} rader) — beloppen är olika, ej dubbletter`);
      lines.push(`Tx: ${d.txHash.slice(0, 20)}…`);
    } else if (d.txHash && !d.txHash.startsWith('manual_')) {
      lines.push(`Tx: ${d.txHash.slice(0, 20)}…`);
    }

    // ── Review reasons
    if (d.reviewReasons?.length) {
      const filtered = d.reviewReasons.filter(r => !r.startsWith('tx_proceeds_overallocated'));
      if (filtered.length) lines.push(`⚠ ${filtered.slice(0, 2).join('; ')}`);
    }

    return lines;
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

    // Detect orphaned transactions: belong to accounts that no longer exist
    const knownAccountIds = new Set(accounts.map(a => a.id));
    const orphanedTxns = txns.filter(t => !knownAccountIds.has(t.accountId));
    const orphanedCount = orphanedTxns.length;
    const hasOrphans = orphanedCount > 0;

    // Detect Solana accounts with potentially stale imports (old broken split-swap format).
    // A stale import has multiple solana_wallet transactions sharing a txHash but categorised
    // as transfer_in/transfer_out instead of a single TRADE row.
    const solanaTxns = txns.filter(t => t.source === 'solana_wallet');
    const solanaTxByHash = {};
    for (const t of solanaTxns) {
      if (!t.txHash) continue;
      solanaTxByHash[t.txHash] = (solanaTxByHash[t.txHash] || 0) + 1;
    }
    const splitHashCount = Object.values(solanaTxByHash).filter(v => v >= 2).length;
    const hasStaleSolana = splitHashCount > 0;

    // Detect phantom Solana transactions (imported before failed-tx filter).
    // A phantom has an implausibly large SOL amount or SEK cost basis.
    const MAX_SOL_SINGLE_TX  = 10_000;
    const MAX_SEK_SINGLE_TX  = 50_000_000;
    const phantomSolTxns = solanaTxns.filter(t =>
      (t.assetSymbol === 'SOL' && (t.amount || 0) > MAX_SOL_SINGLE_TX) ||
      (t.inAsset === 'SOL' && (t.inAmount || 0) > MAX_SOL_SINGLE_TX) ||
      (t.costBasisSEK || 0) > MAX_SEK_SINGLE_TX
    );
    const hasPhantomSolana = phantomSolTxns.length > 0;

    // Detect corrupt/legacy transactions that need the data migration cleanup
    const cleanupStats = TaxEngine.getCleanupStats ? TaxEngine.getCleanupStats() : null;
    const hasCorruptData = cleanupStats && cleanupStats.affected > 0;

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

        <!-- ── Solana stale-import warning ──────────────────── -->
        ${hasStaleSolana ? `
        <div class="tax-warn-banner tax-warn-banner--info" style="margin-bottom:14px">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="font-size:18px;flex-shrink:0">◎</span>
            <div style="flex:1">
              <div style="font-weight:700;font-size:13px;margin-bottom:4px">Solana-importer behöver rekonstrueras</div>
              <div style="font-size:12px;color:var(--text-secondary)">
                Vi har hittat <strong>${splitHashCount}</strong> Solana-transaktion${splitHashCount !== 1 ? 'er' : ''} som är upplupna som separata transfer-rader istället för som en TRADE.
                Det här orsakar falska vinster eftersom kostnasbas för memecoins sätts till 0.
                Klicka på <strong>Rekonstruera swappar</strong> nedan för att åtgärda, sedan kör pipeline igen.
              </div>
            </div>
            <button class="tax-btn tax-btn-sm" style="background:#6366f1;color:#fff;flex-shrink:0;white-space:nowrap"
              onclick="TaxUI.reprocessAndSaveSolana()">
              ◎ Rekonstruera swappar
            </button>
          </div>
        </div>` : ''}

        <!-- ── Phantom Solana data warning ──────────────────── -->
        ${hasPhantomSolana ? `
        <div class="tax-warn-banner" style="margin-bottom:14px;border-color:#ef444466;background:rgba(239,68,68,0.08)">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="font-size:18px;flex-shrink:0">🚨</span>
            <div style="flex:1">
              <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:#f87171">Phantom-transaktioner hittades — felaktiga K4-siffror!</div>
              <div style="font-size:12px;color:var(--text-secondary)">
                ${phantomSolTxns.length} Solana-transaktioner har orimliga belopp (misslyckade DEX-swappar
                som importerades som riktiga händelser). Dessa skapar miljardsiffror i K4.
                <strong>Rensa dem direkt</strong> och reimportera plånboken.
              </div>
            </div>
            <button class="tax-btn tax-btn-sm" style="background:#ef4444;color:#fff;flex-shrink:0;white-space:nowrap"
              onclick="TaxUI.purgeAndResync()">
              🧹 Rensa & reimportera
            </button>
          </div>
        </div>` : ''}

        <!-- ── Corrupt/legacy data migration warning ──────────── -->
        ${hasCorruptData ? `
        <div class="tax-warn-banner" style="margin-bottom:14px;border-color:#f59e0b99;background:rgba(245,158,11,0.08)">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="font-size:20px;flex-shrink:0">🛠</span>
            <div style="flex:1">
              <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:#fbbf24">
                ${cleanupStats.affected} transaktioner med korrupta importvärden
              </div>
              <div style="font-size:12px;color:var(--text-secondary);line-height:1.6">
                Gamla Solana-importer innehåller felaktiga belopp (lamport-skalningsfel, felaktiga priser inlagda från swap-rekonstruktion).
                Dessa kan inflatera skattevinsten med miljontals kronor.
                <strong>Kör datarensning</strong> för att rätta till dem — alla berörda transaktioner omprissätts och felaktiga värden tas bort.
                ${cleanupStats.byType.full_mint_as_inasset  ? `<br>• ${cleanupStats.byType.full_mint_as_inasset} med full mint-adress som inAsset (nollkostnadsbug — roten till okänd kostnadsbas)` : ''}
                ${cleanupStats.byType.full_mint_as_symbol  ? `<br>• ${cleanupStats.byType.full_mint_as_symbol} med full mint-adress som symbol` : ''}
                ${cleanupStats.byType.corrupt_sol_inamount ? `<br>• ${cleanupStats.byType.corrupt_sol_inamount} med felaktigt SOL-belopp (lamport-artefakt)` : ''}
                ${cleanupStats.byType.corrupt_stored_price ? `<br>• ${cleanupStats.byType.corrupt_stored_price} med extremt högt lagrat pris` : ''}
                ${cleanupStats.byType.previously_flagged   ? `<br>• ${cleanupStats.byType.previously_flagged} redan flaggade som misstänkta` : ''}
              </div>
            </div>
            <button class="tax-btn tax-btn-sm" style="background:#f59e0b;color:#000;flex-shrink:0;white-space:nowrap;font-weight:700"
              onclick="TaxUI.runDataCleanup()">
              🛠 Kör datarensning
            </button>
          </div>
        </div>` : ''}

        <!-- ── Orphaned transactions warning ───────────────────── -->
        ${hasOrphans ? `
        <div class="tax-warn-banner" style="margin-bottom:14px;border-color:#f59e0b66;background:rgba(245,158,11,0.08)">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="font-size:18px;flex-shrink:0">🧹</span>
            <div style="flex:1">
              <div style="font-weight:700;font-size:13px;margin-bottom:4px;color:#fbbf24">${orphanedCount.toLocaleString()} transaktioner från borttagna konton</div>
              <div style="font-size:12px;color:var(--text-secondary)">
                Dessa transaktioner tillhör plånböcker/börser som du har tagit bort. De påverkar fortfarande
                skatterapporten tills du tar bort dem. Det är troligen det som orsakar 641 granskningsproblem.
              </div>
            </div>
            <button class="tax-btn tax-btn-sm" style="background:#f59e0b;color:#000;flex-shrink:0;white-space:nowrap;font-weight:700"
              onclick="TaxUI.deleteOrphanedTransactions()">
              🗑 Ta bort ${orphanedCount.toLocaleString()} transaktioner
            </button>
          </div>
        </div>` : ''}

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
            <span class="acc-th acc-th-r">Värde</span>
            <span class="acc-th acc-th-r">Actions</span>
          </div>
          ${(() => {
      // Pre-compute per-account cost basis for the value column.
      // We use current portfolio snapshot (if available) to estimate market value,
      // falling back to invested cost basis if no live prices are loaded.
      const snap = S.portfolioSnap;
      const ACCT_ACQUIS = new Set(['buy','receive','transfer_in','income','staking','airdrop','bridge_in']);
      const totalInvested = txns.reduce((s, t) => s + (ACCT_ACQUIS.has(t.category) ? (t.costBasisSEK || 0) : 0), 0);
      const totalSnapValue = snap ? (snap.totalValueSEK || null) : null;
      return accounts.map(acc => {
        const st = TaxEngine.getImportStatus(acc.id);
        const cnt = txns.filter(t => t.accountId === acc.id).length;
        const accInvested = txns.filter(t => t.accountId === acc.id && ACCT_ACQUIS.has(t.category))
          .reduce((s, t) => s + (t.costBasisSEK || 0), 0);
        // Estimate current value = share of portfolio × total snap value
        const accValueEst = totalSnapValue !== null && totalInvested > 0
          ? Math.round((accInvested / totalInvested) * totalSnapValue)
          : null;
        const valueDisplay = accValueEst !== null
          ? `<div class="tax-mono" style="font-size:12px">${TaxEngine.formatSEK(accValueEst)}</div>
             <div style="font-size:10px;color:var(--tax-muted)">~est.</div>`
          : `<div class="tax-mono" style="font-size:12px;color:var(--tax-muted)">${TaxEngine.formatSEK(accInvested)}</div>
             <div style="font-size:10px;color:var(--tax-muted)">investerat</div>`;
        const src = ACC_SOURCES.find(s => s.type === acc.type) || { icon: '📂', name: acc.type, color: '#64748b' };
        const stMap = { synced: ['✅', 'Synced'], syncing: ['⏳', 'Syncing…'], partial_sync: ['⚠️', 'Partial'], failed: ['❌', 'Failed'], never_synced: ['—', 'Not synced'] };
        const [stIcon] = stMap[st.status] || stMap.never_synced;
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
                  <div class="acc-row-tx tax-mono">${cnt.toLocaleString()}${st.filteredFailed > 0 ? `<span title="${st.filteredFailed} failed/non-economic transactions skipped at import" style="color:#f59e0b;font-size:10px;margin-left:4px">✗${st.filteredFailed}</span>` : ''}</div>
                  <div class="acc-row-tx" style="text-align:right">${valueDisplay}</div>
                  <div class="acc-row-actions">
                    ${acc.type === 'solana_bc' || acc.type === 'phantom' || acc.type === 'solflare'
                        ? `<button class="tax-btn tax-btn-xs tax-btn-ghost" style="color:#9945FF"
                             onclick="TaxUI.reprocessAndSaveSolana('${acc.id}')"
                             title="Rekonstruera Solana-swappar för detta konto">◎ Fix</button>`
                        : ''}
                    <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.resyncAccount('${acc.id}')" title="Re-import all transactions">🔄</button>
                    <button class="tax-btn tax-btn-xs tax-btn-ghost" style="color:#f87171" onclick="TaxUI.removeAccount('${acc.id}')">✕</button>
                  </div>
                </div>`;
      }).join('');
    })()}
        </div>` : `
        <div class="acc-empty-state">
          <div class="acc-empty-icon">🔗</div>
          <div class="acc-empty-title">No accounts connected yet</div>
          <div class="acc-empty-sub">Click <strong>+ Add account</strong> to import wallets and exchanges.</div>
          ${hasOrphans ? `
          <div style="margin-top:20px;padding:14px 18px;border-radius:10px;border:1px solid #f59e0b66;background:rgba(245,158,11,0.08);max-width:420px;text-align:left">
            <div style="font-size:13px;font-weight:700;color:#fbbf24;margin-bottom:6px">
              🧹 ${orphanedCount.toLocaleString()} kvarvarande transaktioner
            </div>
            <div style="font-size:12px;color:#94a3b8;margin-bottom:10px;line-height:1.5">
              Du har ${orphanedCount.toLocaleString()} transaktioner från konton du tagit bort.
              De syns fortfarande i skatterapporten. Klicka nedan för att rensa dem.
            </div>
            <button class="tax-btn tax-btn-sm" style="background:#f59e0b;color:#000;font-weight:700;width:100%"
              onclick="TaxUI.deleteOrphanedTransactions()">
              🗑 Ta bort alla ${orphanedCount.toLocaleString()} transaktioner
            </button>
          </div>` : ''}
          <button class="acc-add-btn" style="margin-top:16px" onclick="TaxUI.openAddAccountModal()">＋ Add account</button>
        </div>`}

        <!-- ── Data maintenance section ─────────────────────── -->
        ${txnCount > 0 ? `
        <div class="tax-section" style="margin-top:24px">
          <div class="tax-section-header" style="margin-bottom:10px">
            <h2 style="font-size:13px;color:var(--tax-muted)">🛠 Dataunderhåll</h2>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">

            <!-- Corruption cleanup card -->
            <div style="padding:12px 14px;background:${hasCorruptData ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,.02)'};border:1px solid ${hasCorruptData ? 'rgba(245,158,11,0.35)' : 'var(--tax-border)'};border-radius:8px">
              <div style="font-size:12px;font-weight:600;color:${hasCorruptData ? '#fbbf24' : 'var(--tax-muted)'};margin-bottom:4px">
                ${hasCorruptData ? `⚠ ${cleanupStats.affected} korrupta poster` : '✅ Databasen är ren'}
              </div>
              <div style="font-size:11px;color:var(--tax-muted);margin-bottom:8px;line-height:1.5">
                ${hasCorruptData
                  ? 'Felaktiga belopp/priser från gamla Solana-importer. Kan inflatera K4-siffror.'
                  : 'Inga korrupta belopp eller prisartefakter hittades i databasen.'}
              </div>
              <button class="tax-btn tax-btn-xs ${hasCorruptData ? '' : 'tax-btn-ghost'}"
                style="${hasCorruptData ? 'background:#f59e0b;color:#000;font-weight:700' : ''}"
                onclick="TaxUI.runDataCleanup()">
                ${hasCorruptData ? '🛠 Kör datarensning' : '🔍 Kör kontroll'}
              </button>
            </div>

            <!-- Swap reconstruction card -->
            <div style="padding:12px 14px;background:${hasStaleSolana ? 'rgba(99,102,241,0.07)' : 'rgba(255,255,255,.02)'};border:1px solid ${hasStaleSolana ? 'rgba(99,102,241,0.3)' : 'var(--tax-border)'};border-radius:8px">
              <div style="font-size:12px;font-weight:600;color:${hasStaleSolana ? '#818cf8' : 'var(--tax-muted)'};margin-bottom:4px">
                ${hasStaleSolana ? `◎ ${splitHashCount} swappar behöver rekonstrueras` : '✅ Solana-swappar OK'}
              </div>
              <div style="font-size:11px;color:var(--tax-muted);margin-bottom:8px;line-height:1.5">
                ${hasStaleSolana
                  ? 'Gamla TRADE-händelser är uppdelade som separata transfers. Ger fel kostnadsbas.'
                  : 'Alla Solana-swappar är korrekt rekonstruerade som TRADE-händelser.'}
              </div>
              ${hasStaleSolana ? `
              <button class="tax-btn tax-btn-xs" style="background:#6366f1;color:#fff"
                onclick="TaxUI.reprocessAndSaveSolana()">
                ◎ Rekonstruera swappar
              </button>` : ''}
            </div>

            <!-- Phantom purge card -->
            <div style="padding:12px 14px;background:${hasPhantomSolana ? 'rgba(239,68,68,0.06)' : 'rgba(255,255,255,.02)'};border:1px solid ${hasPhantomSolana ? 'rgba(239,68,68,0.3)' : 'var(--tax-border)'};border-radius:8px">
              <div style="font-size:12px;font-weight:600;color:${hasPhantomSolana ? '#f87171' : 'var(--tax-muted)'};margin-bottom:4px">
                ${hasPhantomSolana ? `🚨 ${phantomSolTxns.length} phantom-transaktioner` : '✅ Inga phantom-transaktioner'}
              </div>
              <div style="font-size:11px;color:var(--tax-muted);margin-bottom:8px;line-height:1.5">
                ${hasPhantomSolana
                  ? 'Misslyckade DEX-swappar importerade som riktiga — skapar felaktiga siffror.'
                  : 'Inga misslyckade/phantom Solana-transaktioner hittades.'}
              </div>
              ${hasPhantomSolana ? `
              <button class="tax-btn tax-btn-xs" style="background:#ef4444;color:#fff"
                onclick="TaxUI.purgeAndResync()">
                🧹 Rensa phantoms
              </button>` : ''}
            </div>

          </div>
        </div>` : ''}

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
        '📊 Trading Account Statement (rekommenderas):',
        '1. Öppna Revolut → Wealth → Crypto',
        '2. Tryck ⋮ → Statements → Trading account statement',
        '3. Välj hela skatteåret → Export CSV',
        '— eller —',
        '📄 Kontoutdrag (standardexport):',
        '1. Öppna Revolut-appen → Account → Statement',
        '2. Välj "CSV" → välj hela perioden → Export',
      ], warning: 'Båda formaten stöds. Trading Account Statement ger bäst skattedata med köp + sälj per lot.'
    },
    mexc: {
      icon: '🟩', name: 'MEXC', steps: [
        '1. Logga in på MEXC', '2. Gå till Orders → Order History',
        '3. Klicka "Export" → välj All time', '4. Ladda ned CSV och ladda upp nedan',
      ], warning: null
    },
    solscan: {
      icon: '◎', name: 'Solscan', steps: [
        '1. Öppna Solscan.io och sök din Solana-adress',
        '2. Gå till DeFi Activities eller Token Transfers',
        '3. Klicka "Export" knappen (CSV)',
        '4. Ladda ned och ladda upp filen nedan',
      ], warning: 'Solscan CSV innehåller bara en rad per swap-ben. Pararen rekonstruerar automatiskt hela swappen. För bästa resultat, importera Solana-plånbok via Helius API istället.'
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
    trade_exact:            { label: 'Exchange',       dot: '#22c55e' },
    market_api_coingecko:   { label: 'CoinGecko',      dot: '#22c55e' },
    market_api_dex:         { label: 'DEX (GT)',        dot: '#34d399' },  // GeckoTerminal
    swap_implied:           { label: 'Swap derived',   dot: '#a78bfa' },
    pair_derived:           { label: 'Derived',        dot: '#a78bfa' },
    stable_historical_fx:   { label: 'FX',             dot: '#34d399' },
    stable_approx:          { label: 'Approx',         dot: '#fbbf24' },
    manual:                 { label: 'Manual',         dot: '#60a5fa' },
    back_derived:           { label: 'Back-derived',   dot: '#a78bfa' },
    missing:                { label: 'Missing',        dot: '#f87171' },
    outlier_suspect:        { label: '⚠ Misstänkt',   dot: '#ef4444' },  // corrupt import artifact
  };

  function renderTxRow(t) {
    const cm       = CAT_META[t.category] || { icon: '•', color: '#94a3b8', label: t.category };
    const isInternal = t.isInternalTransfer;
    const checked  = S.selectedTxIds.has(t.id);
    const expanded = S.expandedTxId === t.id;
    const accounts = TaxEngine.getAccounts();
    const acc      = accounts.find(a => a.id === t.accountId);
    const accLabel = acc?.label || acc?.type || '—';

    // Resolve display symbol + metadata (icon, full name)
    const td = TaxEngine.resolveTokenDisplay ? TaxEngine.resolveTokenDisplay(t.assetSymbol) : { symbol: t.assetSymbol, name: '' };
    const displaySym = td.symbol || t.assetSymbol || '—';
    const metaEntry  = TaxEngine.getTokenMeta ? TaxEngine.getTokenMeta(t.contractAddress || t.assetSymbol) : null;
    const tokenImageUrl = t.imageUrl || metaEntry?.imageUrl || null;

    // Sent / Received columns — derived from category + amounts
    const isOutgoing = ['sell','send','transfer_out','fee'].includes(t.category);
    const isSwap     = t.category === 'trade';
    let sentCell = '—', recvCell = '—';
    const fmtAmt = (sym, amt, imgUrl, mint) =>
      `<span class="tx-asset-amt">${TaxEngine.formatCrypto(amt, 6)}</span> ${renderTokenBadge(sym, null, imgUrl, mint, 'sm')}`;
    if (isSwap) {
      sentCell = fmtAmt(displaySym, t.amount, tokenImageUrl, t.contractAddress);
      const inMeta = TaxEngine.getTokenMeta ? TaxEngine.getTokenMeta(t.inAsset) : null;
      recvCell = t.inAsset ? fmtAmt(t.inAsset, t.inAmount || 0, inMeta?.imageUrl || null, t.inAsset?.length > 20 ? t.inAsset : null) : '—';
    } else if (isOutgoing) {
      sentCell = fmtAmt(displaySym, t.amount, tokenImageUrl, t.contractAddress);
    } else {
      recvCell = fmtAmt(displaySym, t.amount, tokenImageUrl, t.contractAddress);
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

  // ── Block explorer links helper ─────────────────────────────
  // Returns HTML for clickable explorer badge(s) for a transaction/token.
  // source: 'solana_wallet' | 'eth_wallet' | …
  // txHash: raw transaction signature / hash
  // tokenMint: optional — full Solana mint address or EVM contract address
  function explorerLinks(source, txHash, tokenMint) {
    if (!txHash || txHash.startsWith('manual_')) return '';
    const cfg = TaxEngine.CHAIN_EXPLORERS && TaxEngine.CHAIN_EXPLORERS[source];
    if (!cfg) return '';
    const txUrl = cfg.tx(txHash);
    let html = `<a href="${txUrl}" target="_blank" rel="noopener noreferrer"
      class="tax-explorer-link" title="View transaction on ${cfg.name}">${cfg.name} ↗</a>`;
    // Solana: add secondary explorers (SolanaFM, Xray)
    if (source === 'solana_wallet' && TaxEngine.SOL_SECONDARY_EXPLORERS) {
      for (const sec of TaxEngine.SOL_SECONDARY_EXPLORERS) {
        html += `<a href="${sec.tx(txHash)}" target="_blank" rel="noopener noreferrer"
          class="tax-explorer-link tax-explorer-link--secondary"
          title="View on ${sec.name}">${sec.name} ↗</a>`;
      }
    }
    // Token link (if mint/contract provided)
    if (tokenMint) {
      html += `<a href="${cfg.token(tokenMint)}" target="_blank" rel="noopener noreferrer"
        class="tax-explorer-link tax-explorer-link--token"
        title="View token on ${cfg.name}">Token ↗</a>`;
    }
    return `<span class="tax-explorer-links">${html}</span>`;
  }

  // Returns a single small ↗ icon link (for compact spaces like review rows).
  // Render a token identity badge: icon (if available) + symbol + optional full name.
  // For unresolved mints, shows shortened mint + Solscan link.
  // size: 'sm' (16px, inline) | 'md' (20px, with name)
  function renderTokenBadge(sym, name, imageUrl, mint, size = 'sm') {
    const iconSize = size === 'md' ? 20 : 16;
    const showName = size === 'md' && name && name !== sym;
    const solscanUrl = mint && mint.length > 20
      ? `https://solscan.io/token/${mint}` : null;
    const isUnresolved = sym && sym.length === 8 && mint && mint.startsWith(sym);

    // Icon: prefer DAS imageUrl, fallback CoinCap for well-known symbols
    let iconHtml = '';
    if (imageUrl) {
      iconHtml = `<img src="${imageUrl}" width="${iconSize}" height="${iconSize}"
        style="border-radius:50%;flex-shrink:0;object-fit:cover"
        onerror="this.style.display='none'">`;
    } else {
      const coincapSrc = `https://assets.coincap.io/assets/icons/${(sym||'').toLowerCase()}@2x.png`;
      iconHtml = `<img src="${coincapSrc}" width="${iconSize}" height="${iconSize}"
        style="border-radius:50%;flex-shrink:0;object-fit:cover"
        onerror="this.style.display='none'">`;
    }

    if (isUnresolved) {
      // Unknown token: show 8-char prefix + Solscan link
      return `<span style="display:inline-flex;align-items:center;gap:3px">
        ${iconHtml}
        <span style="font-family:monospace;font-size:11px;color:#64748b" title="${mint||sym}">${sym}</span>
        ${solscanUrl ? `<a href="${solscanUrl}" target="_blank" rel="noopener"
          style="font-size:10px;color:#6366f1;text-decoration:none" title="View on Solscan">↗</a>` : ''}
      </span>`;
    }

    return `<span style="display:inline-flex;align-items:center;gap:3px">
      ${iconHtml}
      <span style="font-weight:600;font-size:${size === 'md' ? 13 : 11}px">${sym}</span>
      ${showName ? `<span style="font-size:11px;color:#64748b;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${name}">${name}</span>` : ''}
      ${solscanUrl ? `<a href="${solscanUrl}" target="_blank" rel="noopener"
        style="font-size:10px;color:#6366f1;text-decoration:none" title="View on Solscan">↗</a>` : ''}
    </span>`;
  }

  function explorerIconLink(source, txHash) {
    if (!txHash || txHash.startsWith('manual_')) return '';
    const cfg = TaxEngine.CHAIN_EXPLORERS && TaxEngine.CHAIN_EXPLORERS[source];
    if (!cfg) return '';
    return `<a href="${cfg.tx(txHash)}" target="_blank" rel="noopener noreferrer"
      class="tax-explorer-icon" title="View on ${cfg.name}">↗</a>`;
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
        ${t.txHash ? `<div class="tx-expand-kv" style="grid-column:1/-1">
          <span class="tx-expand-k">TxHash</span>
          <span class="tx-expand-v" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px">
            <span class="tax-mono" style="font-size:10px;word-break:break-all;flex:1;min-width:0">${t.txHash}</span>
            ${explorerLinks(t.source, t.txHash)}
          </span>
        </div>` : ''}
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
              ${t._reconstruction ? `<button class="tx-expand-tab ${tab === 'reconstruction' ? 'active' : ''}"
                onclick="event.stopPropagation();TaxUI.setExpandedTab('reconstruction')" style="color:#818cf8">
                ◎ REKONSTRUKTION
              </button>` : ''}
            </div>
            <div class="tx-expand-body">
              ${tab === 'description' ? descTab
              : tab === 'reconstruction' && t._reconstruction ? (() => {
                  const r = t._reconstruction;
                  const rows = [
                    r.dex                          && ['DEX / Protokoll', r.dex],
                    t.solanaSwapType               && ['Swap-typ', t.solanaSwapType.replace(/_/g,' ')],
                    ['Gav', `${TaxEngine.formatCrypto(t.amount,6)} ${t.assetSymbol}`],
                    t.inAsset                      && ['Fick', `${TaxEngine.formatCrypto(t.inAmount,6)} ${t.inAsset}`],
                    t.feeSEK != null               && ['Nätverksavgift', `${t.feeSEK.toFixed(4)} SEK (SOL)`],
                    r.routeHopsIgnored > 0         && ['Routningshoppar ignorerade', `${r.routeHopsIgnored} st`],
                    r.wsolCollapsed                && ['WSOL-normalisering', 'Wrapped SOL kollapsat till SOL ✓'],
                    r.ownedAccountCount            && ['Konton som analyserats', `${r.ownedAccountCount} st (plånbok + ATA:s)`],
                    ['Datakälla', r.usedAccountData ? 'accountData (netto-deltas)' : 'nativeTransfers (fallback)'],
                  ].filter(Boolean);
                  return `<div class="tx-expand-grid">
                    ${rows.map(([k,v])=>`<div class="tx-expand-kv"><span class="tx-expand-k">${k}</span><span class="tx-expand-v tax-mono" style="font-size:12px">${v}</span></div>`).join('')}
                    ${Object.keys(r.tokenNet||{}).length > 0 ? `<div class="tx-expand-kv" style="grid-column:1/-1">
                      <span class="tx-expand-k">Netto token-deltas</span>
                      <span class="tx-expand-v tax-mono" style="font-size:11px">${Object.entries(r.tokenNet).map(([s,v])=>`${v>0?'+':''}${v.toFixed(6)} ${s}`).join(' · ')}</span>
                    </div>` : ''}
                    <div class="tx-expand-kv" style="grid-column:1/-1">
                      <span class="tx-expand-k" style="color:#64748b;font-size:10px">Vad detta innebär</span>
                      <span class="tx-expand-v" style="font-size:11px;color:#94a3b8">
                        Alla token-rörelser för denna transaktion summerades per tillgång för alla plånbokskonton.
                        Routing-hoppar och WSOL-wrapps filtrerades bort. Det slutgiltiga netto-resultatet
                        klassificerades som ett enda ${t.category === 'trade' ? 'byte' : t.category}.
                      </span>
                    </div>
                  </div>`;
                })()
              : taxTab}
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
    const { txn, suggestedAction, reason, resolutionType } = issue;
    if (reason === 'received_not_sold') {
      return `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.markReviewed('${txn.id}')" title="Ignore — this token was never sold, no K4 impact">Ignorera</button>`;
    }
    // Classify-first ordering: classification actions are primary, price entry is last resort
    if (resolutionType === 'spam_candidate' || suggestedAction === 'mark_spam') {
      return `<span style="display:inline-flex;gap:4px;flex-wrap:wrap">
        <button class="tax-btn tax-btn-xs" style="background:rgba(74,222,128,.12);color:#4ade80;border:1px solid rgba(74,222,128,.25);font-weight:600" onclick="TaxUI.markSpam('${txn.id}')" title="Spam/värdelös token — nollvärde">🗑 Spam</button>
        <button class="tax-btn tax-btn-xs tax-btn-ghost" style="font-size:10px;opacity:.6" onclick="TaxUI.editTx('${txn.id}')" title="Ange pris manuellt">💰</button>
      </span>`;
    }
    if (resolutionType === 'internal_transfer_candidate') {
      return `<span style="display:inline-flex;gap:4px;flex-wrap:wrap">
        <button class="tax-btn tax-btn-xs" style="background:rgba(96,165,250,.12);color:#60a5fa;border:1px solid rgba(96,165,250,.25);font-weight:600" onclick="TaxUI.openAddAccountModal()" title="Importera källplånbok">↔ Transfer</button>
        <button class="tax-btn tax-btn-xs tax-btn-ghost" style="font-size:10px;opacity:.6" onclick="TaxUI.editTx('${txn.id}')" title="Ange pris manuellt">💰</button>
      </span>`;
    }
    if (resolutionType === 'airdrop_candidate') {
      return `<span style="display:inline-flex;gap:4px;flex-wrap:wrap">
        <button class="tax-btn tax-btn-xs" style="background:rgba(129,140,248,.12);color:#818cf8;border:1px solid rgba(129,140,248,.25);font-weight:600" onclick="TaxUI.bulkClassifySelected('airdrop')" title="Klassificera som airdrop">🪂 Airdrop</button>
        <button class="tax-btn tax-btn-xs tax-btn-ghost" style="font-size:10px;opacity:.6" onclick="TaxUI.editTx('${txn.id}')" title="Ange pris manuellt">💰</button>
      </span>`;
    }
    if (resolutionType === 'opening_balance_candidate') {
      return `<span style="display:inline-flex;gap:4px;flex-wrap:wrap">
        <button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.25);font-weight:600" onclick="TaxUI.editTx('${txn.id}')" title="Skapa öppningssaldo">📅 Öppningssaldo</button>
      </span>`;
    }
    switch (suggestedAction) {
      case 'rerun_pipeline':
        return `<button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.2)" onclick="TaxUI.triggerPipeline()" title="Har prissatt swap-partner — kör om pipeline">Kör pipeline</button>`;
      case 'batch_price_lookup':
        return `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.bulkShowPriceSearch('missing_sek_price')" title="Känd token — hämta historiskt pris från API">Hämta pris</button>`;
      case 'enter_price':
      default:
        return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.editTx('${txn.id}')" title="Ange SEK-pris manuellt" style="opacity:.8">💰 Ange pris</button>`;
    }
  }

  // ── Render a single review row ────────────────────────────────
  // ── Render inline "How we reconstructed this trade" panel ─────
  function renderReconPanel(txn) {
    const r = txn._reconstruction;
    if (!r) return '';
    const panelId = `recon_${txn.id}`;
    const rows = [];
    if (r.dex)                rows.push(['DEX', r.dex]);
    if (txn.solanaSwapType)   rows.push(['Type', txn.solanaSwapType.replace(/_/g, ' ')]);
    if (txn.assetSymbol)      rows.push(['Gave', `${TaxEngine.formatCrypto(txn.amount, 6)} ${txn.assetSymbol}`]);
    if (txn.inAsset)          rows.push(['Got',  `${TaxEngine.formatCrypto(txn.inAmount, 6)} ${txn.inAsset}`]);
    if (txn.feeSEK != null)   rows.push(['Fee',  `${txn.feeSEK.toFixed(4)} SEK (SOL network)`]);
    if (r.routeHopsIgnored > 0) rows.push(['Ignored', `${r.routeHopsIgnored} routing hop(s)`]);
    if (r.wsolCollapsed)        rows.push(['WSOL', 'Collapsed to SOL ✓']);
    rows.push(['Source', r.usedAccountData ? 'accountData (net deltas)' : 'nativeTransfers fallback']);
    const tableHtml = rows.map(([k, v]) =>
      `<tr><td style="color:#64748b;padding:1px 8px 1px 0;font-size:11px;white-space:nowrap">${k}</td><td style="color:#cbd5e1;font-size:11px">${v}</td></tr>`
    ).join('');
    return `
      <div id="${panelId}" style="display:none;margin-top:6px;padding:8px 10px;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.15);border-radius:6px">
        <div style="font-size:10px;font-weight:600;color:#818cf8;margin-bottom:4px;letter-spacing:.5px">◎ HOW WE RECONSTRUCTED THIS TRADE</div>
        <table style="border-collapse:collapse">${tableHtml}</table>
      </div>`;
  }

  // ── Enhanced row for unknown_acquisition with impact labels and guided resolver ──
  function renderAcquisitionRow(issue) {
    const { txn, resolutionType, resolutionConfidence, resolutionNote, impactLevel, autoResolvable, proceedsSEK } = issue;
    const td = TaxEngine.resolveTokenDisplay ? TaxEngine.resolveTokenDisplay(txn.assetSymbol) : { symbol: txn.assetSymbol, name: '' };
    const displaySym  = td.symbol || txn.assetSymbol || '?';
    const displayName = td.name || txn.assetName || '';
    const acct        = TaxEngine.getAccounts().find(a => a.id === txn.accountId);
    const acctLabel   = acct ? (acct.label || acct.type || acct.id.slice(-6)) : '?';
    const metaEntry   = TaxEngine.getTokenMeta ? TaxEngine.getTokenMeta(txn.contractAddress || txn.assetSymbol) : null;
    const tokenImage  = txn.imageUrl || metaEntry?.imageUrl || null;
    const richName    = metaEntry?.name || displayName;

    // Impact badge
    const IMPACT = {
      high:   { label: '🔴 Hög påverkan',  color: '#f87171', bg: 'rgba(239,68,68,.12)', tip: `${Math.round(proceedsSEK || 0)} kr — påverkar skatten merkbart` },
      medium: { label: '🟡 Medel',          color: '#fbbf24', bg: 'rgba(251,191,36,.1)',  tip: `${Math.round(proceedsSEK || 0)} kr` },
      low:    { label: '🟢 Låg påverkan',   color: '#4ade80', bg: 'rgba(34,197,94,.08)',  tip: `${Math.round(proceedsSEK || 0)} kr — liten skatteeffekt` },
    };
    const impact = IMPACT[impactLevel] || IMPACT.low;

    // Best-guess badge
    const GUESS = {
      spam_candidate:              { badge: '🗑️ Troligen spam',             color: '#4ade80' },
      airdrop_candidate:           { badge: '🪂 Troligen airdrop',          color: '#818cf8' },
      internal_transfer_candidate: { badge: '↔️ Troligen intern transfer',   color: '#60a5fa' },
      opening_balance_candidate:   { badge: '📅 Troligen öppningssaldo',    color: '#fbbf24' },
      manual_review_required:      { badge: '🔍 Okänd källa',              color: '#f87171' },
    };
    const guess = GUESS[resolutionType] || GUESS.manual_review_required;

    // Confidence
    const CONF = { high: { l: 'hög', c: '#4ade80' }, medium: { l: 'medel', c: '#fbbf24' }, low: { l: 'låg', c: '#f87171' } };
    const conf = CONF[resolutionConfidence] || CONF.low;

    const guidedId = `guided_${txn.id}`;

    const isSelectedAcq = S.reviewSelectedIds.has(txn.id);
    return `
    <div class="tax-review-item" style="flex-direction:column;align-items:stretch;${isSelectedAcq ? 'background:rgba(99,102,241,.06);border-left:2px solid #818cf8;' : ''}">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <label style="flex-shrink:0;cursor:pointer;padding:0 6px 0 4px;align-self:flex-start;padding-top:2px">
          <input type="checkbox" ${isSelectedAcq ? 'checked' : ''}
            onchange="TaxUI.toggleSelectReview('${txn.id}',this.checked)"
            style="width:14px;height:14px;accent-color:#818cf8;cursor:pointer">
        </label>
        <div class="tax-ri-left" style="flex:1;min-width:0">
          ${renderTokenBadge(displaySym, richName !== displaySym ? richName : null, tokenImage, txn.contractAddress, 'sm')}
          <span class="tax-mono" style="font-size:12px">${TaxEngine.formatCrypto(txn.amount, 6)}</span>
          <span class="tax-muted" style="font-size:11px">${fmtDateShort(txn.date)}</span>
          ${explorerIconLink(txn.source, txn.txHash)}
          <span class="tax-badge" style="font-size:10px;opacity:.6">${acctLabel}</span>
          <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:${impact.bg};color:${impact.color}" title="${impact.tip}">${impact.label}</span>
          <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(15,23,42,.6);color:${guess.color}">${guess.badge}</span>
          <span style="font-size:9px;color:${conf.c}">${conf.l} konf.</span>
          ${autoResolvable ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(99,102,241,.12);color:#818cf8">✨ auto</span>' : ''}
        </div>
        <div class="tax-ri-right" style="display:flex;gap:4px">
          <button class="tax-btn tax-btn-xs" style="color:#818cf8;font-size:10px"
                  onclick="(function(){var p=document.getElementById('${guidedId}');if(p)p.style.display=p.style.display==='none'?'flex':'none'})()">🧭 Lös</button>
          <button class="tax-btn tax-btn-xs" style="color:#94a3b8" onclick="TaxUI.editTx('${txn.id}')" title="Redigera">✏️</button>
          <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.markReviewed('${txn.id}')">OK</button>
        </div>
      </div>
      ${resolutionNote ? `<div style="margin-top:4px;font-size:11px;color:#64748b;line-height:1.5;padding:4px 8px;background:rgba(0,0,0,.15);border-radius:5px">${resolutionNote}</div>` : ''}
      <div id="${guidedId}" style="display:none;margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(99,102,241,.04);border:1px solid rgba(99,102,241,.12);flex-direction:column;gap:6px">
        <div style="font-size:11px;font-weight:600;color:#818cf8;margin-bottom:2px">Var kom denna tillgång ifrån?</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="tax-btn tax-btn-xs" style="background:rgba(96,165,250,.1);color:#60a5fa;border:1px solid rgba(96,165,250,.2)"
                  onclick="TaxUI.openAddAccountModal()">↔️ Annan plånbok jag äger</button>
          <button class="tax-btn tax-btn-xs" style="background:rgba(96,165,250,.1);color:#60a5fa;border:1px solid rgba(96,165,250,.2)"
                  onclick="TaxUI.navigate('import')">🏦 Köptes på en börs</button>
          <button class="tax-btn tax-btn-xs" style="background:rgba(129,140,248,.1);color:#818cf8;border:1px solid rgba(129,140,248,.2)"
                  onclick="TaxUI.markSpam('${txn.id}')">🪂 Airdrop / spam</button>
          <button class="tax-btn tax-btn-xs" style="background:rgba(148,163,184,.08);color:#94a3b8;border:1px solid rgba(148,163,184,.15)"
                  onclick="TaxUI.editTx('${txn.id}')">❓ Osäker — visa mer</button>
        </div>
      </div>
    </div>`;
  }

  function renderReviewRow(issue) {
    const { txn, isK4Blocker: itemK4 } = issue;
    const td = TaxEngine.resolveTokenDisplay ? TaxEngine.resolveTokenDisplay(txn.assetSymbol) : { symbol: txn.assetSymbol, name: '' };
    const displaySym  = td.symbol || txn.assetSymbol || '?';
    const displayName = td.name || txn.assetName || '';
    const acct        = TaxEngine.getAccounts().find(a => a.id === txn.accountId);
    const acctLabel   = acct ? (acct.label || acct.type || acct.id.slice(-6)) : 'Unknown wallet';
    const blockInfo   = issue.priceBlockReason ? BLOCK_REASON_LABELS[issue.priceBlockReason] : null;
    const hasRecon    = !!(txn._reconstruction);
    const panelId     = `recon_${txn.id}`;

    // ── Token identity block ────────────────────────────────────────────────
    // Shown for missing_price, outlier, AND unknown_asset (meme coin swaps).
    const needsTokenInfo = issue.reason === 'missing_sek_price'
      || issue.reason === 'outlier'
      || issue.reason === 'unknown_asset';
    const mintAddr   = txn.contractAddress || null;
    // Pull rich metadata (imageUrl, full name) from Helius DAS store
    const metaEntry  = TaxEngine.getTokenMeta ? TaxEngine.getTokenMeta(mintAddr || txn.assetSymbol) : null;
    const tokenImage = txn.imageUrl || metaEntry?.imageUrl || null;
    const richName   = metaEntry?.name || displayName;
    const cfgE       = TaxEngine.CHAIN_EXPLORERS && TaxEngine.CHAIN_EXPLORERS[txn.source];
    const tokenPageUrl = cfgE && mintAddr ? cfgE.token(mintAddr) : null;
    const geckoUrl   = `https://www.coingecko.com/en/coins/${displaySym.toLowerCase()}`;
    const metaSrc    = metaEntry?.metadataSource || null;
    const metaSrcLabel = metaSrc === 'helius_das' ? '· Helius DAS ✓'
      : metaSrc === 'pumpfun' ? '· pump.fun'
      : metaSrc === 'dexscreener' ? '· DexScreener'
      : '';

    const tokenInfoHtml = needsTokenInfo ? `
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)">
        ${tokenImage
          ? `<img src="${tokenImage}" style="width:20px;height:20px;border-radius:50%;flex-shrink:0;object-fit:cover" onerror="this.style.display='none'">`
          : `<img src="https://assets.coincap.io/assets/icons/${displaySym.toLowerCase()}@2x.png" style="width:20px;height:20px;border-radius:50%;flex-shrink:0" onerror="this.style.display='none'">`}
        <div style="flex:1;min-width:0">
          <span style="font-size:12px;font-weight:600;color:#e2e8f0">${displaySym}</span>
          ${richName && richName !== displaySym ? `<span style="font-size:11px;color:#94a3b8;margin-left:4px">${richName}</span>` : ''}
          ${mintAddr ? `<span class="tax-mono" style="font-size:10px;color:#475569;margin-left:6px" title="${mintAddr}">${mintAddr.slice(0,8)}…${mintAddr.slice(-5)}</span>` : ''}
          ${metaSrcLabel ? `<span style="font-size:10px;color:#475569;margin-left:4px">${metaSrcLabel}</span>` : ''}
        </div>
        ${tokenPageUrl ? `<a href="${tokenPageUrl}" target="_blank" rel="noopener" class="tax-explorer-link" style="font-size:10px;white-space:nowrap">Solscan ↗</a>` : ''}
        <a href="${geckoUrl}" target="_blank" rel="noopener" class="tax-explorer-link tax-explorer-link--secondary" style="font-size:10px;white-space:nowrap">CoinGecko ↗</a>
      </div>` : '';

    const isSelected = S.reviewSelectedIds.has(txn.id);
    return `
    <div class="tax-review-item" style="flex-direction:column;align-items:stretch;${isSelected ? 'background:rgba(99,102,241,.06);border-left:2px solid #818cf8;' : ''}">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <label style="flex-shrink:0;cursor:pointer;padding:0 6px 0 4px;align-self:flex-start;padding-top:2px">
          <input type="checkbox" ${isSelected ? 'checked' : ''}
            onchange="TaxUI.toggleSelectReview('${txn.id}',this.checked)"
            style="width:14px;height:14px;accent-color:#818cf8;cursor:pointer">
        </label>
        <div class="tax-ri-left" style="flex:1;min-width:0">
          <span class="tax-asset-sym" title="${txn.assetSymbol || ''}">${renderTokenBadge(displaySym, richName !== displaySym ? richName : null, tokenImage, mintAddr, 'sm')}</span>
          <span class="tax-mono" style="font-size:12px">${TaxEngine.formatCrypto(txn.amount, 6)}</span>
          <span class="tax-muted" style="font-size:11px">${fmtDateShort(txn.date)}</span>
          ${explorerIconLink(txn.source, txn.txHash)}
          ${txn.category ? `<span class="tax-badge" style="font-size:10px">${txn.category}</span>` : ''}
          <span class="tax-badge" style="font-size:10px;opacity:.6">${acctLabel}</span>
          ${itemK4 ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.12);color:#f87171;font-weight:600">K4</span>` : ''}
          ${txn.isDuplicate ? `<span class="tax-badge" style="background:rgba(239,68,68,.1);color:#f87171;font-size:10px">DUP</span>` : ''}
          ${confidenceBadge(txn)}
          ${blockInfo ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(148,163,184,.08);color:#64748b;border:1px solid rgba(148,163,184,.15)" title="${blockInfo.tip}">${blockInfo.label}</span>` : ''}
          ${txn.priceStatus === 'resolved_stable_fx' ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(52,211,153,.08);color:#34d399;border:1px solid rgba(52,211,153,.18)" title="Pris löst automatiskt via stablecoin-peg + historisk USD/SEK">🪙 stablecoin-peg</span>` : ''}
          ${txn.priceStatus === 'resolved_stable_approx' ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(251,191,36,.08);color:#fbbf24;border:1px solid rgba(251,191,36,.18)" title="Pris löst via ungefärlig kurs — historisk FX ej tillgänglig">🪙 stablecoin (approx)</span>` : ''}
          ${txn.depegWarning ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(239,68,68,.1);color:#f87171;border:1px solid rgba(239,68,68,.2)" title="Marknadsdata tyder på avvikelse från 1:1-peggen vid detta datum">⚠️ depeg?</span>` : ''}
          ${hasRecon ? `<button class="tax-btn tax-btn-xs" style="color:#818cf8;font-size:10px;padding:1px 6px" onclick="(function(){var p=document.getElementById('${panelId}');if(p)p.style.display=p.style.display==='none'?'block':'none'})()">◎ rekonstruktion</button>` : ''}
        </div>
        <div class="tax-ri-right">
          ${suggestedActionBtn(issue)}
          <button class="tax-btn tax-btn-xs" style="color:#94a3b8" onclick="TaxUI.editTx('${txn.id}')" title="Edit transaction">✏️</button>
          <button class="tax-btn tax-btn-xs" style="color:#64748b" onclick="TaxUI.markSpam('${txn.id}')" title="Mark as spam (zero value)">🚫</button>
          <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.markReviewed('${txn.id}')" title="Dismiss">OK</button>
        </div>
      </div>
      ${tokenInfoHtml}
      ${renderReconPanel(txn)}
    </div>`;
  }

  // REVIEW PAGE — exceptions only
  // ════════════════════════════════════════════════════════════
  // Navigate review page tab
  window.setReviewTab = function(tab) {
    S.reviewTab = tab;
    render();
  };

  function renderReview() {
    const taxResult  = S.taxResult || null;
    const issues     = TaxEngine.getReviewIssues(null, taxResult);
    const collapsed  = S.collapsedGroups || new Set(['received_not_sold']);
    const activeTab  = S.reviewTab || 'blockers';

    // ── Canonical status summary (single source of truth, shared with Reports) ──
    // Use this instead of deriving counts locally so both pages agree.
    const k4Report = S.k4Report;
    const ss = (taxResult && k4Report && TaxEngine.computeStatusSummary)
      ? TaxEngine.computeStatusSummary(taxResult, k4Report) : null;

    // ── Issue counts per severity tier ─────────────────────────────────────────
    // HARD BLOCKERS: only rows that genuinely prevent the K4 export from being valid.
    //   These are disposals with blocksCurrentK4=true (RT.MANUAL after resolveUnknownAcquisitions).
    //   Source: ss.hardBlockerCount (from computeStatusSummary).
    //
    // REVIEW RECOMMENDED: excluded rows with an actionable resolution path.
    //   These do NOT block the current K4 export. Show as "🟡" not "⛔".
    //   Source: ss.reviewRecommendedCount.
    //
    // INFORMATIONAL: already handled / low-risk rows (spam, estimated pricing).
    //   Source: ss.informationalCount.
    //
    // NOTE: this is the SAME model used by Reports. Both pages read from ss.
    const HARD_BLOCKER_REASONS = new Set(['missing_sek_price','unknown_acquisition','negative_balance','ambiguous_swap','unclassified']);
    const REVIEW_REASONS       = new Set(['duplicate','unmatched_transfer','outlier','split_trade','bridge_review','unknown_asset','unsupported_defi','unknown_contract','special_transaction','stable_source_unknown']);
    const INFO_REASONS         = new Set(['received_not_sold','spam_token']);

    // For the review QUEUE (transaction-level issues from getReviewIssues):
    const blockersAll = issues.filter(i => HARD_BLOCKER_REASONS.has(i.reason) || i.isK4Blocker);
    const warningsAll = issues.filter(i => REVIEW_REASONS.has(i.reason) && !i.isK4Blocker);
    const infoAll     = issues.filter(i => INFO_REASONS.has(i.reason));

    // For the HEADER: use ss (disposal-level) counts if available, otherwise fall back to issue queue
    const nHardBlockers = ss ? ss.hardBlockerCount        : blockersAll.length;
    const nReviewRec    = ss ? ss.reviewRecommendedCount  : warningsAll.length;
    const nInfo         = ss ? ss.informationalCount      : infoAll.length;
    const nAutoFix      = ss ? ss.autoResolvableCount     : 0;

    // Active tab still uses issue queue (transaction-level)
    const filteredIssues = activeTab === 'blockers' ? blockersAll
      : activeTab === 'warnings' ? warningsAll
      : activeTab === 'info'     ? infoAll
      : issues;

    const groups = groupByReason(filteredIssues);

    const canAutoInfer = issues.filter(i =>
      i.reason === 'missing_sek_price' && ['market_api_failed','swap_inference_failed'].includes(i.priceBlockReason)
    ).length;
    const unknownAssetCount = issues.filter(i => i.reason === 'unknown_asset').length;

    // ── Stale Solana import detection ──
    const allTxns = TaxEngine.getTransactions();
    const solTxByHash = {};
    for (const t of allTxns) {
      if (t.source !== 'solana_wallet' || !t.txHash || t.txHash.startsWith('manual_')) continue;
      solTxByHash[t.txHash] = (solTxByHash[t.txHash] || 0) + 1;
    }
    const staleSolanaCount = Object.values(solTxByHash).filter(v => v >= 2).length;

    // ── Swap-at-cost count in active tax result ──
    const swapAtCostTotal = taxResult && taxResult.disposals
      ? taxResult.disposals.filter(d => d.proceedsSource === 'swap_at_cost').length
      : 0;

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Granska transaktioner</h1>
          <span class="tax-page-subtitle">${nHardBlockers > 0 ? `⛔ ${nHardBlockers} hårda blockerare` : '✅ Inga hårda blockerare'}${nReviewRec > 0 ? ` · 🟡 ${nReviewRec} valfri granskning` : ''}${nInfo > 0 ? ` · 🔵 ${nInfo} info` : ''}${nAutoFix > 0 ? ` · ✨ ${nAutoFix} auto-lösningsbara` : ''}</span>
          ${issues.length > 0 ? `
            <div class="tax-page-actions" style="gap:8px">
              ${nAutoFix > 0 ? `<button class="tax-btn tax-btn-sm" style="background:rgba(74,222,128,.15);color:#4ade80;border:1px solid rgba(74,222,128,.35);font-weight:700;padding:6px 16px" onclick="TaxUI.autoResolveAll()">⚡ Auto-lösa ${nAutoFix} säkra rader</button>` : ''}
              ${unknownAssetCount > 0 ? `<button class="tax-btn tax-btn-sm" id="btn-resolve-tokens" style="background:rgba(14,165,233,.12);color:#38bdf8;border:1px solid rgba(14,165,233,.25)" onclick="TaxUI.resolveUnknownTokens()">🔍 Slå upp ${unknownAssetCount} okända tokens</button>` : ''}
              ${canAutoInfer > 0 ? `<button class="tax-btn tax-btn-sm" style="background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.25)" onclick="TaxUI.bulkAutoInfer()">🔁 Auto-inferera ${canAutoInfer}</button>` : ''}
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">⚙️ Kör om pipeline</button>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.markAllReviewed()">✓ Markera alla OK</button>
            </div>` : ''}
        </div>

        ${staleSolanaCount > 0 ? `
        <div style="margin-bottom:12px;padding:12px 16px;border-radius:10px;background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:20px">◎</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:#a78bfa">Solana-plånbok behöver re-importeras</div>
            <div style="font-size:12px;color:var(--tax-muted);margin-top:2px">
              ${staleSolanaCount} Solana-transaktioner hittades i äldre format (separata transfer-rader istället för TRADE-rader).
              Re-importera plånboken för korrekt byteskonstruktion.
            </div>
          </div>
          <button class="tax-btn tax-btn-sm" style="background:rgba(139,92,246,.2);color:#c4b5fd;border:1px solid rgba(139,92,246,.3);white-space:nowrap" onclick="TaxUI.navigate('accounts')">
            Gå till konton →
          </button>
        </div>` : ''}

        ${swapAtCostTotal > 0 ? `
        <div style="margin-bottom:12px;padding:10px 14px;border-radius:10px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:16px">⚠️</span>
          <div style="flex:1;font-size:12px;color:#fbbf24">
            <strong>${swapAtCostTotal} swap</strong> saknade prisdata — deras värde uppskattades via <em>swap-at-cost</em>-metoden
            (noll vinst/förlust per byte). Riktigt värde kan avvika.
            <a href="#" style="color:#a78bfa;margin-left:4px" onclick="window.setReviewTab('warnings');return false">Granska uppskattade swaps →</a>
          </div>
        </div>` : ''}

        <!-- ── Guided steps for new users ───────────────────── -->
        ${(() => {
          // Count issues by plain-language category
          const missingHistory = issues.filter(i => ['unknown_acquisition','negative_balance'].includes(i.reason)).length;
          const missingPrice   = issues.filter(i => i.reason === 'missing_sek_price').length;
          const unknownToken   = issues.filter(i => ['unknown_asset','unknown_contract','unclassified'].includes(i.reason)).length;
          const possibleSpam   = issues.filter(i => i.reason === 'spam_token').length;
          const unmatchedXfer  = issues.filter(i => ['unmatched_transfer','bridge_review'].includes(i.reason)).length;
          const totalBlockers  = missingHistory + missingPrice;
          if (issues.length === 0) return '';  // shown via done banner below

          const stepRow = (num, label, count, reason, tab) => {
            const done  = count === 0;
            const color = done ? '#4ade80' : (num <= 2 ? '#f87171' : '#fbbf24');
            const icon  = done ? '✅' : (num <= 2 ? '🔴' : '🟡');
            return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;
                               background:${done ? 'rgba(34,197,94,.04)' : 'rgba(255,255,255,.02)'};
                               border:1px solid ${done ? 'rgba(34,197,94,.12)' : 'rgba(148,163,184,.1)'};cursor:${done ? 'default' : 'pointer'}"
                        ${done ? '' : `onclick="window.setReviewTab('${tab}')"`}>
              <span style="font-size:16px;flex-shrink:0">${icon}</span>
              <div style="flex:1">
                <span style="font-size:12px;font-weight:600;color:${done ? '#4ade80' : '#e2e8f0'}">Steg ${num} · ${label}</span>
              </div>
              ${!done ? `<span style="font-size:11px;padding:2px 8px;border-radius:12px;background:${num<=2?'rgba(239,68,68,.12)':'rgba(251,191,36,.1)'};color:${color};font-weight:600;flex-shrink:0">${count} kvar</span>` : ''}
            </div>`;
          };

          return `
          <div style="margin-bottom:16px;padding:14px 16px;border-radius:12px;background:rgba(255,255,255,.02);border:1px solid rgba(148,163,184,.12)">
            <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">Nästa steg</div>
            <div style="display:grid;gap:6px">
              ${stepRow(1, 'Åtgärda saknad köphistorik',  missingHistory, 'unknown_acquisition', 'blockers')}
              ${missingHistory > 0 ? (() => {
                const acqIssues = issues.filter(i => i.reason === 'unknown_acquisition');
                const autoN  = acqIssues.filter(i => i.autoResolvable).length;
                const xferN  = acqIssues.filter(i => i.resolutionType === 'internal_transfer_candidate').length;
                const openN  = acqIssues.filter(i => i.resolutionType === 'opening_balance_candidate').length;
                const manN   = acqIssues.filter(i => i.resolutionType === 'manual_review_required').length;
                const parts  = [];
                if (autoN  > 0) parts.push(`${autoN} auto-lösbar`);
                if (xferN  > 0) parts.push(`${xferN} intern transfer`);
                if (openN  > 0) parts.push(`${openN} öppningssaldo`);
                if (manN   > 0) parts.push(`${manN} manuell`);
                return parts.length > 0
                  ? `<div style="margin:-4px 0 4px 38px;font-size:10px;color:#64748b">${parts.join(' · ')}</div>`
                  : '';
              })() : ''}
              ${stepRow(2, 'Åtgärda saknade priser',      missingPrice,   'missing_sek_price',   'blockers')}
              ${stepRow(3, 'Omatchade överföringar',       unmatchedXfer,  'unmatched_transfer',  'warnings')}
              ${stepRow(4, 'Okända tokens',                unknownToken,   'unknown_asset',       'warnings')}
              <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;
                          background:${totalBlockers===0?'rgba(34,197,94,.06)':'rgba(255,255,255,.02)'};
                          border:1px solid ${totalBlockers===0?'rgba(34,197,94,.2)':'rgba(148,163,184,.1)'};cursor:pointer"
                   onclick="TaxUI.navigate('reports')">
                <span style="font-size:16px">${totalBlockers===0?'✅':'⬜'}</span>
                <div style="flex:1"><span style="font-size:12px;font-weight:600;color:${totalBlockers===0?'#4ade80':'#94a3b8'}">Steg 5 · Generera K4 och deklarera</span></div>
                <span style="font-size:11px;color:#818cf8">Rapporter →</span>
              </div>
            </div>
          </div>`;
        })()}

        <!-- ── Per-asset provenance view ──────────────────────── -->
        ${(() => {
          if (!taxResult || !TaxEngine.buildAssetProvenance) return '';
          const provenance = TaxEngine.buildAssetProvenance(taxResult);
          if (provenance.length === 0) return '';

          const CLASSIFICATION_LABELS = {
            spam:              { icon: '🗑️', label: 'Spam-token',         color: '#f87171', canAuto: true  },
            airdrop:           { icon: '🪂', label: 'Airdrop',            color: '#818cf8', canAuto: true  },
            internal_transfer: { icon: '↔️', label: 'Intern transfer',    color: '#60a5fa', canAuto: false },
            opening_balance:   { icon: '📅', label: 'Öppningssaldo',      color: '#fbbf24', canAuto: false },
            purchased:         { icon: '🛒', label: 'Köpt',               color: '#4ade80', canAuto: false },
            unknown:           { icon: '❓', label: 'Okänd källa',        color: '#94a3b8', canAuto: false },
          };
          const DISPOSAL_STATUS_LABELS = {
            blocked:    { icon: '⛔', label: 'Hårt blockerare',    color: '#f87171' },
            excluded:   { icon: '🟡', label: 'Exkluderad (valfri)', color: '#fbbf24' },
            resolved:   { icon: '✅', label: 'Löst',               color: '#4ade80' },
            no_disposal:{ icon: '📥', label: 'Ingen avyttring',    color: '#475569' },
          };

          const showAll = S.provenanceShowAll;
          const visibleRows = showAll ? provenance : provenance.slice(0, 10);

          return `
          <div style="margin-bottom:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div>
                <span style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:.06em;text-transform:uppercase">Token-proveniens</span>
                <span style="font-size:11px;color:#475569;margin-left:8px">${provenance.length} token${provenance.length !== 1 ? 'er' : ''} med oklar ursprung</span>
              </div>
              ${provenance.length > 10 ? `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.toggleProvenanceAll()">${showAll ? 'Visa färre ↑' : `Visa alla ${provenance.length} →`}</button>` : ''}
            </div>
            <div style="display:grid;gap:4px">
              ${visibleRows.map(p => {
                const cl  = CLASSIFICATION_LABELS[p.likelyClassification] || CLASSIFICATION_LABELS.unknown;
                const dsl = DISPOSAL_STATUS_LABELS[p.disposalStatus]      || DISPOSAL_STATUS_LABELS.no_disposal;
                const confBadge = p.resolutionConfidence === 'high'   ? { label: 'hög konf.', c: '#4ade80' }
                                : p.resolutionConfidence === 'medium' ? { label: 'medel konf.', c: '#fbbf24' }
                                : p.resolutionConfidence === 'low'    ? { label: 'låg konf.', c: '#f87171' }
                                : null;
                return `
                <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 10px;background:rgba(15,23,42,.4);border-radius:7px;border:1px solid rgba(255,255,255,.05);font-size:11px">
                  <span style="font-size:16px;flex-shrink:0;margin-top:1px">${cl.icon}</span>
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px">
                      <span style="font-weight:700;color:#e2e8f0">${p.sym}</span>
                      <span style="padding:1px 5px;border-radius:3px;background:rgba(15,23,42,.6);color:${cl.color};font-size:10px">${cl.label}</span>
                      <span style="padding:1px 5px;border-radius:3px;background:rgba(15,23,42,.6);color:${dsl.color};font-size:10px">${dsl.icon} ${dsl.label}</span>
                      ${confBadge ? `<span style="font-size:9px;color:${confBadge.c}">${confBadge.label}</span>` : ''}
                      ${p.autoResolvable ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(99,102,241,.15);color:#818cf8">✨ auto-lösbar</span>` : ''}
                    </div>
                    <div style="display:flex;gap:10px;color:#475569;flex-wrap:wrap">
                      ${p.firstSeenDate ? `<span>📅 Först sedd: ${p.firstSeenDate}</span>` : ''}
                      ${p.sourceWallet  ? `<span>📍 Konto: ${p.sourceWallet.slice(0,12)}…</span>` : ''}
                      ${p.unresolvedCount > 0 ? `<span style="color:${p.hardBlockerCount > 0 ? '#f87171' : '#fbbf24'}">${p.unresolvedCount} avyttring${p.unresolvedCount !== 1 ? 'ar' : ''} olösta</span>` : ''}
                      ${p.stillHeld  ? '<span style="color:#60a5fa">📦 Hålls fortfarande</span>' : ''}
                      ${p.laterDisposed ? '<span style="color:#94a3b8">→ Avyttrad</span>' : ''}
                    </div>
                    ${p.resolutionNote ? `<div style="margin-top:3px;font-size:10px;color:#64748b;line-height:1.4">${p.resolutionNote.slice(0, 120)}${p.resolutionNote.length > 120 ? '…' : ''}</div>` : ''}
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
        })()}

        ${issues.length === 0 ? `
          <div class="tax-review-done">
            <div style="font-size:48px">✅</div>
            <div class="tax-review-done-title">Allt klart!</div>
            <div class="tax-review-done-sub">Inga undantag. Skatteberäkningarna är baserade på fullständig data.</div>
          </div>
        ` : `

        <!-- Tab bar — uses statusSummary counts so it agrees with Reports page -->
        <div style="display:flex;gap:4px;margin-bottom:16px;padding:4px;background:rgba(255,255,255,.03);border:1px solid var(--tax-border);border-radius:10px;width:fit-content">
          ${[
            { key: 'blockers', label: '⛔ Hårda blockerare', count: nHardBlockers,  color: nHardBlockers > 0 ? '#f87171' : null,
              tooltip: 'Disposals that prevent the current K4 export from being valid. Must be fixed before filing.' },
            { key: 'warnings', label: '🟡 Valfri granskning', count: nReviewRec,    color: nReviewRec > 0 ? '#fbbf24' : null,
              tooltip: 'Excluded rows that do not block the current K4 export. Optional — fixing improves accuracy.' },
            { key: 'info',     label: '🔵 Info',             count: nInfo,          color: nInfo > 0 ? '#818cf8' : null,
              tooltip: 'Already handled rows (spam, estimated pricing). Informational only.' },
            { key: 'all',      label: 'Alla',                count: issues.length,  color: null },
          ].map(({ key, label, count, color, tooltip }) => {
            const isActive = activeTab === key;
            return `<button
              onclick="window.setReviewTab('${key}')"
              style="padding:6px 14px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:${isActive ? '600' : '400'};
                     background:${isActive ? 'rgba(255,255,255,.07)' : 'transparent'};
                     color:${isActive ? (color || '#e2e8f0') : 'var(--tax-muted)'};
                     transition:all .15s">
              ${label}
              ${count > 0 ? `<span style="margin-left:5px;padding:1px 6px;border-radius:9px;font-size:10px;background:${isActive && color ? color.replace(')', ',.15)').replace('rgb','rgba') : 'rgba(148,163,184,.12)'};color:${color || 'var(--tax-muted)'}">${count}</span>` : ''}
            </button>`;
          }).join('')}
        </div>

          ${filteredIssues.length === 0 ? `
          <div style="text-align:center;padding:40px 20px;color:var(--tax-muted)">
            <div style="font-size:36px;margin-bottom:8px">✅</div>
            <div style="font-size:14px;font-weight:500;color:#e2e8f0">
              ${activeTab === 'blockers' ? '✅ Inga hårda blockerare — de verifierade K4-raderna kan exporteras' :
                activeTab === 'warnings' ? '✅ Inga valfria granskningsposter' :
                activeTab === 'info' ? '✅ Inga informationsposter' :
                '✅ Inga undantag'}
            </div>
            <div style="font-size:12px;margin-top:4px">
              ${activeTab !== 'all' ? `<a href="#" style="color:#818cf8" onclick="window.setReviewTab('all');return false">Visa alla flikar →</a>` : 'Skatteberäkningarna är baserade på fullständig data.'}
            </div>
          </div>` : ''}

          ${(() => {
            const unknownAcqIssues = issues.filter(i => i.reason === 'unknown_acquisition');
            const distinctAssets = new Set(unknownAcqIssues.map(i => i.asset || i.symbol || '')).size;
            if (distinctAssets < 2) return '';
            return `<div style="margin-bottom:16px;padding:14px 16px;border-radius:10px;background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.25);display:flex;align-items:flex-start;gap:12px">
              <span style="font-size:20px;line-height:1">🔍</span>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:600;color:#fbbf24;margin-bottom:3px">Saknade konton upptäckta</div>
                <div style="font-size:12px;color:#94a3b8;line-height:1.5">${distinctAssets} tillgångar såldes utan registrerat köp. Du kanske saknar ett konto — importera börsen eller plånboken där du köpte dem för att automatiskt lösa dessa poster.</div>
              </div>
              <button class="tax-btn tax-btn-sm" style="background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3);flex-shrink:0" onclick="TaxUI.openAddAccountModal()">➕ Lägg till konto</button>
            </div>`;
          })()}

          ${(() => {
            const n = S.reviewSelectedIds.size;
            if (n === 0) return '';
            const btn = (icon, label, type, color) =>
              `<button onclick="TaxUI.bulkClassifySelected('${type}')" style="padding:5px 10px;border-radius:6px;border:1px solid ${color}33;background:${color}15;color:${color};font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">${icon} ${label}</button>`;
            return `<div style="position:sticky;top:48px;z-index:50;background:rgba(15,23,42,.97);backdrop-filter:blur(8px);border:1px solid rgba(99,102,241,.35);border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;box-shadow:0 4px 24px rgba(0,0,0,.4)">
              <span style="font-size:13px;font-weight:600;color:#818cf8;flex-shrink:0">${n} markerad${n !== 1 ? 'e' : ''}</span>
              ${btn('↔', 'Intern transfer', 'internal_transfer', '#60a5fa')}
              ${btn('🪂', 'Airdrop', 'airdrop', '#818cf8')}
              ${btn('📅', 'Öppningssaldo', 'opening_balance', '#fbbf24')}
              ${btn('🗑', 'Spam/uteslut', 'spam', '#4ade80')}
              <span style="flex:1"></span>
              <button onclick="TaxUI.bulkPriceSelected()" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(251,191,36,.25);background:rgba(251,191,36,.08);color:#fbbf24;font-size:12px;cursor:pointer;white-space:nowrap">💰 Ange pris</button>
              <button onclick="TaxUI.clearReviewSelection()" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(148,163,184,.15);background:transparent;color:#64748b;font-size:12px;cursor:pointer;white-space:nowrap">✕ Avmarkera allt</button>
            </div>`;
          })()}

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
                  case 'mark_spam':              return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkMarkSpam('${reason}')">🚫 Mark all spam</button>`;
                  case 'enter_price':            return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkShowPriceSearch('${reason}')">💰 Batch price lookup</button>`;
                  case 'mark_zero_cost':         return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkZeroCost('${reason}')">0️⃣ Set zero cost</button>`;
                  case 'mark_income':            return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkReclassify('${reason}','income')">💼 Reclassify as income</button>`;
                  case 'ignore_received':        return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkMarkReviewed('${reason}')">✓ Ignore all</button>`;
                  case 'confirm_spam':           return `<button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.bulkMarkReviewed('${reason}')">✓ Confirm spam</button>`;
                  case 'import_account':         return `<button class="tax-btn tax-btn-xs" style="background:rgba(16,185,129,.12);color:#34d399;border:1px solid rgba(16,185,129,.2)" onclick="TaxUI.openAddAccountModal()">➕ Lägg till konto</button>`;
                  case 'mark_exchange_buy':      return `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.bulkReclassify('${reason}','buy')">🏦 Börsinköp</button>`;
                  case 'mark_internal_transfer': return `<button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)" onclick="TaxUI.bulkReclassify('${reason}','transfer_in')">↔ Intern överföring</button>`;
                  case 'mark_opening_balance':   return `<button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.2)" onclick="TaxUI.bulkReclassify('${reason}','opening_balance')">📅 Öppningssaldo</button>`;
                  case 'mark_airdrop':           return `<button class="tax-btn tax-btn-xs" style="background:rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.2)" onclick="TaxUI.bulkReclassify('${reason}','airdrop')">🪂 Airdrop/belöning</button>`;
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
                ${reason === 'unknown_acquisition' ? `
                <div style="margin-bottom:10px;padding:12px 14px;border-radius:10px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.15)">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
                    <span style="font-size:16px">🧭</span>
                    <span style="font-size:13px;font-weight:600;color:#818cf8">Hjälp mig hitta saknade anskaffningar</span>
                    ${items.some(i => i.autoResolvable) ? `
                    <button class="tax-btn tax-btn-sm" style="background:rgba(34,197,94,.15);color:#4ade80;border:1px solid rgba(34,197,94,.25);font-weight:600;margin-left:auto"
                            onclick="TaxUI.autoFixEasyCases()">
                      ✨ Auto-fix ${items.filter(i => i.autoResolvable).length} enkla fall först
                    </button>` : ''}
                  </div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="tax-btn tax-btn-xs" style="background:rgba(96,165,250,.1);color:#60a5fa;border:1px solid rgba(96,165,250,.2)"
                            onclick="TaxUI.openAddAccountModal()">📥 Importera plånbok</button>
                    <button class="tax-btn tax-btn-xs" style="background:rgba(96,165,250,.1);color:#60a5fa;border:1px solid rgba(96,165,250,.2)"
                            onclick="TaxUI.navigate('import')">📄 Importera börs-CSV</button>
                    <button class="tax-btn tax-btn-xs" style="background:rgba(129,140,248,.1);color:#818cf8;border:1px solid rgba(129,140,248,.2)"
                            onclick="TaxUI.bulkMarkSpam('unknown_acquisition')">🪂 Klassificera airdrops</button>
                    <button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.2)"
                            onclick="TaxUI.navigate('import')">📅 Skapa öppningssaldon</button>
                  </div>
                </div>` : ''}
                ${reason === 'stable_source_unknown' ? `
                <div style="margin-bottom:10px;padding:12px 14px;border-radius:10px;background:rgba(99,102,241,.05);border:1px solid rgba(99,102,241,.12)">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                    <span style="font-size:16px">🪙</span>
                    <div>
                      <div style="font-size:13px;font-weight:600;color:#818cf8">Pris löst — anskaffningskällan saknas</div>
                      <div style="font-size:11px;color:var(--tax-muted);margin-top:2px">
                        Priset är automatiskt löst via stablecoin-peg + historisk USD/SEK. Välj hur dessa tokens anskaffades:
                      </div>
                    </div>
                  </div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)"
                            onclick="TaxUI.bulkReclassify('stable_source_unknown','buy')">🏦 Börsinköp (t.ex. Revolut)</button>
                    <button class="tax-btn tax-btn-xs" style="background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.2)"
                            onclick="TaxUI.bulkReclassify('stable_source_unknown','transfer_in')">↔ Intern överföring</button>
                    <button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.2)"
                            onclick="TaxUI.bulkReclassify('stable_source_unknown','opening_balance')">📅 Öppningssaldo</button>
                    <button class="tax-btn tax-btn-xs" style="background:rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.2)"
                            onclick="TaxUI.bulkReclassify('stable_source_unknown','airdrop')">🪂 Airdrop/belöning</button>
                  </div>
                </div>` : ''}
                <div class="tax-review-fix-tip">
                  💡 ${meta.fix}
                  ${reason === 'duplicate' ? `<button class="tax-btn tax-btn-xs" style="margin-left:8px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)" onclick="TaxUI.deleteDuplicates()">🗑 Delete all duplicates</button>` : ''}
                  <span style="display:inline-flex;gap:6px;margin-left:8px">${extraBulk}${bulkActions}</span>
                </div>
                <div class="tax-review-items">
                  ${(() => {
                    const isAssetGrouped = (reason === 'unknown_acquisition' || reason === 'missing_sek_price')
                      && subGroups && subGroups.length > 0;

                    // Helper: render rows with row-limit + expand button
                    const renderRowsWithLimit = (sgItems, renderRow, groupKey) => {
                      const ROW_LIMIT = 10;
                      const isExpanded = S.reviewGroupExpanded.has(groupKey);
                      const visible = isExpanded ? sgItems : sgItems.slice(0, ROW_LIMIT);
                      const remaining = sgItems.length - visible.length;
                      return visible.map(renderRow).join('')
                        + (remaining > 0
                          ? `<button onclick="TaxUI.expandReviewGroup(${JSON.stringify(groupKey)})"
                              style="width:100%;padding:8px;margin:4px 0;background:rgba(99,102,241,.06);border:1px dashed rgba(99,102,241,.2);border-radius:6px;color:#818cf8;font-size:12px;cursor:pointer;text-align:center">
                              Visa ${remaining} fler →
                            </button>`
                          : '');
                    };

                    if (isAssetGrouped) {
                      return subGroups.map(sg => {
                        const highImpact = sg.items.filter(i => i.impactLevel === 'high').length;
                        const medImpact  = sg.items.filter(i => i.impactLevel === 'medium').length;
                        const lowImpact  = sg.items.filter(i => i.impactLevel === 'low').length;
                        const autoCount  = sg.items.filter(i => i.autoResolvable).length;
                        const nAssets    = sg.assetGroups ? sg.assetGroups.length : 0;
                        const renderRow  = reason === 'unknown_acquisition'
                          ? (issue => renderAcquisitionRow(issue))
                          : (issue => renderReviewRow(issue));

                        // Bulk action button for this sub-group
                        const sgBulkType = reason === 'unknown_acquisition'
                          ? ({ spam_candidate:'spam', airdrop_candidate:'airdrop',
                               internal_transfer_candidate:'internal_transfer',
                               opening_balance_candidate:'opening_balance' }[sg.key] || null)
                          : null;
                        const sgBulkBtn = sgBulkType
                          ? `<button onclick="TaxUI.selectAllInGroup('${reason}','${sg.key}')" style="margin-left:auto;font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid rgba(148,163,184,.2);background:transparent;color:#94a3b8;cursor:pointer">Välj alla</button>`
                          : '';

                        const assetGroupsHtml = sg.assetGroups && nAssets > 1
                          ? sg.assetGroups.map(ag => {
                              const agKey = `${reason}:${sg.key}:${ag.sym}`;
                              const isCollapsed = S.reviewAssetCollapsed.has(agKey);
                              return `
                              <div style="border-left:2px solid rgba(148,163,184,.1);margin-left:4px">
                                <div onclick="TaxUI.toggleAssetGroup(${JSON.stringify(agKey)})"
                                     style="display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;background:rgba(148,163,184,.03);border-bottom:1px solid rgba(148,163,184,.06)">
                                  <span style="font-size:10px;color:#64748b">${isCollapsed ? '▶' : '▼'}</span>
                                  <span style="font-size:12px;font-weight:600;color:#e2e8f0">${ag.sym}</span>
                                  <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(0,0,0,.25);color:#64748b">${ag.items.length} rad${ag.items.length !== 1 ? 'er' : ''}</span>
                                  <button onclick="event.stopPropagation();TaxUI.selectAllInAssetGroup('${reason}','${sg.key}','${ag.sym}')"
                                    style="font-size:10px;padding:1px 7px;border-radius:4px;border:1px solid rgba(148,163,184,.15);background:transparent;color:#64748b;cursor:pointer">Välj alla</button>
                                  ${sgBulkType ? `<button onclick="event.stopPropagation();(function(){TaxUI.selectAllInAssetGroup('${reason}','${sg.key}','${ag.sym}');TaxUI.bulkClassifySelected('${sgBulkType}');})()"
                                    style="font-size:10px;padding:1px 7px;border-radius:4px;border:1px solid rgba(74,222,128,.2);background:rgba(74,222,128,.07);color:#4ade80;cursor:pointer">Alla ${ag.sym} → ${sgBulkType === 'spam' ? 'spam' : sgBulkType}</button>` : ''}
                                </div>
                                ${isCollapsed ? '' : renderRowsWithLimit(ag.items, renderRow, agKey)}
                              </div>`;
                            }).join('')
                          : renderRowsWithLimit(sg.items, renderRow, `${reason}:${sg.key}`);

                        return `
                        <div style="padding:8px 12px 4px;background:rgba(15,23,42,.5);border-bottom:1px solid rgba(148,163,184,.08);border-left:3px solid ${sg.color || '#64748b'}">
                          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                            <span style="font-size:12px;font-weight:600;color:${sg.color || '#e2e8f0'}">${sg.label}</span>
                            <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,.3);color:#94a3b8">${sg.items.length} rad${sg.items.length !== 1 ? 'er' : ''}${nAssets > 1 ? `, ${nAssets} tillgångar` : ''}</span>
                            ${autoCount > 0 ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(99,102,241,.12);color:#818cf8">✨ ${autoCount} auto-lösbar${autoCount !== 1 ? 'a' : ''}</span>` : ''}
                            ${highImpact > 0 ? `<span style="font-size:10px;color:#f87171">🔴 ${highImpact} hög</span>` : ''}
                            ${medImpact > 0 ? `<span style="font-size:10px;color:#fbbf24">🟡 ${medImpact} medel</span>` : ''}
                            ${lowImpact > 0 ? `<span style="font-size:10px;color:#4ade80">🟢 ${lowImpact} låg</span>` : ''}
                            ${sgBulkBtn}
                          </div>
                          ${sg.tip ? `<div style="font-size:10px;color:#64748b;margin-top:2px;margin-bottom:2px">${sg.tip}</div>` : ''}
                        </div>
                        ${assetGroupsHtml}`;
                      }).join('');
                    }

                    // Non-asset-grouped: flat subGroups (other reasons)
                    if (subGroups && subGroups.length > 1) {
                      return subGroups.map(sg => `
                        <div style="padding:6px 12px 4px;background:rgba(148,163,184,.04);border-bottom:1px solid rgba(148,163,184,.08)">
                          <span style="font-size:11px;font-weight:600;color:#64748b">${sg.label}</span>
                          <span style="font-size:10px;color:#475569;margin-left:6px">${sg.items.length} transaction${sg.items.length !== 1 ? 's' : ''}</span>
                          ${sg.tip ? `<span style="font-size:10px;color:#475569;margin-left:8px">· ${sg.tip}</span>` : ''}
                        </div>
                        ${renderRowsWithLimit(sg.items, issue => renderReviewRow(issue), `${reason}:${sg.key}`)}
                      `).join('');
                    }

                    // Flat list with row limit
                    const renderRow = reason === 'unknown_acquisition'
                      ? (issue => renderAcquisitionRow(issue))
                      : (issue => renderReviewRow(issue));
                    return renderRowsWithLimit(items, renderRow, reason);
                  })()}
                </div>`}
              </div>`;
            }).join('')}
          </div>
        `}

        ${S.editTxId ? renderEditModal() : ''}

        ${S.pendingSimilarAction ? (() => {
          const { ids, label } = S.pendingSimilarAction;
          return `<div style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;
            background:rgba(15,23,42,.97);backdrop-filter:blur(8px);border:1px solid rgba(99,102,241,.4);
            border-radius:12px;padding:12px 18px;display:flex;align-items:center;gap:12px;
            box-shadow:0 8px 32px rgba(0,0,0,.5);white-space:nowrap">
            <span style="font-size:13px;color:#e2e8f0">Tillämpa på <strong style="color:#818cf8">${ids.size}</strong> liknande rader?</span>
            <button onclick="TaxUI.applySimilarAction()" style="padding:5px 12px;border-radius:6px;border:1px solid rgba(99,102,241,.4);background:rgba(99,102,241,.2);color:#818cf8;font-size:12px;font-weight:600;cursor:pointer">Ja, tillämpa</button>
            <button onclick="TaxUI.dismissSimilarToast()" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(148,163,184,.15);background:transparent;color:#64748b;font-size:12px;cursor:pointer">Avfärda</button>
          </div>`;
        })() : ''}
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
    // Helper: build asset-level sub-groups within a subGroup
    function buildAssetSubGroups(items) {
      const assetMap = {};
      for (const issue of items) {
        const sym = ((issue.txn?.assetSymbol || issue.asset || issue.symbol || '?')).toUpperCase();
        if (!assetMap[sym]) assetMap[sym] = [];
        assetMap[sym].push(issue);
      }
      return Object.entries(assetMap)
        .sort(([,a],[,b]) => b.length - a.length) // most rows first
        .map(([sym, asItems]) => ({ sym, items: asItems }));
    }

    // For missing_sek_price, build sub-groups by priceBlockReason + asset
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
      }).map(([key, items]) => ({
        key, ...BLOCK_REASON_LABELS[key], items,
        assetGroups: buildAssetSubGroups(items),
      }));
    }
    // For unknown_acquisition, build sub-groups by resolutionType + asset
    const RESOLUTION_LABELS = {
      spam_candidate:              { label: '🗑️ Troligen spam',            color: '#4ade80', tip: 'Auto-lösbar — exkluderas med 0 kr kostnadsbas.' },
      airdrop_candidate:           { label: '🪂 Troligen airdrop',         color: '#818cf8', tip: 'Kan omklassificeras — kostnadsbas = FMV vid mottagning.' },
      internal_transfer_candidate: { label: '↔️ Troligen intern transfer',  color: '#60a5fa', tip: 'Importera källplånboken — motorn matchar automatiskt.' },
      opening_balance_candidate:   { label: '📅 Troligen öppningssaldo',   color: '#fbbf24', tip: 'Tillgången ägdes före importen — skapa manuell anskaffning.' },
      manual_review_required:      { label: '🔍 Manuell granskning',      color: '#f87171', tip: 'Motorn kunde inte identifiera källa automatiskt.' },
    };
    const RES_ORDER = ['spam_candidate','airdrop_candidate','internal_transfer_candidate','opening_balance_candidate','manual_review_required'];
    if (groups.unknown_acquisition) {
      const subMap = {};
      for (const issue of groups.unknown_acquisition.items) {
        const key = issue.resolutionType || 'manual_review_required';
        if (!subMap[key]) subMap[key] = [];
        subMap[key].push(issue);
      }
      groups.unknown_acquisition.subGroups = Object.entries(subMap).sort(([a],[b]) => {
        const ai = RES_ORDER.indexOf(a), bi = RES_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }).map(([key, items]) => ({
        key, ...(RESOLUTION_LABELS[key] || { label: key, color: '#94a3b8', tip: '' }), items,
        assetGroups: buildAssetSubGroups(items),
      }));
    }
    // Return in priority order
    const ORDER = [
      'unknown_acquisition','negative_balance','missing_sek_price','unknown_asset',
      'duplicate','ambiguous_swap','unmatched_transfer','outlier','split_trade',
      'stable_source_unknown',  // stablecoin with price resolved but source unknown
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
  // Helper: render K4 confidence badge for a k4Row
  function k4ConfBadge(row) {
    if (!row.confidence || row.confidence === 'exact') return '';
    if (row.confidence === 'unknown') {
      const missing = row.acquisitionMissingCount || 0;
      const partial = row.acquisitionPartialCount || 0;
      if (missing > 0) {
        return `<span title="Anskaffning saknas helt för ${missing} transaktion${missing !== 1 ? 'er' : ''} — ursprunglig köpkälla ej importerad." style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.22);color:#f87171;font-weight:700;cursor:help">⛔ Saknas</span>`;
      }
      if (partial > 0) {
        return `<span title="Ofullständig historik för ${partial} transaktion${partial !== 1 ? 'er' : ''} — sålde mer än vad som importerats." style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.18);color:#f87171;font-weight:600;cursor:help">⚠ Ofullständig</span>`;
      }
      return `<span title="Okänd anskaffning — kostnadsbas 0 kr. Granska i Review-fliken." style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.18);color:#f87171;font-weight:600;cursor:help">⚠ Okänd</span>`;
    }
    if (row.confidence === 'estimated') {
      const n = row.swapAtCostCount || '';
      return `<span title="${n} swap${n !== 1 ? 's' : ''} prissatt via swap-at-cost-uppskattning. Oklart exakt pris vid byte." style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(251,191,36,.15);color:#fbbf24;cursor:help">~ Uppskattad</span>`;
    }
    if (row.confidence === 'zero_cost') {
      return `<span title="Kostnadsbas 0 kr — token anskaffad utan marknadsvärde (airdrop/reward). Kontrollera om detta stämmer." style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.12);color:#fca5a5;cursor:help">0 Nollkostnad</span>`;
    }
    return '';
  }

  // Helper: per-row acquisition debug panel (native <details> — no JS state)
  function k4RowDebugPanel(row) {
    if (!row.debugDisposals || row.debugDisposals.length === 0) return '';
    const missing = row.acquisitionMissingCount || 0;
    const partial = row.acquisitionPartialCount || 0;
    const summaryText = missing > 0
      ? `${missing} transaktion${missing !== 1 ? 'er' : ''} utan anskaffning`
      : partial > 0
        ? `${partial} transaktion${partial !== 1 ? 'er' : ''} med ofullständig historik`
        : 'Anskaffningsinfo';
    return `<details style="margin-top:4px">
      <summary style="font-size:9px;color:#94a3b8;cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:3px">
        <span>▸</span> ${summaryText}
      </summary>
      <div style="margin-top:4px;padding:6px 8px;background:rgba(0,0,0,.25);border-radius:4px;border:1px solid rgba(239,68,68,.15)">
        ${row.debugDisposals.map(d => {
          const dbg = d.acquisitionDebug || {};
          const reasonText = {
            acquisition_missing: '⛔ Saknas',
            acquisition_partial: '⚠ Ofullständig',
            confirmed_zero:      '✓ Nollkostnad',
          }[d.zeroCostReason] || '❓ Okänd';
          const reasonColor = d.zeroCostReason === 'acquisition_missing' ? '#f87171'
            : d.zeroCostReason === 'acquisition_partial' ? '#fbbf24' : '#94a3b8';
          return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:9px;flex-wrap:wrap">
            <span style="color:var(--tax-muted);min-width:72px">${d.date ? d.date.slice(0,10) : '—'}</span>
            <span style="color:#94a3b8;min-width:64px">${TaxEngine.formatSEK ? TaxEngine.formatSEK(d.proceedsSEK) : Math.round(d.proceedsSEK) + ' kr'}</span>
            <span style="color:${reasonColor};font-weight:600">${reasonText}</span>
            ${dbg.reason ? `<span style="color:#64748b;flex:1">${dbg.reason}</span>` : ''}
            ${dbg.acqsFound > 0 ? `<span style="color:#475569">${dbg.acqsFound} anskaffning${dbg.acqsFound !== 1 ? 'ar' : ''}</span>` : ''}
          </div>`;
        }).join('')}
        <div style="margin-top:5px;font-size:9px;color:#64748b">
          💡 ${missing > 0
            ? 'Importera den wallet/exchange där detta köptes — motorn matchar automatiskt.'
            : 'Lägg till komplett transaktionshistorik för att täcka alla försäljningar.'}
        </div>
      </div>
    </details>`;
  }

  function renderReports() {
    const result = getOrComputeTaxResult();
    const { summary, disposals } = result;
    const k4 = TaxEngine.generateK4Report(result);
    // Airdrop summary from engine (may be undefined for older cached results)
    const adSum = result.airdropSummary || {};
    const adTotal    = adSum.totalCount || 0;
    const adValueSEK = adSum.totalValueSEK || 0;
    const adClaimed  = adSum.claimedCount || 0;
    const adUnsol    = adSum.unsolicitedCount || 0;
    // Pre-compute estimated high-proceeds debug rows (exposed in panel below K4 table)
    const estimatedHighProceeds = TaxEngine.queryEstimatedHighProceedsDisposals
      ? TaxEngine.queryEstimatedHighProceedsDisposals(result) : [];

    // ── Fail-closed totals ────────────────────────────────────────────────
    // K4 rows are now ONLY 'final' eligible disposals.
    // Excluded rows are grouped by status for the Review panel.
    const trustedGains    = k4.k4Rows.filter(r => r.side === 'gain').reduce((s, r) => s + r.gain, 0);
    const trustedLosses   = k4.k4Rows.filter(r => r.side === 'loss').reduce((s, r) => s + r.loss, 0);
    const unknownGainsAmt = 0; // All uncertain rows are now excluded, not in K4
    // Excluded disposals summary
    const excByStatus     = k4.excludedByStatus || {};
    const excSanity       = (excByStatus['sanity_flagged']               || []);
    const excEstimated    = (excByStatus['estimated_reviewable']         || []);
    const excMissing      = (excByStatus['missing_history']              || []);  // unclassified fallback
    const excBlocked      = (excByStatus['blocked_outlier']              || []);
    const excUnknownId    = (excByStatus['unknown_asset_identity']       || []);
    const excNoise        = (excByStatus['excluded_noise']               || []);
    // Auto-recovery sub-buckets (sub-classified from missing_history by engine)
    const excTransfer     = (excByStatus['internal_transfer_candidate']  || []);
    const excOpenBal      = (excByStatus['opening_balance_candidate']    || []);
    const excAirdropCand  = (excByStatus['airdrop_candidate']            || []);
    const excSpamCand     = (excByStatus['spam_candidate']               || []);
    const excManual       = (excByStatus['manual_review_required']       || []);
    const recoveryStats   = k4.recoveryStats || {};
    const excSanityGain   = excSanity.reduce((s, d) => s + (d.gainLossSEK || 0), 0);
    const excEstGain      = excEstimated.reduce((s, d) => s + (d.proceedsSEK || 0) - (d.costBasisSEK || 0), 0);
    const excMissingProc  = [...excMissing, ...excTransfer, ...excOpenBal, ...excAirdropCand,
                             ...excSpamCand, ...excManual].reduce((s, d) => s + (d.proceedsSEK || 0), 0);
    const issues = TaxEngine.getReviewIssues(null, result).length;
    // ── K4-only summary figures ── ALL summary cards must use these, never the
    // portfolio-level totalGains/taxableGain/estimatedTax which include excluded rows.
    const k4Gains       = summary.k4TotalGains    || 0;
    const k4Losses      = summary.k4TotalLosses   || 0;
    const deductibleLoss = summary.k4DeductibleLoss ?? (k4Losses * 0.70);
    const k4TaxableGain  = summary.k4TaxableGain  ?? Math.max(0, k4Gains - deductibleLoss);
    const k4EstimatedTax = summary.k4EstimatedTax ?? (k4TaxableGain * 0.30);
    const k4RowCount     = k4.k4DisposalCount     || 0;
    const excCount       = k4.excludedCount        || summary.excludedCount || 0;

    // Dev assertion: taxable gain must match formula from the K4 rows themselves
    (() => {
      const expected = Math.max(0, k4Gains - k4Losses * 0.70);
      const diff = Math.abs(k4TaxableGain - expected);
      if (diff > 1) {
        console.error(`[K4 ASSERT] taxableGain mismatch: rendered=${k4TaxableGain} expected=${expected} diff=${diff}`, {
          k4Gains, k4Losses, deductibleLoss, k4TaxableGain, k4EstimatedTax, summary
        });
      }
    })();
    const health = TaxEngine.computeReportHealth ? TaxEngine.computeReportHealth(result, k4) : null;
    // Canonical status summary — single source of truth used by both Reports and Review
    const ss = TaxEngine.computeStatusSummary ? TaxEngine.computeStatusSummary(result, k4) : null;
    // Cache k4Report on S so the sidebar can read it without recomputing
    S.k4Report = k4;

    // ── Health banner colors — now maps ss.overallStatus directly ──
    // 'k4_ready_verified' and 'k4_ready_with_backlog' are green/blue (not red),
    // because excluded rows in the backlog do NOT block the current export.
    const HEALTH_STYLE = {
      k4_ready_verified: { bg: 'rgba(34,197,94,.08)',    border: 'rgba(34,197,94,.25)',    color: '#4ade80',    icon: '✅' },
      k4_ready_with_backlog: { bg: 'rgba(96,165,250,.07)', border: 'rgba(96,165,250,.25)', color: '#60a5fa',  icon: '📋' },
      needs_review:      { bg: 'rgba(251,191,36,.1)',    border: 'rgba(251,191,36,.3)',    color: '#fbbf24',    icon: '🟡' },
      invalid:           { bg: 'rgba(239,68,68,.12)',    border: 'rgba(239,68,68,.35)',    color: '#f87171',    icon: '🔴' },
      ok:                { bg: 'rgba(34,197,94,.08)',    border: 'rgba(34,197,94,.25)',    color: '#4ade80',    icon: '✅' },
      warnings:          { bg: 'rgba(251,191,36,.08)',   border: 'rgba(251,191,36,.2)',    color: '#fbbf24',    icon: '⚠️' },
    };
    const effectiveStatus = ss ? ss.overallStatus : (health ? health.status : null);
    const healthStyle = (effectiveStatus ? HEALTH_STYLE[effectiveStatus] : null)
      || { bg: 'rgba(148,163,184,.06)', border: 'rgba(148,163,184,.15)', color: '#94a3b8', icon: 'ℹ️' };
    const displayLabel   = ss ? ss.reportLabel   : (health ? health.label   : '');
    const displaySublabel = ss ? ss.reportSublabel : (health ? health.sublabel : '');
    const isInvalid = effectiveStatus === 'invalid';
    const isReady   = effectiveStatus === 'k4_ready_verified' || effectiveStatus === 'k4_ready_with_backlog' || effectiveStatus === 'ok';

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Tax Reports</h1>
          <span class="tax-page-subtitle">${S.taxYear} — Skatteverket K4</span>
        </div>

        ${(ss || health) ? `
        <div style="margin-bottom:16px;padding:${isInvalid?'16px':'12px'} 16px;border-radius:12px;background:${healthStyle.bg};border:${isInvalid?'2px':'1px'} solid ${healthStyle.border}">
          <div style="display:flex;align-items:${isInvalid?'flex-start':'center'};gap:12px;flex-wrap:wrap">
            <span style="font-size:${isInvalid?'28px':'20px'}">${healthStyle.icon}</span>
            <div style="flex:1">
              <div style="font-size:${isInvalid?'15px':'13px'};font-weight:700;color:${healthStyle.color}">${displayLabel}</div>
              ${displaySublabel ? `<div style="font-size:12px;color:var(--tax-muted);margin-top:3px">${displaySublabel}</div>` : ''}
              ${isInvalid ? `
              <div style="margin-top:8px;font-size:12px;color:#94a3b8;line-height:1.6">
                Dessa siffror <strong style="color:#f87171">ska inte lämnas in</strong> förrän du har åtgärdat problemen under Granska.
                Kostnadsbas saknas för ${ss ? ss.hardBlockerCount : (health ? health.k4Blockers : 0)} avyttringar — vinsten är troligen kraftigt överskattad.
              </div>` : ''}
              ${ss?.hasBacklog && !isInvalid ? `
              <div style="margin-top:6px;font-size:11px;color:#475569">
                ${ss.excludedCount} exkluderade rader ingår <strong>inte</strong> i K4-exporten — de blockerar inte inlämning men kan förbättra precisionen om de löses.
                ${ss.reviewRecommendedCount > 0 ? `<span style="color:#60a5fa"> ${ss.reviewRecommendedCount} rekommenderas granskning.</span>` : ''}
              </div>` : ''}
              ${health?.details?.length > 0 && isInvalid ? `
              <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
                ${health.details.map(d => `<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.2);color:var(--tax-muted)">${d}</span>`).join('')}
              </div>` : ''}
            </div>
            ${!isReady ? `
            <button class="tax-btn tax-btn-sm" style="color:${healthStyle.color};border-color:${healthStyle.border};background:${isInvalid?'rgba(239,68,68,.15)':'transparent'};white-space:nowrap;font-weight:600" onclick="TaxUI.navigate('review')">
              Åtgärda →
            </button>` : ''}
          </div>
        </div>` : issues > 0 ? `
        <div class="tax-warn-box" style="margin-bottom:16px">
          ⚠️ ${issues} transactions still need review. Tax results may be incomplete.
          <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.navigate('review')" style="margin-left:8px">Fix →</button>
        </div>` : ''}

        <div class="tax-user-info-bar" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px 16px;background:rgba(255,255,255,.03);border:1px solid var(--tax-border);border-radius:10px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--tax-muted);white-space:nowrap">K4 Uppgifter:</span>
          <input id="tax-user-name" class="tax-input" type="text" placeholder="Namn" value="${S.userName || ''}" onchange="TaxUI.setUserInfo('name', this.value)" style="width:200px;height:30px;font-size:12px">
          <input id="tax-user-pnr" class="tax-input" type="text" placeholder="Personnummer (YYYYMMDD-XXXX)" value="${S.userPnr || ''}" onchange="TaxUI.setUserInfo('pnr', this.value)" style="width:220px;height:30px;font-size:12px">
        </div>

        <div class="tax-report-hero" style="${(ss ? !ss.canFile : health?.canFile===false)?'border-color:rgba(239,68,68,.3)':''}">
          ${(ss ? !ss.canFile : health?.canFile===false) ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;background:rgba(239,68,68,.1);border-bottom:1px solid rgba(239,68,68,.2);margin:-1px -1px 0;border-radius:12px 12px 0 0">
            <span style="font-size:12px">🚫</span>
            <span style="font-size:11px;font-weight:700;color:#f87171;letter-spacing:.06em;text-transform:uppercase">UTKAST — EJ REDO FÖR INLÄMNING</span>
          </div>` : ''}
          <div class="tax-rh-year">${S.taxYear}</div>
          <div class="tax-rh-title">Sammanfattning — Inkomstdeklaration 1</div>
          <div class="tax-rh-grid">
            <div class="tax-rh-item">
              <div class="tax-rh-label">Summa vinst (K4 Sektion D)</div>
              <div class="tax-rh-label-sub">→ Ruta 7.5 i deklarationen</div>
              <div class="tax-rh-val tax-green">${TaxEngine.formatSEK(k4.totalGains)}</div>
              <div style="margin-top:4px;font-size:10px;color:#4ade80;line-height:1.4">
                ✓ Endast verifierade rader — ${k4.k4DisposalCount || 0} avyttringar
              </div>
              ${k4.excludedCount > 0 ? `
              <div style="margin-top:2px;font-size:10px;color:#fbbf24">
                ${k4.excludedCount} rad${k4.excludedCount !== 1 ? 'er' : ''} exkluderade → Granskning
              </div>` : ''}
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
              <div class="tax-rh-val">${TaxEngine.formatSEK(k4TaxableGain)}</div>
            </div>
          </div>
          <div class="tax-rh-tax-est" style="${health?.canFile===false?'opacity:.45':''}">
            <span class="tax-rh-tax-label">Beräknad skatt (30%)</span>
            <span class="tax-rh-tax-val">${TaxEngine.formatSEK(k4EstimatedTax)}</span>
            ${health?.canFile===false ? `<span style="display:block;font-size:10px;color:#f87171;margin-top:2px">⚠️ troligen felaktig — åtgärda K4-blockerare</span>` : ''}
          </div>
          ${k4RowCount > 0 ? (() => {
            const k4Proceeds = k4.k4Rows.reduce((s,r) => s + (r.proceeds || 0), 0);
            const k4Cost     = k4.k4Rows.reduce((s,r) => s + (r.cost    || 0), 0);
            return `
          <div class="tax-rh-detail-row">
            <span>Totalt försäljningspris (K4): <strong>${TaxEngine.formatSEK(k4Proceeds)}</strong></span>
            <span>Totalt omkostnadsbelopp (K4): <strong>${TaxEngine.formatSEK(k4Cost)}</strong></span>
            <span>K4-avyttringar: <strong>${k4RowCount} st</strong> ${excCount > 0 ? `· <span style="color:#f59e0b">${excCount} exkluderade</span>` : ''}</span>
          </div>`;
          })() : ''}

          <!-- Debug panel: always visible, remove when numbers confirmed correct -->
          <details style="margin-top:8px;font-size:10px;color:#64748b;border-top:1px solid rgba(255,255,255,.06);padding-top:6px">
            <summary style="cursor:pointer;font-size:10px;color:#475569">🔍 K4-summering debug</summary>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;margin-top:6px;font-family:monospace">
              <span>k4TotalGains: <strong style="color:#4ade80">${TaxEngine.formatSEK(k4Gains)}</strong></span>
              <span>k4TotalLosses: <strong style="color:#f87171">${TaxEngine.formatSEK(k4Losses)}</strong></span>
              <span>deductibleLoss: <strong style="color:#fbbf24">${TaxEngine.formatSEK(deductibleLoss)}</strong></span>
              <span>k4TaxableGain: <strong style="color:#e2e8f0">${TaxEngine.formatSEK(k4TaxableGain)}</strong></span>
              <span>k4EstimatedTax: <strong style="color:#e2e8f0">${TaxEngine.formatSEK(k4EstimatedTax)}</strong></span>
              <span>k4 rows: <strong>${k4RowCount}</strong> · excluded: <strong style="color:#f59e0b">${excCount}</strong></span>
              <span style="grid-column:1/-1;color:#334155">source: summary.k4TotalGains=${TaxEngine.formatSEK(summary.k4TotalGains||0)} k4TotalLosses=${TaxEngine.formatSEK(summary.k4TotalLosses||0)} taxableGain=${TaxEngine.formatSEK(summary.taxableGain||0)}</span>
            </div>
          </details>
        </div>

        <!-- Airdrop income panel — shown when there are real airdrops in scope -->
        ${adTotal > 0 ? `
        <div class="tax-section" style="margin-bottom:16px;border:1px solid rgba(167,139,250,.2);background:rgba(167,139,250,.04)">
          <div class="tax-section-header" style="margin-bottom:10px">
            <h2 style="font-size:14px">📬 Airdrop-inkomster — Inkomstdeklaration</h2>
            <span class="tax-badge" style="background:rgba(167,139,250,.15);color:#a78bfa;font-size:10px">Skatteverket: inkomst vid mottagning</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px">
            <div style="padding:10px 12px;background:rgba(167,139,250,.07);border:1px solid rgba(167,139,250,.15);border-radius:8px">
              <div style="font-size:10px;color:#a78bfa;font-weight:600;margin-bottom:4px">📬 TOTALT FMV VID MOTTAGNING</div>
              <div style="font-size:18px;font-weight:700;color:#e2e8f0">${TaxEngine.formatSEK(adValueSEK)}</div>
              <div style="font-size:10px;color:#64748b;margin-top:2px">${adTotal} airdrop${adTotal !== 1 ? 's' : ''} (exkl. spam)</div>
            </div>
            ${adClaimed > 0 ? `
            <div style="padding:10px 12px;background:rgba(74,222,128,.06);border:1px solid rgba(74,222,128,.15);border-radius:8px">
              <div style="font-size:10px;color:#4ade80;font-weight:600;margin-bottom:4px">✅ CLAIMADE AIRDROPS</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${adClaimed} st</div>
              <div style="font-size:10px;color:#64748b;margin-top:2px">Aktivt claimade — hög konfidens</div>
            </div>` : ''}
            ${adUnsol > 0 ? `
            <div style="padding:10px 12px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.15);border-radius:8px">
              <div style="font-size:10px;color:#fbbf24;font-weight:600;margin-bottom:4px">📩 OÖNSKADE AIRDROPS</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${adUnsol} st</div>
              <div style="font-size:10px;color:#64748b;margin-top:2px">Mottagna utan åtgärd — verifiera</div>
            </div>` : ''}
          </div>
          <div style="font-size:11px;color:#64748b;line-height:1.6;padding:8px 10px;background:rgba(0,0,0,.2);border-radius:6px">
            <strong style="color:#94a3b8">Skatteverket:</strong> Airdrops beskattas som inkomst av kapital i år då de mottas.
            FMV vid mottagning = kostnadsbas vid framtida avyttring.
            Spam-airdrops (utan marknadsvärde) exkluderas automatiskt.
            <span style="color:#a78bfa">Kontrollera airdrop-historiken i per-tillgång-granskningsloggen (klicka på tillgångssymbol i portföljvyn).</span>
          </div>
        </div>` : ''}

        <!-- Confidence breakdown panel -->
        ${(() => {
          const gainRows = k4.k4Rows.filter(r => r.side === 'gain');
          const exactGain    = gainRows.filter(r => r.confidence === 'exact')    .reduce((s,r) => s+r.gain, 0);
          const estimatedGain= gainRows.filter(r => r.confidence === 'estimated').reduce((s,r) => s+r.gain, 0);
          const unknownGain  = gainRows.filter(r => r.confidence === 'unknown')  .reduce((s,r) => s+r.gain, 0);
          const zeroCostGain = gainRows.filter(r => r.confidence === 'zero_cost').reduce((s,r) => s+r.gain, 0);
          const totalGain    = k4.totalGains;
          if (totalGain <= 0) return '';
          const pct = v => totalGain > 0 ? Math.round((v/totalGain)*100) : 0;
          const bar = (v, color) => v > 0 ? `<div style="height:6px;background:${color};border-radius:3px;width:${pct(v)}%;min-width:${v>0?'4px':'0'};transition:width .3s"></div>` : '';
          // Top uncertain rows (highest gain, non-exact confidence) for drill-down
          const topUncertain = gainRows.filter(r => r.confidence !== 'exact' && r.gain > 50000)
            .sort((a,b) => b.gain - a.gain).slice(0, 6);
          return `
        <div class="tax-section" style="margin-bottom:16px">
          <div class="tax-section-header" style="margin-bottom:10px">
            <h2 style="font-size:14px">📊 Tillförlitlighetsanalys — Realiserade vinster</h2>
            <span class="tax-badge" style="background:rgba(148,163,184,.1);color:#94a3b8;font-size:10px">Totalt: ${TaxEngine.formatSEK(totalGain)}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:${topUncertain.length>0?'14px':'0'}">
            ${exactGain > 0 ? `<div style="padding:10px 12px;background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);border-radius:8px">
              <div style="font-size:10px;color:#4ade80;font-weight:600;margin-bottom:4px">✓ EXAKT (swap-implied)</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${TaxEngine.formatSEK(exactGain)}</div>
              <div style="font-size:10px;color:var(--tax-muted);margin-top:2px">${pct(exactGain)}% av total vinst · K4-redo ✓</div>
              <div style="margin-top:6px;background:rgba(34,197,94,.15);border-radius:2px;height:6px">${bar(exactGain,'#4ade80')}</div>
            </div>` : ''}
            ${estimatedGain > 0 ? `<div style="padding:10px 12px;background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.2);border-radius:8px">
              <div style="font-size:10px;color:#fbbf24;font-weight:600;margin-bottom:4px">~ UPPSKATTAD (swap-at-cost)</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${TaxEngine.formatSEK(estimatedGain)}</div>
              <div style="font-size:10px;color:var(--tax-muted);margin-top:2px">${pct(estimatedGain)}% av total vinst · verifiera i Granska</div>
              <div style="margin-top:6px;background:rgba(251,191,36,.15);border-radius:2px;height:6px">${bar(estimatedGain,'#fbbf24')}</div>
            </div>` : ''}
            ${unknownGain > 0 ? `<div style="padding:10px 12px;background:rgba(239,68,68,.09);border:1px solid rgba(239,68,68,.3);border-radius:8px">
              <div style="font-size:10px;color:#f87171;font-weight:700;margin-bottom:4px">⚠ OKÄND KOSTNADSBAS</div>
              <div style="font-size:16px;font-weight:700;color:#f87171">${TaxEngine.formatSEK(unknownGain)}</div>
              <div style="font-size:10px;color:var(--tax-muted);margin-top:2px">${pct(unknownGain)}% · K4-blockerare — lägg till köphistorik</div>
              <div style="margin-top:6px;background:rgba(239,68,68,.2);border-radius:2px;height:6px">${bar(unknownGain,'#f87171')}</div>
            </div>` : ''}
            ${zeroCostGain > 0 ? `<div style="padding:10px 12px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:8px">
              <div style="font-size:10px;color:#fca5a5;font-weight:600;margin-bottom:4px">0 NOLLKOSTNAD</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${TaxEngine.formatSEK(zeroCostGain)}</div>
              <div style="font-size:10px;color:var(--tax-muted);margin-top:2px">${pct(zeroCostGain)}% · kostnadsbas 0 kr — kontrollera</div>
              <div style="margin-top:6px;background:rgba(239,68,68,.12);border-radius:2px;height:6px">${bar(zeroCostGain,'#fca5a5')}</div>
            </div>` : ''}
          </div>
          ${topUncertain.length > 0 ? `
          <div style="font-size:11px;font-weight:600;color:var(--tax-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em">Högst vinst med osäker prissättning</div>
          <div style="display:flex;flex-direction:column;gap:4px">
            ${topUncertain.map(r => {
              const confLabel = r.confidence === 'unknown' ? '⚠ Okänd kostnadsbas' : r.confidence === 'zero_cost' ? '0 Nollkostnad' : '~ Uppskattad';
              const confColor = r.confidence === 'unknown' ? '#f87171' : r.confidence === 'zero_cost' ? '#fca5a5' : '#fbbf24';
              const confBg    = r.confidence === 'unknown' ? 'rgba(239,68,68,.12)' : r.confidence === 'zero_cost' ? 'rgba(239,68,68,.08)' : 'rgba(251,191,36,.12)';
              return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,.02);border:1px solid var(--tax-border);border-radius:6px;flex-wrap:wrap">
                <span class="tax-mono" style="font-size:11px;color:var(--tax-muted);min-width:70px">${r.sym}</span>
                <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:${confBg};color:${confColor}">${confLabel}</span>
                <span style="flex:1;font-size:10px;color:var(--tax-muted)">${r.displayName !== r.sym ? r.displayName : ''}</span>
                <span style="font-size:12px;font-weight:600;color:#f87171">${TaxEngine.formatSEK(r.gain)}</span>
                <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.filterTxsByAsset('${r.sym}')" style="font-size:10px;padding:2px 6px">📋 Visa txn</button>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>`;
        })()}

        <!-- Suspicious zero-cost rows panel -->
        ${(() => {
          const suspicious = k4.suspiciousZeroCost || [];
          if (suspicious.length === 0) return '';
          const totalPhantom = suspicious.reduce((s, d) => s + d.proceedsSEK, 0);
          // Group by symbol
          const bySymbol = {};
          for (const d of suspicious) {
            const sym = d.assetSymbol;
            if (!bySymbol[sym]) bySymbol[sym] = { sym, count: 0, totalProc: 0, reason: null, dbg: null };
            bySymbol[sym].count++;
            bySymbol[sym].totalProc += d.proceedsSEK;
            bySymbol[sym].reason = d.zeroCostReason;
            bySymbol[sym].dbg = d.acquisitionDebug;
          }
          const symRows = Object.values(bySymbol).sort((a, b) => b.totalProc - a.totalProc).slice(0, 10);
          return `
        <div class="tax-section" style="margin-bottom:16px;border-color:rgba(239,68,68,.35)">
          <div class="tax-section-header" style="margin-bottom:10px">
            <h2 style="font-size:14px;color:#f87171">🔍 Oklara nollkostnadsrader — kräver granskning</h2>
            <span class="tax-badge" style="background:rgba(239,68,68,.12);color:#f87171">${suspicious.length} rad${suspicious.length !== 1 ? 'er' : ''} · ${TaxEngine.formatSEK(totalPhantom)} i oklara intäkter</span>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-bottom:10px;line-height:1.6">
            Dessa avyttringar har <strong style="color:#f87171">kostnadsbas 0 kr</strong> och <strong style="color:#f87171">okänd anskaffning</strong>.
            De ska INTE ingå i slutsiffran förrän anskaffningskällan är identifierad och importerad.
            Möjliga orsaker: köp på oimporterad exchange · erhållen via oimporterad wallet · bridgad från annan kedja.
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            ${symRows.map(row => {
              const dbgReason = row.dbg?.reason || '';
              const reasonLabel = row.reason === 'acquisition_missing' ? '⛔ Ingen anskaffning hittad'
                : row.reason === 'acquisition_partial' ? '⚠ Ofullständig historik'
                : '❓ Okänd';
              const reasonColor = row.reason === 'acquisition_missing' ? '#f87171' : '#fbbf24';
              return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.18);border-radius:6px;flex-wrap:wrap">
                <span class="tax-mono" style="font-size:12px;color:#e2e8f0;font-weight:600;min-width:80px">${row.sym}</span>
                <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(239,68,68,.15);color:${reasonColor}">${reasonLabel}</span>
                ${dbgReason ? `<span style="font-size:10px;color:#64748b;flex:1">${dbgReason}</span>` : '<span style="flex:1"></span>'}
                ${row.count > 1 ? `<span style="font-size:10px;color:#64748b">${row.count} transaktioner</span>` : ''}
                <span style="font-size:12px;font-weight:700;color:#f87171">${TaxEngine.formatSEK(row.totalProc)}</span>
                <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.filterTxsByAsset('${row.sym}')" style="font-size:10px;padding:2px 6px">📋 Visa</button>
              </div>`;
            }).join('')}
          </div>
          ${suspicious.length > 10 ? `<div style="font-size:10px;color:#64748b;margin-top:6px;text-align:center">… och ${suspicious.length - 10} fler rader</div>` : ''}
          <div style="margin-top:10px;padding:8px 12px;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.2);border-radius:6px;font-size:11px;color:#94a3b8">
            <strong style="color:#818cf8">Hur åtgärdar du detta?</strong>
            Gå till <button class="tax-btn tax-btn-xs" style="font-size:10px;padding:1px 6px;margin:0 2px" onclick="TaxUI.navigate('accounts')">Konton</button>
            och lägg till den exchange eller wallet där dessa tokens ursprungligen köptes.
            Motorn matchar transaktionerna automatiskt när historiken importerats.
          </div>
        </div>`;
        })()}

        <!-- ── Volume ≠ Income clarification banner ─────────────────────── -->
        ${(() => {
          const estVol = excEstimated.reduce((s, d) => s + (d.proceedsSEK || 0), 0);
          if (estVol < 50_000) return '';
          const estNetGL = excEstimated.reduce((s, d) => s + ((d.proceedsSEK || 0) - (d.costBasisSEK || 0)), 0);
          return `
        <div style="margin-bottom:14px;padding:12px 16px;border-radius:10px;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.2)">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="font-size:18px;flex-shrink:0">💡</span>
            <div>
              <div style="font-size:12px;font-weight:700;color:#818cf8;margin-bottom:4px">De stora siffrorna är handelsvolym — inte inkomst</div>
              <div style="font-size:11px;color:#94a3b8;line-height:1.6">
                ${excEstimated.length} avyttringar med uppskattade priser visar ett <strong style="color:#e2e8f0">försäljningspris på ${TaxEngine.formatSEK(estVol)}</strong>.
                Det är total handelsvolym — inte skattemässig inkomst.
                Vinsten beräknas som försäljningspris <em>minus</em> anskaffningsvärde.
                Uppskattad nettovinst/-förlust på dessa rader: <strong style="${estNetGL >= 0 ? 'color:#4ade80' : 'color:#f87171'}">${estNetGL >= 0 ? '+' : ''}${TaxEngine.formatSEK(estNetGL)}</strong>.
              </div>
              <div style="margin-top:6px;font-size:10px;color:#475569">
                Dessa rader är <strong>exkluderade från K4</strong> pga uppskattade (ej verifierade) priser — de ingår inte i din deklaration.
              </div>
            </div>
          </div>
        </div>`;
        })()}

        <!-- Confidence score widget — reads from computeStatusSummary (single source of truth) -->
        ${ss ? (() => {
          const score      = ss.taxConfidencePct;
          const scoreColor = score >= 90 ? '#4ade80' : score >= 70 ? '#fbbf24' : '#f87171';
          const scoreLabel = score >= 90 ? 'Hög — rapporten är tillförlitlig'
            : score >= 70 ? 'Medel — åtgärda blockerare' : 'Låg — åtgärd krävs';
          const hardCount  = ss.hardBlockerCount;
          const revCount   = ss.reviewRecommendedCount;
          const infoCount  = ss.informationalCount;
          const autoCount  = ss.autoResolvableCount;
          // ── Status model clarity note ──
          // hardBlockerCount: rows that prevent the current K4 export from being valid
          // reviewRecommendedCount: excluded rows that do NOT block the export (optional fix)
          // informationalCount: already handled rows worth monitoring
          const totalDenominator = ss.verifiedRows + hardCount + revCount;
          if (totalDenominator === 0) return '';
          return `
        <div style="margin-bottom:14px;padding:12px 16px;border-radius:10px;background:rgba(15,23,42,.4);border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <details style="cursor:pointer">
            <summary style="list-style:none;display:flex;flex-direction:column">
              <div style="font-size:10px;color:#475569;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px">Skattekonfidens</div>
              <div style="font-size:28px;font-weight:800;color:${scoreColor};line-height:1">${score}%<span style="font-size:10px;color:#475569;margin-left:4px;font-weight:400">▾</span></div>
              <div style="font-size:10px;color:${scoreColor};margin-top:2px">${scoreLabel}</div>
            </summary>
            <div style="margin-top:8px;padding:8px 10px;background:rgba(15,23,42,.6);border-radius:6px;border:1px solid rgba(255,255,255,.05)">
              <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">📊 Beräkning</div>
              ${(ss.confidenceExplanation || []).map(line => `<div style="font-size:10px;color:#94a3b8;line-height:1.6;font-family:monospace">${line}</div>`).join('')}
            </div>
          </details>
          <div style="flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;min-width:220px">
            <div style="padding:6px 10px;border-radius:6px;background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.15)">
              <div style="font-size:9px;color:#4ade80;font-weight:600;margin-bottom:2px">✓ VERIFIERADE</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${ss.verifiedRows}</div>
              <div style="font-size:9px;color:#475569">K4-klara avyttringar</div>
            </div>
            <div style="padding:6px 10px;border-radius:6px;background:${hardCount > 0 ? 'rgba(239,68,68,.07)' : 'rgba(74,222,128,.04)'};border:1px solid ${hardCount > 0 ? 'rgba(239,68,68,.2)' : 'rgba(74,222,128,.1)'}">
              <div style="font-size:9px;color:${hardCount > 0 ? '#f87171' : '#4ade80'};font-weight:600;margin-bottom:2px">${hardCount > 0 ? '⛔ HÅRDA BLOCKERARE' : '✓ INGA BLOCKERARE'}</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${hardCount}</div>
              <div style="font-size:9px;color:#475569">blockerar aktuell export</div>
            </div>
            <div style="padding:6px 10px;border-radius:6px;background:rgba(96,165,250,.05);border:1px solid rgba(96,165,250,.15)">
              <div style="font-size:9px;color:#60a5fa;font-weight:600;margin-bottom:2px">🟡 VALFRI GRANSKNING</div>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0">${revCount}</div>
              <div style="font-size:9px;color:#475569">exkl. rader — blockerar ej</div>
            </div>
          </div>
          ${autoCount > 0 ? `
          <div style="width:100%;margin-top:4px;font-size:11px;color:#60a5fa;padding:6px 10px;background:rgba(96,165,250,.06);border-radius:6px;border:1px solid rgba(96,165,250,.15)">
            ✨ ${autoCount} rad${autoCount !== 1 ? 'er' : ''} kan lösas automatiskt — klicka "Auto-lös säkra" under Granska
          </div>` : ''}
        </div>`;
        })() : ''}

        <!-- Excluded from K4 panel — three-tier severity architecture -->
        ${(() => {
          const totalExc = (k4.excludedCount || 0);
          if (!totalExc) return '';

          // ── Shared row renderer ─────────────────────────────────────────
          const renderDisposalRow = (d) => {
            const gl = d.gainLossSEK;
            const sanFlags = (d.sanityFlags || []);
            const resNote = d.resolutionNote || '';
            const resConf = d.resolutionConfidence || '';
            const confColor = resConf === 'high' ? '#4ade80' : resConf === 'medium' ? '#fbbf24' : '#f87171';
            return `
            <div style="display:flex;flex-direction:column;gap:3px;padding:5px 8px;background:rgba(15,23,42,.4);border-radius:5px;font-size:10px">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="tax-mono" style="font-weight:600;color:#e2e8f0;min-width:70px">${d.assetSymbol}</span>
                <span style="color:#475569">${(d.date||'').slice(0,10)}</span>
                <span style="color:#64748b;flex:1">${TaxEngine.formatCrypto(d.amountSold, 4)} avyttrat</span>
                ${d.proceedsSEK != null ? `<span style="color:#94a3b8">${d.excludeFromK4 ? 'Uppskattat värde' : 'Försäljningspris'}: ${TaxEngine.formatSEK(d.proceedsSEK)}</span>` : '<span style="color:#f87171">Pris: okänt</span>'}
                ${d.costBasisSEK != null ? `<span style="color:#64748b">KB: ${TaxEngine.formatSEK(d.costBasisSEK)}</span>` : '<span style="color:#f87171">KB: saknas</span>'}
                ${gl != null ? `<span style="${gl >= 0 ? 'color:#4ade80' : 'color:#f87171'}">${gl >= 0 ? '+' : ''}${TaxEngine.formatSEK(gl)}</span>` : ''}
                ${resConf ? `<span style="font-size:8px;padding:1px 4px;border-radius:2px;background:rgba(15,23,42,.5);color:${confColor}" title="Återställningskonfidens">${resConf}</span>` : ''}
                ${sanFlags.map(f => `<span style="padding:1px 5px;border-radius:3px;background:rgba(249,115,22,.12);color:#f97316;font-size:9px;font-family:monospace" title="${f}">${f.split(':')[0]}</span>`).join('')}
                <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.openAssetAudit('${d.assetSymbol}')" style="padding:1px 5px" title="Granska ${d.assetSymbol}">🔍</button>
                <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.editTx('${d.id}')" style="padding:1px 5px">✏️</button>
              </div>
              ${resNote ? `<div style="font-size:9px;color:#64748b;line-height:1.4;padding-left:2px">💡 ${resNote}</div>` : ''}
            </div>`;
          };

          // ── Group renderer ──────────────────────────────────────────────
          const renderGroup = ({ rows, icon, color, bg, border, label, maxRows = 8, bulkBtn = '', volumeLabel = false }) => {
            if (!rows?.length) return '';
            const totalProc = rows.reduce((s, d) => s + (d.proceedsSEK || 0), 0);
            const show = rows.slice(0, maxRows);
            const volLabel = totalProc > 0
              ? `<span style="font-size:10px;color:${color};font-weight:600">${TaxEngine.formatSEK(totalProc)} ${volumeLabel ? 'handelsvolym' : 'försäljningspris'}</span>`
              : '';
            return `
            <details style="margin-bottom:5px">
              <summary style="cursor:pointer;padding:7px 10px;border-radius:6px;background:${bg};border:1px solid ${border};display:flex;align-items:center;gap:8px;list-style:none;user-select:none;flex-wrap:wrap">
                <span style="font-size:13px">${icon}</span>
                <span style="flex:1;font-size:11px;font-weight:600;color:${color}">${label}</span>
                <span style="font-size:10px;color:${color};opacity:.8">${rows.length} rad${rows.length !== 1 ? 'er' : ''}</span>
                ${volLabel}
                ${bulkBtn}
                <span style="font-size:10px;color:#475569">▾</span>
              </summary>
              <div style="display:flex;flex-direction:column;gap:3px;margin-top:4px;padding-left:4px">
                ${show.map(renderDisposalRow).join('')}
                ${rows.length > maxRows ? `<div style="font-size:10px;color:#475569;text-align:center;padding:4px">… och ${rows.length - maxRows} fler rader</div>` : ''}
              </div>
            </details>`;
          };

          // ── Severity tier renderer ──────────────────────────────────────
          const renderTier = ({ icon, label, color, bg, border, description, rows, children }) => {
            const count = rows ? rows.length : (children || []).reduce((s, r) => s + r.length, 0);
            if (!count) return '';
            return `
            <div style="margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <span style="font-size:14px">${icon}</span>
                <span style="font-size:12px;font-weight:700;color:${color}">${label}</span>
                <span style="font-size:10px;padding:1px 7px;border-radius:10px;background:${bg};border:1px solid ${border};color:${color}">${count} rader</span>
              </div>
              ${description ? `<div style="font-size:10px;color:#475569;margin-bottom:6px;padding-left:22px;line-height:1.5">${description}</div>` : ''}
            </div>`;
          };

          // ── Bucket computations ─────────────────────────────────────────
          const criticalRows   = [...excManual, ...excMissing, ...excBlocked, ...excSanity];
          const reviewRows     = [...excSpamCand, ...excAirdropCand, ...excTransfer, ...excOpenBal];
          const infoRows       = [...excEstimated, ...excUnknownId, ...excNoise];
          const autoSolvable   = excSpamCand.length + excAirdropCand.length;
          const excSanityGain2 = excSanity.reduce((s, d) => s + (d.gainLossSEK || 0), 0);

          return `
        <div class="tax-section" style="margin-bottom:16px;border-color:rgba(99,102,241,.2)">
          <div class="tax-section-header" style="margin-bottom:8px">
            <h2 style="font-size:14px;color:#818cf8">🔒 Exkluderade från K4 — ${totalExc} rad${totalExc !== 1 ? 'er' : ''}</h2>
            <span class="tax-badge" style="background:rgba(99,102,241,.1);color:#818cf8">Ej deklarerade</span>
          </div>
          <div style="font-size:11px;color:#475569;margin-bottom:12px;line-height:1.6">
            Dessa rader uppfyller inte K4-kriterierna och ingår <strong style="color:#818cf8">inte</strong> i din deklaration.
            De är uppdelade efter allvarlighetsgrad nedan.
          </div>

          <!-- ────── 🔴 TIER 1: CRITICAL ────── -->
          ${criticalRows.length > 0 ? `
          <div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.25)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <span style="font-size:14px">🔴</span>
              <span style="font-size:12px;font-weight:700;color:#f87171">K4-blockerare — kräver åtgärd</span>
              <span style="font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#f87171">${criticalRows.length} rader</span>
              <button class="tax-btn tax-btn-xs" style="margin-left:auto;color:#f87171;border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.08)" onclick="TaxUI.navigate('review')">Åtgärda i Granskning →</button>
            </div>
            <div style="font-size:10px;color:#64748b;margin-bottom:8px">
              Dessa rader blockerar din K4-deklaration och måste åtgärdas.
              De kan ha stor påverkan på din redovisade vinst.
            </div>
            ${renderGroup({ rows: excManual,   icon: '⛔', color: '#f87171', bg: 'rgba(239,68,68,.05)',  border: 'rgba(239,68,68,.2)',  label: 'Manuell granskning krävs — okänd anskaffning' })}
            ${renderGroup({ rows: excMissing,  icon: '❓',  color: '#f87171', bg: 'rgba(239,68,68,.04)',  border: 'rgba(239,68,68,.18)', label: 'Okänd anskaffningskälla — oklassificerad' })}
            ${renderGroup({ rows: excBlocked,  icon: '🚫',  color: '#f87171', bg: 'rgba(239,68,68,.04)',  border: 'rgba(239,68,68,.18)', label: 'Blockerad — orimlig eller korrupt data' })}
            ${excSanity.length > 0 ? `
            <details style="margin-bottom:5px">
              <summary style="cursor:pointer;padding:7px 10px;border-radius:6px;background:rgba(249,115,22,.06);border:1px solid rgba(249,115,22,.25);display:flex;align-items:center;gap:8px;list-style:none;user-select:none;flex-wrap:wrap">
                <span style="font-size:13px">🔎</span>
                <span style="flex:1;font-size:11px;font-weight:600;color:#f97316">Sanitetskontroll — misstänkta siffror</span>
                <span style="font-size:10px;color:#f97316;opacity:.8">${excSanity.length} rader</span>
                <span style="font-size:10px;color:#f97316;font-weight:600">Potentiell vinst/förlust: ${TaxEngine.formatSEK(excSanityGain2)}</span>
                <span style="font-size:10px;color:#475569">▾</span>
              </summary>
              <div style="display:flex;flex-direction:column;gap:3px;margin-top:4px;padding-left:4px">
                <div style="font-size:10px;color:#64748b;padding:4px 8px;line-height:1.5">
                  Intäkt/kostnad-förhållanden som inte kan bekräftas utan sekundär referens.
                  Bekräfta i <button class="tax-btn tax-btn-xs" onclick="TaxUI.navigate('review')" style="font-size:10px;padding:1px 5px">Granskning</button>.
                </div>
                ${excSanity.slice(0,8).map(renderDisposalRow).join('')}
                ${excSanity.length > 8 ? `<div style="font-size:10px;color:#475569;text-align:center;padding:4px">… och ${excSanity.length - 8} fler</div>` : ''}
              </div>
            </details>` : ''}
          </div>` : `
          <div style="margin-bottom:12px;padding:8px 12px;border-radius:8px;background:rgba(74,222,128,.05);border:1px solid rgba(74,222,128,.2);display:flex;align-items:center;gap:8px">
            <span style="font-size:14px">✅</span>
            <span style="font-size:11px;color:#4ade80;font-weight:600">Inga hårda blockerare — de verifierade K4-raderna kan exporteras</span>
          </div>`}

          <!-- ────── 🟡 TIER 2: REVIEW RECOMMENDED ────── -->
          ${reviewRows.length > 0 ? `
          <div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:rgba(251,191,36,.04);border:1px solid rgba(251,191,36,.2)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <span style="font-size:14px">🟡</span>
              <span style="font-size:12px;font-weight:700;color:#fbbf24">Granskning rekommenderas — inte fatalt</span>
              <span style="font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.25);color:#fbbf24">${reviewRows.length} rader</span>
              ${autoSolvable > 0 ? `
              <button class="tax-btn tax-btn-xs" style="margin-left:auto;color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.07);font-weight:600" onclick="TaxUI.autoResolveAll()" title="Lös spam + klassificera airdrops automatiskt">⚡ Auto-lösa ${autoSolvable} rader (${excSpamCand.length} spam + ${excAirdropCand.length} airdrops)</button>` : ''}
            </div>
            <div style="font-size:10px;color:#64748b;margin-bottom:8px">
              Motorn har identifierat möjliga lösningar. Dessa blockerar <em>inte</em> din K4 men bör bekräftas för bästa resultat.
            </div>
            ${renderGroup({ rows: excSpamCand, icon: '🗑️', color: '#94a3b8', bg: 'rgba(148,163,184,.05)', border: 'rgba(148,163,184,.2)', label: 'Möjlig spam — kan automatiskt lösas med 0 kr kostnadsbas',
              bulkBtn: excSpamCand.length > 0 ? `<button class="tax-btn tax-btn-xs" style="background:rgba(148,163,184,.12);color:#94a3b8;border:1px solid rgba(148,163,184,.2)" onclick="TaxUI.bulkResolveSpamCandidates()">🗑️ Lös alla spam (${excSpamCand.length})</button>` : '' })}
            ${renderGroup({ rows: excAirdropCand, icon: '📬', color: '#fbbf24', bg: 'rgba(251,191,36,.05)', border: 'rgba(251,191,36,.2)', label: 'Möjlig airdrop — mottagning utan köp, FMV som kostnadsbas',
              bulkBtn: excAirdropCand.length > 0 ? `<button class="tax-btn tax-btn-xs" style="background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.2)" onclick="TaxUI.bulkResolveAirdropCandidates()">📬 Klassificera som airdrops (${excAirdropCand.length})</button>` : '' })}
            ${renderGroup({ rows: excTransfer, icon: '🔄', color: '#38bdf8', bg: 'rgba(56,189,248,.05)', border: 'rgba(56,189,248,.2)', label: 'Möjlig intern transfer — importera källkontot',
              bulkBtn: `<button class="tax-btn tax-btn-xs" style="background:rgba(56,189,248,.1);color:#38bdf8;border:1px solid rgba(56,189,248,.2)" onclick="TaxUI.navigate('accounts')">➕ Importera källkontot</button>` })}
            ${renderGroup({ rows: excOpenBal, icon: '📅', color: '#a78bfa', bg: 'rgba(167,139,250,.05)', border: 'rgba(167,139,250,.2)', label: 'Möjligt öppningssaldo — token ägdes troligen före import',
              bulkBtn: excOpenBal.length > 0 ? `<button class="tax-btn tax-btn-xs" style="background:rgba(167,139,250,.1);color:#a78bfa;border:1px solid rgba(167,139,250,.2)" onclick="TaxUI.bulkCreateOpeningBalances()">📅 Skapa öppningssaldon (${excOpenBal.length})</button>` : '' })}
          </div>` : ''}

          <!-- ────── 🔵 TIER 3: INFORMATIONAL ────── -->
          ${infoRows.length > 0 ? `
          <div style="margin-bottom:8px;padding:10px 12px;border-radius:8px;background:rgba(99,102,241,.04);border:1px solid rgba(99,102,241,.15)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <span style="font-size:14px">🔵</span>
              <span style="font-size:12px;font-weight:700;color:#818cf8">Information — ingen omedelbar åtgärd krävs</span>
              <span style="font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.2);color:#818cf8">${infoRows.length} rader</span>
            </div>
            <div style="font-size:10px;color:#64748b;margin-bottom:8px">
              Uppskattade priser och brus. Dessa påverkar <strong>inte din K4</strong> — de är redan exkluderade.
              Handelsvolym är inte detsamma som inkomst.
            </div>
            ${renderGroup({ rows: excEstimated, icon: '⚠', color: '#fbbf24', bg: 'rgba(251,191,36,.04)', border: 'rgba(251,191,36,.15)',
              label: `Uppskattade priser — ${excEstimated.length} avyttringar med ej verifierat pris`, volumeLabel: true })}
            ${renderGroup({ rows: excUnknownId, icon: '❓', color: '#94a3b8', bg: 'rgba(148,163,184,.04)', border: 'rgba(148,163,184,.15)', label: 'Okänd tillgångsidentitet' })}
            ${renderGroup({ rows: excNoise,     icon: '🔇', color: '#475569', bg: 'rgba(71,85,105,.04)',  border: 'rgba(71,85,105,.15)',  label: 'Brus / dust / interna transfers' })}
          </div>` : ''}
        </div>`;
        })()}

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
                  <th style="min-width:90px">Tillförlitlighet</th>
                </tr></thead>
                <tbody>
                  ${k4.k4Rows.map((r, i) => {
                    const rowId = `k4r-${i}`;
                    // Build "why does this gain/loss exist" explanation from the disposals
                    const rowDisposals = disposals.filter(d => d.assetSymbol === r.sym && d.valuationStatus === 'final' && !d.excludeFromK4);
                    const firstD = rowDisposals[0];
                    const whyLines = [];
                    if (firstD) {
                      const evtMap = { trade:'Byte/swap', sell:'Försäljning', send:'Skickad',
                        transfer_out:'Transfer ut', bridge_out:'Bridge ut' };
                      whyLines.push(`<strong>Händelsetyp:</strong> ${(firstD.eventType && evtMap[firstD.eventType]) || 'Avyttring'}`);
                      // Proceeds source explanation
                      if (firstD.proceedsExplanation) whyLines.push(`<strong>Intäktskälla:</strong> ${firstD.proceedsExplanation}`);
                      else if (firstD.proceedsSource) whyLines.push(`<strong>Intäktskälla:</strong> ${firstD.proceedsSource}`);
                      else if (firstD.priceSource) whyLines.push(`<strong>Priskälla:</strong> ${firstD.priceSource}`);
                      // Basis explanation
                      if (firstD.basisExplanation) whyLines.push(`<strong>Kostnadsbas:</strong> ${firstD.basisExplanation}`);
                      else if (firstD.avgCostAtSale > 0) whyLines.push(`<strong>Snittpris vid försäljning:</strong> ${TaxEngine.formatSEK(firstD.avgCostAtSale)}/st`);
                      // Price source explanation
                      if (firstD.sourceExplanation) whyLines.push(`<strong>Priskälla:</strong> ${firstD.sourceExplanation}`);
                      // Tx hash with explorer link
                      if (firstD.txHash && !firstD.txHash.startsWith('manual_')) {
                        const solLink = `https://solscan.io/tx/${firstD.txHash}`;
                        whyLines.push(`<strong>Tx:</strong> <a href="${solLink}" target="_blank" rel="noopener" style="color:#818cf8">${firstD.txHash.slice(0,12)}…</a>`);
                      }
                      whyLines.push(`${rowDisposals.length} avyttring${rowDisposals.length !== 1 ? 'ar' : ''} aggregerade`);
                      if (r.cost > 0 && r.proc > 0) {
                        const costPerUnit = r.cost / r.qty;
                        const procPerUnit = r.proc / r.qty;
                        whyLines.push(`KB/st: ${TaxEngine.formatSEK(costPerUnit)} · Intäkt/st: ${TaxEngine.formatSEK(procPerUnit)}`);
                      }
                    }
                    return `
                    <tr class="${(i + 1) % ROWS_PER_K4_FORM === 0 && i !== k4.k4Rows.length - 1 ? 'tax-k4-page-break' : ''}${r.confidence && r.confidence !== 'exact' ? ' tax-k4-row--uncertain' : ''}">
                      <td>
                        <div class="tax-asset-cell" style="gap:4px">
                          <div style="flex:1;min-width:0">
                            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                              <span class="tax-asset-name">${r.displayName || r.sym}</span>
                              <span class="tax-badge" style="${r.side === 'gain' ? 'background:rgba(34,197,94,.1);color:#4ade80' : 'background:rgba(239,68,68,.1);color:#f87171'}">${r.side === 'gain' ? 'Vinst' : 'Förlust'}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:4px;margin-top:2px;flex-wrap:wrap">
                              ${r.contractAddress
                                ? `<a href="https://solscan.io/token/${r.contractAddress}" target="_blank" rel="noopener noreferrer" class="tax-explorer-link" style="font-size:9px;padding:0px 4px" title="View token on Solscan">Solscan ↗</a>
                                   <a href="https://solana.fm/address/${r.contractAddress}" target="_blank" rel="noopener noreferrer" class="tax-explorer-link tax-explorer-link--secondary" style="font-size:9px;padding:0px 4px" title="View on SolanaFM">SolanaFM ↗</a>`
                                : (() => { const mint = TaxEngine.SYM_TO_MINT && TaxEngine.SYM_TO_MINT[r.sym]; return mint ? `<a href="https://solscan.io/token/${mint}" target="_blank" rel="noopener noreferrer" class="tax-explorer-link" style="font-size:9px;padding:0px 4px" title="View token on Solscan">Solscan ↗</a>` : ''; })()
                              }
                              <button class="tax-explorer-icon" style="background:transparent;border:none;cursor:pointer;font-size:10px;color:#64748b" onclick="TaxUI.filterTxsByAsset('${r.sym}')" title="Visa transaktioner för ${r.sym}">📋</button>
                              <button class="tax-explorer-icon" style="background:transparent;border:none;cursor:pointer;font-size:10px;color:#64748b" onclick="TaxUI.openAssetAudit('${r.sym}')" title="Granska historik för ${r.sym}">🔍</button>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td class="ta-r tax-mono">${TaxEngine.formatCrypto(r.qty, 8)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(r.proc)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(r.cost)}</td>
                      <td class="ta-r tax-mono ${r.gain > 0 ? 'tax-green' : ''}">${r.gain ? TaxEngine.formatSEK(r.gain) : ''}</td>
                      <td class="ta-r tax-mono ${r.loss > 0 ? 'tax-red' : ''}">${r.loss ? TaxEngine.formatSEK(r.loss) : ''}</td>
                      <td>
                        <div style="display:flex;flex-direction:column;gap:3px">
                          ${k4ConfBadge(r) || '<span style="font-size:10px;color:var(--tax-muted)">✓ Exakt</span>'}
                          ${k4RowDebugPanel(r)}
                          ${whyLines.length ? `
                          <details style="margin-top:2px">
                            <summary style="font-size:9px;color:#475569;cursor:pointer;list-style:none;user-select:none">Varför? ▾</summary>
                            <div style="margin-top:3px;font-size:9px;color:#64748b;line-height:1.6;padding:4px 6px;background:rgba(0,0,0,.2);border-radius:4px;max-width:220px">
                              ${whyLines.map(l => `<div>${l}</div>`).join('')}
                            </div>
                          </details>` : ''}
                        </div>
                      </td>
                    </tr>`;
                  }).join('')}
                  <tr class="tax-k4-sum-row">
                    <td colspan="5"><strong>Summa</strong></td>
                    <td class="ta-r tax-green"><strong>${TaxEngine.formatSEK(k4.totalGains)}</strong></td>
                    <td class="ta-r tax-red"><strong>${TaxEngine.formatSEK(k4.totalLosses)}</strong></td>
                  </tr>
                  <tr class="tax-k4-net-row">
                    <td colspan="5" style="font-size:11px;color:var(--tax-muted)">
                      Skattepliktig vinst = ${TaxEngine.formatSEK(k4.totalGains)} − (${TaxEngine.formatSEK(k4.totalLosses)} × 70%)
                    </td>
                    <td colspan="2" class="ta-r" style="font-size:12px;font-weight:600;color:#e2e8f0">
                      = ${TaxEngine.formatSEK(k4TaxableGain)}
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

  // Navigate to transactions page with search pre-filtered to a specific asset symbol.
  function filterTxsByAsset(sym) {
    S.txFilter.search = sym;
    S.txPage = 0;
    S.page = 'transactions';
    render();
  }
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
    const txn = TaxEngine.getTransactions().find(t => t.id === id);
    TaxEngine.updateTransaction(id, {
      category: 'spam',
      priceSEKPerUnit: 0, costBasisSEK: 0,
      priceSource: 'missing', priceConfidence: 'spam_zero',
      needsReview: false, reviewReason: 'spam_token', userReviewed: true,
    });
    S.taxResult = null;
    // Check for similar rows and show toast
    if (txn) {
      const similar = findSimilarRows(Object.assign({}, txn, { _reviewReason: 'spam_token' }));
      if (similar.length >= 2) {
        const ids = similar.map(s => (s.txn?.id || s.id)).filter(Boolean);
        showSimilarToast(ids, 'spam', 'spam');
        return; // render called inside showSimilarToast
      }
    }
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

  // ── Auto-recovery bulk action handlers ──────────────────────────────────────
  // Operate on the 5 RT sub-buckets produced by resolveUnknownAcquisitions().
  // Each handler retrieves the relevant disposal rows, maps back to source
  // transaction IDs, and patches the transaction store accordingly.

  /** Helper — re-generate k4 report and return excluded disposals for one bucket. */
  function getRecoveryBucketDisposals(bucketKey) {
    const result = S.taxResult || getOrComputeTaxResult();
    const k4 = TaxEngine.generateK4Report(result);
    return ((k4.excludedByStatus || {})[bucketKey] || []);
  }

  /**
   * Mark all spam_candidate disposals' source transactions as spam (zero value).
   * The disposal's `id` field matches the originating transaction id.
   */
  function bulkResolveSpamCandidates() {
    const disposals = getRecoveryBucketDisposals('spam_candidate');
    if (!disposals.length) {
      showTaxToast('ℹ️', 'Inga spam-kandidater', 'Inga transaktioner att lösa.', 'info');
      return;
    }
    if (!confirm(`Markera ${disposals.length} transaktioner som spam (nollvärde)?\nDe behålls för revision men exkluderas permanent från K4.`)) return;
    const ids = new Set(disposals.map(d => d.id).filter(Boolean));
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
    showTaxToast('🗑️', 'Spam löst', `${disposals.length} transaktioner markerade som spam och exkluderade.`, 'success');
    render();
  }

  /**
   * Reclassify inbound acquisition transactions for airdrop_candidate assets as AIRDROP.
   * Patches RECEIVE / TRANSFER_IN events on the same asset symbol to category='airdrop'.
   */
  function bulkResolveAirdropCandidates() {
    const disposals = getRecoveryBucketDisposals('airdrop_candidate');
    if (!disposals.length) {
      showTaxToast('ℹ️', 'Inga airdrop-kandidater', 'Inga transaktioner att omklassificera.', 'info');
      return;
    }
    if (!confirm(`Omklassificera ${disposals.length} tokens ursprungliga inkomster som AIRDROP?\nKostnadsbas = FMV vid mottagning (om känd). Pipeline måste köras om efteråt.`)) return;
    const allTxns = TaxEngine.getTransactions();
    const affectedSymbols = new Set(disposals.map(d => d.assetSymbol).filter(Boolean));
    let patchCount = 0;
    const updated = allTxns.map(t => {
      if (!affectedSymbols.has(t.assetSymbol)) return t;
      // Only reclassify inbound events
      const cat = (t.category || '').toLowerCase();
      if (!['receive', 'transfer_in', 'airdrop'].includes(cat)) return t;
      patchCount++;
      return { ...t, category: 'airdrop', needsReview: false, userReviewed: true };
    });
    TaxEngine.saveTransactions(updated);
    S.taxResult = null;
    showTaxToast('📬', 'Airdrops klassificerade', `${patchCount} inkomna transaktioner omklassificerade som AIRDROP. Kör pipeline igen för att uppdatera K4.`, 'success');
    render();
  }

  /**
   * Create synthetic BUY transactions (opening balances) for opening_balance_candidate rows.
   * Each synthetic BUY is dated 1 day before the earliest imported transaction.
   * Quantity = disposal quantity; cost basis = disposal cost basis (or 0 if unknown).
   * Rows with 0 cost are flagged needsReview so the user can fill in the actual price.
   */
  function bulkCreateOpeningBalances() {
    const disposals = getRecoveryBucketDisposals('opening_balance_candidate');
    if (!disposals.length) {
      showTaxToast('ℹ️', 'Inga öppningssaldon', 'Inga öppningssaldokandidater hittades.', 'info');
      return;
    }
    if (!confirm(
      `Skapa ${disposals.length} syntetiska köptransaktioner (öppningssaldon)?\n\n` +
      `Dessa representerar innehav som troligen ägdes innan importen startade.\n` +
      `Kostnadsbas = känd anskaffningskostnad eller 0 kr (flaggas för granskning).`
    )) return;

    const allTxns = TaxEngine.getTransactions();
    // Earliest imported date → synthetic purchase is 1 day prior
    const dates = allTxns.map(t => t.date).filter(Boolean).sort();
    const earliest = dates[0] || `${S.taxYear || new Date().getFullYear()}-01-01T00:00:00Z`;
    const openingDate = new Date(new Date(earliest).getTime() - 86_400_000).toISOString();

    // Deduplicate: one opening-balance BUY per asset symbol
    const seen = new Set();
    const newTxns = [];
    for (const d of disposals) {
      if (!d.assetSymbol || !d.amountSold) continue;
      if (seen.has(d.assetSymbol)) continue;
      seen.add(d.assetSymbol);
      const qty      = d.amountSold;
      const costSEK  = d.costBasisSEK != null ? d.costBasisSEK : 0;
      const unitPx   = qty > 0 && costSEK > 0 ? costSEK / qty : 0;
      // Look up a wallet/account from any existing transaction for that asset
      const ref = allTxns.find(t => t.assetSymbol === d.assetSymbol);
      newTxns.push({
        id:              `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        date:            openingDate,
        category:        'buy',
        assetSymbol:     d.assetSymbol,
        amount:          qty,
        priceSEKPerUnit: unitPx,
        costBasisSEK:    costSEK,
        priceSource:     unitPx > 0 ? 'manual' : 'missing',
        priceConfidence: unitPx > 0 ? 'manual_entry' : 'unknown',
        description:     'Öppningssaldo (auto-skapat) — innehav ägt innan import',
        isOpeningBalance: true,
        needsReview:     unitPx === 0,
        reviewReason:    unitPx === 0 ? 'opening_balance_price_unknown' : null,
        userReviewed:    false,
        wallet:          ref?.wallet     || 'unknown',
        accountId:       ref?.accountId  || null,
      });
    }

    if (!newTxns.length) {
      showTaxToast('⚠️', 'Inga rader skapade', 'Kandidaterna saknar symbol eller belopp.', 'warning');
      return;
    }

    TaxEngine.saveTransactions([...allTxns, ...newTxns]);
    S.taxResult = null;
    const withPrice    = newTxns.filter(t => t.priceSEKPerUnit > 0).length;
    const withoutPrice = newTxns.length - withPrice;
    showTaxToast(
      '📅',
      `${newTxns.length} öppningssaldon skapade`,
      withoutPrice > 0
        ? `${withoutPrice} saknar pris — granska och fyll i kostnadsbas manuellt`
        : 'Alla har uppskattad kostnadsbas. Kör pipeline igen.',
      withoutPrice > 0 ? 'warning' : 'success'
    );
    render();
  }

  /**
   * One-click auto-resolve: runs spam + airdrop resolution in sequence without
   * separate confirm dialogs. Skips buckets that are empty.
   */
  function autoResolveAll() {
    const result = S.taxResult || getOrComputeTaxResult();
    const k4 = TaxEngine.generateK4Report(result);
    const exc = k4.excludedByStatus || {};
    const spamRows    = exc['spam_candidate']    || [];
    const airdropRows = exc['airdrop_candidate'] || [];
    const total = spamRows.length + airdropRows.length;
    if (!total) {
      showTaxToast('ℹ️', 'Inget att lösa', 'Inga spam- eller airdrop-kandidater hittades.', 'info');
      return;
    }
    if (!confirm(
      `Auto-lösa ${total} rader?\n\n` +
      (spamRows.length > 0    ? `• ${spamRows.length} spam-rader → exkluderas med 0 kr kostnadsbas\n` : '') +
      (airdropRows.length > 0 ? `• ${airdropRows.length} airdrop-rader → omklassificeras med FMV-kostnadsbas\n` : '') +
      `\nDetta går att ångra via Transaktioner.`
    )) return;

    let txns = TaxEngine.getTransactions();

    // Spam pass
    if (spamRows.length > 0) {
      const ids = new Set(spamRows.map(d => d.id).filter(Boolean));
      txns = txns.map(t => ids.has(t.id) ? { ...t,
        category: 'spam', priceSEKPerUnit: 0, costBasisSEK: 0,
        priceSource: 'missing', priceConfidence: 'spam_zero',
        needsReview: false, reviewReason: 'spam_token', userReviewed: true,
      } : t);
    }

    // Airdrop pass
    if (airdropRows.length > 0) {
      const syms = new Set(airdropRows.map(d => d.assetSymbol).filter(Boolean));
      txns = txns.map(t => {
        if (!syms.has(t.assetSymbol)) return t;
        const cat = (t.category || '').toLowerCase();
        if (!['receive', 'transfer_in', 'airdrop'].includes(cat)) return t;
        return { ...t, category: 'airdrop', needsReview: false, userReviewed: true };
      });
    }

    TaxEngine.saveTransactions(txns);
    S.taxResult = null;
    const parts = [];
    if (spamRows.length > 0) parts.push(`${spamRows.length} spam → exkluderade (0 kr)`);
    if (airdropRows.length > 0) parts.push(`${airdropRows.length} airdrops → omklassificerade (FMV-kostnadsbas)`);
    showTaxToast('✅', `${total} rader lösta!`,
      parts.join(' \u00b7 '),
      'success');
    render();
  }

  /**
   * Auto-fix easy cases: uses the engine's autoFixEasyCases to resolve
   * spam and high-confidence airdrop rows from the review issue list.
   */
  function autoFixEasyCases() {
    const txns = TaxEngine.getTransactions();
    const result = S.taxResult || getOrComputeTaxResult();
    if (!TaxEngine.autoFixEasyCases) {
      showTaxToast('ℹ️', 'Ej tillgänglig', 'autoFixEasyCases stöds inte i denna version.', 'info');
      return;
    }
    const out = TaxEngine.autoFixEasyCases(txns, result);
    if (out.resolved === 0) {
      showTaxToast('ℹ️', 'Inga enkla fall', 'Alla auto-lösbara rader har redan hanterats.', 'info');
      return;
    }
    TaxEngine.saveTransactions(txns);
    S.taxResult = null;
    const parts = [];
    if (out.spamCount > 0) parts.push(`${out.spamCount} spam → exkluderade`);
    if (out.airdropCount > 0) parts.push(`${out.airdropCount} airdrops → omklassificerade`);
    showTaxToast('✨', `${out.resolved} enkla fall lösta!`, parts.join(' · '), 'success');
    render();
  }

  // Toggle a review group's collapsed state
  function toggleReviewGroup(reason) {
    if (!S.collapsedGroups) S.collapsedGroups = new Set(['received_not_sold']);
    if (S.collapsedGroups.has(reason)) S.collapsedGroups.delete(reason);
    else S.collapsedGroups.add(reason);
    render();
  }

  // ── Review page multi-select handlers ──────────────────────
  function toggleSelectReview(id, checked) {
    if (checked) S.reviewSelectedIds.add(id);
    else S.reviewSelectedIds.delete(id);
    render();
  }

  function selectAllInGroup(reason, resType) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult || null);
    for (const iss of issues) {
      if (iss.reason !== reason) continue;
      if (resType && (iss.resolutionType || 'manual_review_required') !== resType) continue;
      if (iss.txn?.id) S.reviewSelectedIds.add(iss.txn.id);
      else if (iss.id) S.reviewSelectedIds.add(iss.id);
    }
    render();
  }

  function selectAllInAssetGroup(reason, resType, sym) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult || null);
    for (const iss of issues) {
      if (iss.reason !== reason) continue;
      if (resType && (iss.resolutionType || iss.priceBlockReason || 'manual_review_required') !== resType) continue;
      const txnSym = (iss.txn?.assetSymbol || iss.asset || iss.symbol || '').toUpperCase();
      if (txnSym !== sym.toUpperCase()) continue;
      if (iss.txn?.id) S.reviewSelectedIds.add(iss.txn.id);
      else if (iss.id) S.reviewSelectedIds.add(iss.id);
    }
    render();
  }

  function clearReviewSelection() {
    S.reviewSelectedIds.clear();
    render();
  }

  function toggleAssetGroup(key) {
    if (S.reviewAssetCollapsed.has(key)) S.reviewAssetCollapsed.delete(key);
    else S.reviewAssetCollapsed.add(key);
    render();
  }

  function expandReviewGroup(groupKey) {
    S.reviewGroupExpanded.add(groupKey);
    render();
  }

  function bulkClassifySelected(type) {
    const ids = [...S.reviewSelectedIds];
    if (ids.length === 0) return;
    const typeLabels = {
      internal_transfer: 'Intern transfer',
      airdrop: 'Airdrop',
      opening_balance: 'Öppningssaldo',
      spam: 'Spam/uteslut',
    };
    const label = typeLabels[type] || type;
    const confirmMsg = ids.length > 5
      ? `Klassificera ${ids.length} markerade transaktioner som "${label}"?`
      : null;
    if (confirmMsg && !confirm(confirmMsg)) return;
    const allTxns = TaxEngine.getTransactions();
    let updated = 0;
    for (const id of ids) {
      const t = allTxns.find(x => x.id === id);
      if (!t) continue;
      if (type === 'internal_transfer') {
        t.resolutionCandidateType = 'internal_transfer';
        t.isInternalTransfer = true;
        t.reviewedAt = Date.now();
      } else if (type === 'airdrop') {
        t.resolutionCandidateType = 'airdrop';
        t.category = 'income';
        t.reviewedAt = Date.now();
      } else if (type === 'opening_balance') {
        t.resolutionCandidateType = 'opening_balance';
        t.openingBalance = true;
        t.reviewedAt = Date.now();
      } else if (type === 'spam') {
        t.isSpam = true;
        t.resolutionCandidateType = 'spam';
        t.reviewedAt = Date.now();
      }
      updated++;
    }
    TaxEngine.saveTransactions(allTxns);
    S.reviewSelectedIds.clear();
    showTaxToast('✅', `${updated} transaktioner klassificerade`, `Markerade som "${label}". Kör om pipeline för att se effekten.`, 'success');
    render();
  }

  function bulkPriceSelected() {
    const ids = [...S.reviewSelectedIds];
    if (ids.length === 0) return;
    // Delegate to existing batch price lookup UI if available
    if (typeof bulkShowPriceSearch === 'function') {
      bulkShowPriceSearch('missing_sek_price');
    } else {
      showTaxToast('ℹ️', 'Ange pris', `${ids.length} transaktioner valda — öppna prissökning per tillgång nedan.`, 'info');
    }
  }

  // ── "Apply to similar" toast ─────────────────────────────────
  function findSimilarRows(txn) {
    const issues = TaxEngine.getReviewIssues(null, S.taxResult || null);
    const sym = (txn.assetSymbol || '').toUpperCase();
    const amt = txn.amount || txn.quantity || 0;
    return issues.filter(iss => {
      const t = iss.txn || iss;
      if ((t.id || iss.id) === txn.id) return false;
      const tSym = (t.assetSymbol || iss.asset || iss.symbol || '').toUpperCase();
      if (tSym !== sym) return false;
      if (iss.reason !== (txn._reviewReason || iss.reason)) return false;
      // amount within 2 orders of magnitude
      const tAmt = t.amount || t.quantity || 0;
      if (amt > 0 && tAmt > 0) {
        const ratio = Math.max(amt, tAmt) / Math.min(amt, tAmt);
        if (ratio > 100) return false;
      }
      return true;
    });
  }

  function showSimilarToast(similarIds, action, label) {
    S.pendingSimilarAction = { ids: new Set(similarIds), action, label };
    render();
    // Auto-dismiss after 6s
    setTimeout(() => {
      if (S.pendingSimilarAction) { S.pendingSimilarAction = null; render(); }
    }, 6000);
  }

  function applySimilarAction() {
    if (!S.pendingSimilarAction) return;
    const { ids, action, label } = S.pendingSimilarAction;
    S.pendingSimilarAction = null;
    for (const id of ids) S.reviewSelectedIds.add(id);
    bulkClassifySelected(action);
  }

  function dismissSimilarToast() {
    S.pendingSimilarAction = null;
    render();
  }

  // Resolve human-readable names for all "Unknown token" transactions.
  // Uses DexScreener batch endpoint (full Solana mints) + Pump.fun fallback.
  // Updates the token name cache and re-renders — no pipeline re-run needed.
  async function resolveUnknownTokens() {
    const btn = document.getElementById('btn-resolve-tokens');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Slår upp…'; }
    try {
      const allTxns = TaxEngine.getTransactions();
      const unknownIssues = TaxEngine.getReviewIssues(null, S.taxResult || null)
        .filter(i => i.reason === 'unknown_asset');
      if (!unknownIssues.length) {
        showTaxToast('ℹ️', 'Inga okända tokens', 'Alla tokens är redan lösta.', 'info');
        return;
      }
      // Collect full mint addresses and 8-char symbols from unknown tokens
      const mintAddresses = [...new Set(
        unknownIssues.map(i => i.txn?.contractAddress).filter(s => s && s.length > 20)
      )];
      const symbols = [...new Set(
        unknownIssues.map(i => i.txn?.assetSymbol).filter(Boolean)
      )];
      showTaxToast('🔍', 'Slår upp tokens…', `Hämtar metadata för ${mintAddresses.length} mints via DexScreener + Pump.fun…`, 'info');
      await TaxEngine.resolveUnknownTokenNames(symbols, mintAddresses);
      // Reload name cache and check how many resolved
      let nameCache = {};
      try { nameCache = JSON.parse(localStorage.getItem('tcmd_token_names') || '{}'); } catch {}
      const resolved = mintAddresses.filter(m => nameCache[m.toUpperCase()]?.name).length;
      const pumpFun  = mintAddresses.filter(m => nameCache[m.toUpperCase()]?.isPumpFun).length;
      showTaxToast('✅', `${resolved}/${mintAddresses.length} tokens lösta`, `${pumpFun > 0 ? pumpFun + ' via Pump.fun · ' : ''}Kör pipeline igen för att applicera namnen.`, 'success');
      render();
    } catch (e) {
      showTaxToast('❌', 'Upplösning misslyckades', e.message || String(e), 'error');
    } finally {
      if (btn) { btn.disabled = false; }
    }
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

  function deleteOrphanedTransactions() {
    const txns = TaxEngine.getTransactions();
    const ids = new Set(TaxEngine.getAccounts().map(a => a.id));
    const orphaned = txns.filter(t => !ids.has(t.accountId));
    if (orphaned.length === 0) {
      showTaxToast('ℹ️', 'Inga orphan-transaktioner', 'Alla transaktioner har giltiga konton.'); return;
    }
    if (!confirm(`Ta bort ${orphaned.length.toLocaleString()} transaktioner från borttagna konton?\n\nDessa transaktioner tillhör plånböcker/börser du har tagit bort. De kan inte återställas utan en ny import.\n\nKontinuera?`)) return;
    const removed = TaxEngine.deleteOrphanedTransactions();
    S.taxResult = null;
    S.portfolioSnap = null;
    S.portfolioHist = null;
    render();
    showTaxToast('🗑', 'Transaktioner borttagna', `${removed.toLocaleString()} transaktioner raderades.`, 'success');
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
      else if (parser === 'solscan') txns = P.parseSolscanCSV(_pendingCSVText, acc.id);
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
    const filtMsg = res.filteredCount > 0
      ? `${res.totalFetched} raw · ${res.filteredCount} failed/non-economic skipped`
      : `${res.totalFetched || 0} fetched`;
    showTaxToast('✅', `Imported ${added} new transactions`, filtMsg);
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

  // One-click: purge phantom Solana txns, then prompt a full re-import
  // for each affected Solana account.
  async function purgeAndResync() {
    const result = TaxEngine.purgeSolanaPhantoms();
    if (result.removed === 0) {
      showTaxToast('✅', 'Inga phantom-transaktioner', 'Inga orimliga Solana-transaktioner hittades.', 'success');
      return;
    }
    showTaxToast('🧹', `${result.removed} phantom-transaktioner rensade`,
      'Reimportera nu dina Solana-plånböcker för att få korrekt data.', 'success');
    S.taxResult = null;
    render();
  }

  async function resyncAccount(accountId) {
    if (!confirm('This will delete all imported transactions for this account and re-import. Continue?')) return;
    TaxEngine.resyncAccount(accountId);
    const acc = TaxEngine.getAccounts().find(a => a.id === accountId);
    if (acc) {
      showTaxToast('🔄', 'Re-syncing', `Re-importing ${acc.name}…`, 'info');
      if (acc.type === 'solana_bc' || acc.type === 'solana' || acc.type === 'phantom_sol' || acc.type === 'solflare') {
        await importWallet('SOL');
      } else if (acc.type === 'metamask' || acc.type === 'phantom_eth' || acc.type === 'eth') {
        await importWallet('ETH');
      } else {
        showTaxToast('ℹ️', 'Manual re-import needed', 'Please upload the CSV file again.', 'info');
        render();
      }
    }
  }

  // Reconstruct split Solana swap pairs that were imported with the old
  // buggy normalizer. Merges transfer_in+transfer_out pairs sharing the
  // same txHash into a single TRADE, then triggers pipeline re-run so
  // cost basis and K4 numbers are recalculated correctly.
  async function reprocessAndSaveSolana(accountId) {
    showTaxToast('⏳', 'Rekonstruerar Solana-swappar…', 'Analyserar transaktioner med samma txHash', 'info');
    try {
      const result = TaxEngine.reprocessSolanaSwaps(accountId || null);

      if (result.merged === 0) {
        showTaxToast('ℹ️', 'Inga delade swappar hittades', 'Antingen är alla swappar redan korrekt rekonstruerade, eller importera om plånboken med 🔄', 'info');
        return;
      }

      // Apply: delete old split rows, add new TRADE rows
      const allTxns = TaxEngine.getTransactions();
      const toDeleteSet = new Set(result.toDelete);
      const filtered = allTxns.filter(t => !toDeleteSet.has(t.id));

      // Add new TRADE rows (avoid duplicates by txHash)
      const existingHashes = new Set(filtered.map(t => `${t.txHash}|${t.accountId}`));
      for (const nt of result.toAdd) {
        const key = `${nt.txHash}|${nt.accountId}`;
        if (!existingHashes.has(key)) {
          filtered.push(nt);
          existingHashes.add(key);
        }
      }

      TaxEngine.saveTransactions(filtered);
      S.taxResult = null;

      showTaxToast('✅',
        `${result.merged} swap${result.merged !== 1 ? 'par' : ''} rekonstruerade`,
        'Kör pipeline (▶ Kör pipeline) för att uppdatera skatteberäkningarna.',
        'success');
      reRenderMain();
    } catch (e) {
      console.error('[reprocessSolana]', e);
      showTaxToast('❌', 'Rekonstruktion misslyckades', e.message, 'error');
    }
  }

  // ── Data cleanup / migration ─────────────────────────────
  async function runDataCleanup() {
    const stats = TaxEngine.getCleanupStats ? TaxEngine.getCleanupStats() : null;
    if (!stats || stats.affected === 0) {
      showTaxToast('✅', 'Databasen är ren', 'Inga korrupta transaktioner hittades.', 'success');
      return;
    }

    const lines = [
      `${stats.affected} transaktioner med korrupta värden hittades:\n`,
      stats.byType.full_mint_as_inasset  ? `• ${stats.byType.full_mint_as_inasset} med full mint-adress som inAsset (nollkostnadsbug — roten till okänd kostnadsbas)` : '',
      stats.byType.full_mint_as_symbol   ? `• ${stats.byType.full_mint_as_symbol} med full mint-adress som symbol` : '',
      stats.byType.corrupt_sol_inamount  ? `• ${stats.byType.corrupt_sol_inamount} med felaktigt SOL-belopp (lamport-artefakt)` : '',
      stats.byType.corrupt_stored_price  ? `• ${stats.byType.corrupt_stored_price} med extremt högt lagrat pris (>50 M kr)` : '',
      stats.byType.previously_flagged    ? `• ${stats.byType.previously_flagged} redan flaggade som misstänkta` : '',
      '',
      'Datarensningen:\n 1. Rensar korrupta belopp och priser\n 2. Hämtar historiska priser från API\n 3. Omräknar kostnadsunderlag och K4\n\nFortsätt?',
    ].filter(Boolean).join('\n');

    if (!confirm(lines)) return;

    S.pipelineRunning = true;
    S.pipelinePct = 0;
    S.pipelineMsg = 'Förbereder datarensning…';
    S.taxResult   = null;
    render();

    let report;
    try {
      report = await TaxEngine.runSolanaDataCleanup((msg, pct) => {
        S.pipelineMsg = msg;
        S.pipelinePct = pct;
        // Lightweight re-render: just update progress bar text if visible
        const progressEl = document.getElementById('tax-pipeline-msg');
        const pctEl      = document.getElementById('tax-pipeline-pct');
        if (progressEl) progressEl.textContent = msg;
        if (pctEl)      pctEl.style.width      = pct + '%';
      });
    } catch (err) {
      S.pipelineRunning = false;
      showTaxToast('❌', 'Datarensning misslyckades', err?.message || String(err), 'error');
      render();
      return;
    }

    S.pipelineRunning = false;
    S.taxResult = null;  // force re-computation

    // Show detailed results
    const gainFmt = v => TaxEngine.formatSEK(v);
    const deltaSign = report.gainDelta >= 0 ? '−' : '+';
    const deltaAmt  = TaxEngine.formatSEK(Math.abs(report.gainDelta));
    showTaxToast('🛠',
      `Datarensning klar — ${report.affected} transaktioner`,
      `${report.repriced} omprissatta, ${report.movedToReview} skickade till Granska. ` +
      `Vinst: ${gainFmt(report.gainBefore)} → ${gainFmt(report.gainAfter)} (${deltaSign}${deltaAmt})`,
      'success'
    );
    render();
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

    // Wire CSV parsers into the 12-stage pipeline (safe no-op if TaxPipeline not loaded)
    if (typeof TaxPipeline !== 'undefined') {
      TaxPipeline.registerAllParsers();
    }

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
    bulkAutoInfer, resolveUnknownTokens, toggleReviewGroup,
    bulkResolveSpamCandidates, bulkResolveAirdropCandidates, bulkCreateOpeningBalances, autoResolveAll, autoFixEasyCases,
    // Review multi-select + bulk actions
    toggleSelectReview, selectAllInGroup, selectAllInAssetGroup, clearReviewSelection,
    toggleAssetGroup, expandReviewGroup,
    bulkClassifySelected, bulkPriceSelected,
    applySimilarAction, dismissSimilarToast,
    deleteDuplicates, removeAccount, clearAllData, deleteOrphanedTransactions,
    downloadK4CSV, downloadK4PDF, downloadAccountantReport, downloadAuditCSV, downloadHoldingsCSV, printReport,
    setUserInfo, resyncAccount, purgeAndResync, manualCloudSync, reprocessAndSaveSolana,
    runDataCleanup,
    // Transactions page — expanded row & manual entry
    expandTxRow, setExpandedTab,
    toggleAddTxMenu, toggleTxTypeMenu, toggleTxWalletMenu, toggleTxLabelMenu,
    addManualRow, removeManualRow, duplicateManualRow, updateManualRow, cancelManualRows, submitManualRows,
    // Bulk merge
    mergeSameHash, mergeTrade, mergeTransfer, mergeMultipleTransfers,
    // Portfolio dashboard
    portSetRange, filterAssets, toggleSmallBalances, setPortFilter,
    openAssetAudit, closeAssetAudit,
    // Per-asset provenance view toggle
    toggleProvenanceAll() {
      S.provenanceShowAll = !S.provenanceShowAll;
      render();
    },
    // expose for inline onclick patterns
    filterTxns, sortTxnsArr: txns => sortTxnsArr(txns),
    filterTxsByAsset,
  };

})();

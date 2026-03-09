/* ============================================================
   T-CMD — Swedish Crypto Tax UI v2
   Auto-updating pipeline, exception-only review,
   K4 per-asset report, full import status tracking.
   ============================================================ */

const TaxUI = (() => {

  // ── State ─────────────────────────────────────────────────
  const S = {
    page:         'portfolio',
    taxYear:      TaxEngine.getSettings().taxYear,
    taxResult:    null,
    txFilter:     { search:'', category:'all', account:'all', dateFrom:'', dateTo:'', needsReview:false },
    txSort:       { field:'date', dir:'desc' },
    txPage:       0,
    txPageSize:   50,
    importModal:  null,
    editTxId:     null,
    calOpen:      false,
    calField:     null,
    calMonth:     new Date().getMonth(),
    calYear:      new Date().getFullYear(),
    pipelinePct:  0,
    pipelineMsg:  '',
    pipelineRunning: false,
  };

  let _pendingCSVText   = null;
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
      S.taxResult = null; // force recompute
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
    if (bar) { bar.style.opacity = '0'; setTimeout(() => { if(bar) bar.style.display='none'; bar.style.opacity='1'; }, 600); }
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

  // ── Auto-run pipeline ─────────────────────────────────────
  async function triggerPipeline() {
    if (TaxEngine.isPipelineRunning()) return;
    try {
      await TaxEngine.runPipeline();
    } catch {}
  }

  // ── Root Render ───────────────────────────────────────────
  function render() {
    const panel = document.getElementById('tax-panel');
    if (!panel) return;
    panel.innerHTML = `
      <div class="tax-root">
        <aside class="tax-sidebar">${renderSidebar()}</aside>
        <main class="tax-main">${renderPage()}</main>
      </div>
    `;
    bindEvents();
  }

  function renderSidebar() {
    const txns        = TaxEngine.getTransactions();
    const reviewCount = TaxEngine.getReviewIssues(txns).length;
    const years       = TaxEngine.getAvailableTaxYears();
    const pages = [
      { id:'portfolio',    icon:'💼', label:'Portfolio' },
      { id:'accounts',     icon:'🔗', label:'Accounts' },
      { id:'transactions', icon:'📋', label:'Transactions' },
      { id:'review',       icon:'🔍', label:'Review' },
      { id:'reports',      icon:'📊', label:'Reports' },
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
          ${years.map(y=>`<option value="${y}" ${y==S.taxYear?'selected':''}>${y}</option>`).join('')}
        </select>
      </div>

      <nav class="tax-nav">
        ${pages.map(p=>`
          <button class="tax-nav-item ${S.page===p.id?'active':''}" data-page="${p.id}">
            <span class="tax-nav-icon">${p.icon}</span>
            <span class="tax-nav-label">${p.label}</span>
            ${p.id==='review' && reviewCount>0 ? `<span class="tax-nav-badge">${reviewCount}</span>` : ''}
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
      case 'portfolio':    return renderPortfolio();
      case 'accounts':     return renderAccounts();
      case 'transactions': return renderTransactions();
      case 'review':       return renderReview();
      case 'reports':      return renderReports();
      default:             return renderPortfolio();
    }
  }

  // ════════════════════════════════════════════════════════════
  // PORTFOLIO PAGE
  // ════════════════════════════════════════════════════════════
  function renderPortfolio() {
    const result = getOrComputeTaxResult();
    const { summary, currentHoldings } = result;
    const issues = TaxEngine.getReviewIssues().length;

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Portfolio</h1>
          <span class="tax-page-subtitle">Inkomstår ${S.taxYear}</span>
          <div class="tax-page-actions">
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">
              ⚙️ Recalculate
            </button>
          </div>
        </div>

        ${issues > 0 ? `
        <div class="tax-review-banner" onclick="TaxUI.navigate('review')">
          <span>⚠️</span>
          <span><strong>${issues} transactions</strong> need review — tax result may be incomplete</span>
          <span class="tax-rb-link">Fix now →</span>
        </div>` : ''}

        <div class="tax-stat-grid">
          <div class="tax-stat-card">
            <div class="tax-stat-label">Holdings</div>
            <div class="tax-stat-value">${currentHoldings.length} assets</div>
          </div>
          <div class="tax-stat-card ${summary.netGainLoss>=0?'gain':'loss'}">
            <div class="tax-stat-label">Net Gain/Loss ${S.taxYear}</div>
            <div class="tax-stat-value">${TaxEngine.formatSEK(summary.netGainLoss)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Skatt (uppskattad 30%)</div>
            <div class="tax-stat-value tax-red">${TaxEngine.formatSEK(summary.estimatedTax)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Transaktioner ${S.taxYear}</div>
            <div class="tax-stat-value">${summary.totalTransactions.toLocaleString()}</div>
          </div>
        </div>

        ${summary.netGainLoss !== 0 || summary.estimatedTax > 0 ? `
        <div class="tax-section">
          <div class="tax-section-header"><h2>Skattesammanfattning ${S.taxYear}</h2></div>
          <div class="tax-gain-loss-card">
            <div class="tax-gl-row"><span>Vinst (disposals)</span><span class="tax-green">${TaxEngine.formatSEK(summary.totalGains)}</span></div>
            <div class="tax-gl-row"><span>Förlust (disposals)</span><span class="tax-red">−${TaxEngine.formatSEK(summary.totalLosses)}</span></div>
            <div class="tax-gl-divider"></div>
            <div class="tax-gl-row tax-gl-total"><span>Netto kapitalvinst</span><span class="${summary.netGainLoss>=0?'tax-green':'tax-red'}">${TaxEngine.formatSEK(summary.netGainLoss)}</span></div>
            ${summary.deductibleLoss>0?`<div class="tax-gl-row"><span>Avdragsgill förlust (70%)</span><span class="tax-amber">−${TaxEngine.formatSEK(summary.deductibleLoss)}</span></div>`:''}
            <div class="tax-gl-row tax-gl-highlight"><span>Uppskattad skatt 30%</span><span>${TaxEngine.formatSEK(summary.estimatedTax)}</span></div>
            ${summary.totalIncome>0?`<div class="tax-gl-row"><span>Inkomst (staking/rewards)</span><span class="tax-amber">${TaxEngine.formatSEK(summary.totalIncome)}</span></div>`:''}
          </div>
        </div>` : ''}

        <div class="tax-section">
          <div class="tax-section-header"><h2>Innehav</h2><span class="tax-section-count">${currentHoldings.length}</span></div>
          ${currentHoldings.length === 0
            ? renderEmpty('Inga innehav', 'Importera transaktioner från Accounts-sidan.', '💼')
            : `<div class="tax-table-wrap"><table class="tax-table">
                <thead><tr><th>Tillgång</th><th class="ta-r">Antal</th><th class="ta-r">Snittpris (SEK)</th><th class="ta-r">Totalt anskaffningsvärde (SEK)</th></tr></thead>
                <tbody>
                  ${currentHoldings.map(h=>`
                    <tr>
                      <td><div class="tax-asset-cell"><span class="tax-asset-icon">${h.symbol.slice(0,3)}</span><span class="tax-asset-sym">${h.symbol}</span></div></td>
                      <td class="ta-r tax-mono">${TaxEngine.formatCrypto(h.quantity)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(h.avgCostSEK,2)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(h.totalCostSEK)}</td>
                    </tr>`).join('')}
                </tbody>
              </table></div>`
          }
        </div>
      </div>
    `;
  }

  // ════════════════════════════════════════════════════════════
  // ACCOUNTS PAGE
  // ════════════════════════════════════════════════════════════
  function renderAccounts() {
    const accounts = TaxEngine.getAccounts();
    const txns     = TaxEngine.getTransactions();

    const SOURCES = [
      { type:'phantom',  icon:'👻', name:'Phantom',    desc:'Solana wallet — imports full history via Helius', color:'#ab9ff2' },
      { type:'metamask', icon:'🦊', name:'MetaMask',   desc:'Ethereum wallet — imports via Etherscan',         color:'#e2761b' },
      { type:'binance',  icon:'🟡', name:'Binance',    desc:'Upload full trade history CSV from Binance',      color:'#f0b90b' },
      { type:'kraken',   icon:'🐙', name:'Kraken',     desc:'Upload full ledger CSV from Kraken',              color:'#5741d9' },
      { type:'bybit',    icon:'🔵', name:'Bybit',      desc:'Upload full trade history CSV from Bybit',        color:'#f7a600' },
      { type:'coinbase', icon:'🔵', name:'Coinbase',   desc:'Upload transaction history CSV from Coinbase',    color:'#0052ff' },
      { type:'csv',      icon:'📄', name:'CSV Upload', desc:'Generic CSV — any exchange or wallet',            color:'#64748b' },
    ];

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Accounts</h1>
          <span class="tax-page-subtitle">Wallets and exchanges</span>
        </div>

        <div class="tax-info-box">
          <span>ℹ️</span>
          <span>Import <strong>full transaction history</strong> from every account where you have traded or held crypto. Skatteverket requires all acquisitions to calculate correct cost basis under Genomsnittsmetoden.</span>
        </div>

        <div class="tax-section">
          <div class="tax-section-header"><h2>Add Account</h2></div>
          <div class="tax-account-grid">
            ${SOURCES.map(a=>`
              <div class="tax-account-card" onclick="TaxUI.openImport('${a.type}')">
                <div class="tax-ac-icon" style="background:${a.color}22;border-color:${a.color}44">${a.icon}</div>
                <div class="tax-ac-info">
                  <div class="tax-ac-name">${a.name}</div>
                  <div class="tax-ac-desc">${a.desc}</div>
                </div>
                <button class="tax-btn tax-btn-sm tax-btn-primary">Connect</button>
              </div>`).join('')}
          </div>
        </div>

        ${accounts.length > 0 ? `
        <div class="tax-section">
          <div class="tax-section-header"><h2>Connected</h2><span class="tax-section-count">${accounts.length}</span></div>
          <div class="tax-table-wrap"><table class="tax-table">
            <thead><tr><th>Account</th><th>Type</th><th>Status</th><th class="ta-r">Transactions</th><th>Date range</th><th></th></tr></thead>
            <tbody>
              ${accounts.map(acc => {
                const st  = TaxEngine.getImportStatus(acc.id);
                const cnt = txns.filter(t => t.accountId === acc.id).length;
                const src = SOURCES.find(s => s.type === acc.type) || { icon:'📂', name:acc.type };
                return `<tr>
                  <td>
                    <div class="tax-asset-cell">
                      <span>${src.icon}</span>
                      <div>
                        <div class="tax-acc-name">${acc.label || acc.type}</div>
                        ${acc.address ? `<div class="tax-acc-addr">${acc.address.slice(0,10)}…${acc.address.slice(-6)}</div>` : ''}
                      </div>
                    </div>
                  </td>
                  <td><span class="tax-badge">${src.name}</span></td>
                  <td>${renderImportStatus(st)}</td>
                  <td class="ta-r tax-mono">${cnt.toLocaleString()}</td>
                  <td class="tax-muted tax-nowrap" style="font-size:11px">
                    ${st.startDate ? fmtDate(st.startDate)+' → '+fmtDate(st.endDate||new Date().toISOString()) : '—'}
                  </td>
                  <td class="ta-r">
                    <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.removeAccount('${acc.id}')">Remove</button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        </div>` : ''}

        ${renderImportModal()}
      </div>
    `;
  }

  function renderImportStatus(st) {
    const map = {
      never_synced: ['⬜','Never imported','#64748b'],
      syncing:      ['⏳','Syncing…','#818cf8'],
      synced:       ['✅','Synced','#4ade80'],
      partial_sync: ['⚠️','Partial','#fbbf24'],
      failed:       ['❌','Failed','#f87171'],
    };
    const [icon, label, color] = map[st.status] || map.never_synced;
    return `<span class="tax-status-pill" style="color:${color}">${icon} ${label}</span>`;
  }

  // ── Import Modals ─────────────────────────────────────────
  function renderImportModal() {
    if (!S.importModal) return '';
    const wallets = { phantom:'sol', metamask:'eth' };
    if (wallets[S.importModal]) return renderWalletModal(S.importModal, wallets[S.importModal]);
    return renderCSVModal(S.importModal);
  }

  const MODAL_INSTRUCTIONS = {
    binance:  { icon:'🟡', name:'Binance', steps:[
      '1. Log in to Binance', '2. Go to Orders → Trade History',
      '3. Click "Export" → choose ALL time', '4. Download CSV and upload below',
    ], warning:'Make sure to export ALL time, not just the last 3 months.' },
    kraken:   { icon:'🐙', name:'Kraken', steps:[
      '1. Log in to Kraken', '2. Go to History → Export',
      '3. Select "All Ledgers" → All time', '4. Download and upload below',
    ], warning:'Export Ledgers (not just trades) to include deposits, withdrawals and staking.' },
    bybit:    { icon:'🔵', name:'Bybit', steps:[
      '1. Log in to Bybit', '2. Go to Assets → Order History',
      '3. Export → All time', '4. Upload below',
    ], warning:null },
    coinbase: { icon:'🔵', name:'Coinbase', steps:[
      '1. Log in to Coinbase', '2. Go to Reports → Generate',
      '3. Select Transaction History → All time', '4. Download CSV and upload below',
    ], warning:null },
    csv:      { icon:'📄', name:'CSV File', steps:[
      'Expected columns: date, type, asset, amount, price_sek (or price), fee',
      'Common column names are auto-detected.',
    ], warning:null },
  };

  function renderWalletModal(type, chain) {
    const names = { sol:'Phantom (Solana)', eth:'MetaMask (Ethereum)' };
    const icons = { sol:'👻', eth:'🦊' };
    return `<div class="tax-modal-overlay">
      <div class="tax-modal">
        <div class="tax-modal-header"><span>${icons[chain]} Connect ${names[chain]}</span><button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button></div>
        <div class="tax-modal-body">
          <div class="tax-info-box" style="margin-bottom:14px">
            <span>🔒</span>
            <span>Read-only — your private keys are <strong>never</strong> accessed or stored. Only your public address is used to fetch transaction history.</span>
          </div>
          <div class="tax-form-group">
            <label>Public Wallet Address</label>
            <input type="text" id="tax-wallet-addr" class="tax-input" placeholder="${chain==='eth'?'0x...':'Solana public key'}">
          </div>
          <div class="tax-form-group">
            <label>Label (optional)</label>
            <input type="text" id="tax-wallet-label" class="tax-input" placeholder="My ${names[chain]} wallet">
          </div>
          ${chain==='sol' && !localStorage.getItem('tcmd_helius_key') ? `
          <div class="tax-warn-box">⚠️ No Helius API key found. Add it in the Admin panel to enable full Solana history import.</div>` : ''}
          <div id="tax-import-status"></div>
        </div>
        <div class="tax-modal-footer">
          <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeImport()">Cancel</button>
          <button class="tax-btn tax-btn-primary" onclick="TaxUI.importWallet('${chain}')">Import Full History</button>
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
            ${info.steps.map(s=>`<div class="tax-import-step">${s}</div>`).join('')}
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
    buy:          { icon:'↓', color:'#22c55e', label:'Buy' },
    sell:         { icon:'↑', color:'#ef4444', label:'Sell' },
    trade:        { icon:'↔', color:'#8b5cf6', label:'Swap' },
    receive:      { icon:'⬇', color:'#06b6d4', label:'Receive' },
    send:         { icon:'⬆', color:'#f59e0b', label:'Send' },
    income:       { icon:'★', color:'#f59e0b', label:'Income' },
    fee:          { icon:'💸', color:'#94a3b8', label:'Fee' },
    transfer_in:  { icon:'←', color:'#64748b', label:'Transfer In' },
    transfer_out: { icon:'→', color:'#64748b', label:'Transfer Out' },
    spam:         { icon:'🚫', color:'#475569', label:'Spam' },
    approval:     { icon:'✓',  color:'#475569', label:'Approval' },
  };

  function renderTransactions() {
    const allTxns  = TaxEngine.getTransactions();
    const accounts = TaxEngine.getAccounts();
    const filtered = filterTxns(allTxns);
    const sorted   = sortTxnsArr(filtered);
    const paged    = sorted.slice(S.txPage * S.txPageSize, (S.txPage+1) * S.txPageSize);

    return `
      <div class="tax-page">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Transactions</h1>
          <div class="tax-page-actions">
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.openImport('csv')">+ Add CSV</button>
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.triggerPipeline()">⚙️ Process</button>
          </div>
        </div>

        <div class="tax-filter-bar">
          <div class="tax-search-wrap">
            <span class="tax-search-icon">🔍</span>
            <input type="text" class="tax-input tax-search-input" placeholder="Search asset, hash, notes…"
              value="${S.txFilter.search}" oninput="TaxUI.setFilter('search',this.value)">
          </div>
          <select class="tax-select tax-filter-select" onchange="TaxUI.setFilter('category',this.value)">
            <option value="all">All types</option>
            ${Object.entries(CAT_META).map(([k,v])=>`<option value="${k}" ${S.txFilter.category===k?'selected':''}>${v.label}</option>`).join('')}
          </select>
          <select class="tax-select tax-filter-select" onchange="TaxUI.setFilter('account',this.value)">
            <option value="all">All accounts</option>
            ${accounts.map(a=>`<option value="${a.id}" ${S.txFilter.account===a.id?'selected':''}>${a.label||a.type}</option>`).join('')}
          </select>
          <div class="tax-date-range">
            <input type="text" class="tax-input tax-date-input" placeholder="From" value="${S.txFilter.dateFrom}" readonly onclick="TaxUI.openCal('from')">
            <span style="color:var(--text-muted)">→</span>
            <input type="text" class="tax-input tax-date-input" placeholder="To" value="${S.txFilter.dateTo}" readonly onclick="TaxUI.openCal('to')">
          </div>
          <label class="tax-check-label">
            <input type="checkbox" ${S.txFilter.needsReview?'checked':''} onchange="TaxUI.setFilter('needsReview',this.checked)">
            Review only
          </label>
        </div>

        ${S.calOpen ? renderCalendar() : ''}

        <div class="tax-table-meta">
          <span class="tax-muted">${filtered.length.toLocaleString()} transactions</span>
          ${filtered.length < allTxns.length ? `<span class="tax-filter-chip">${allTxns.length.toLocaleString()} total</span>` : ''}
          <span style="flex:1"></span>
          ${renderPagination(filtered.length)}
        </div>

        ${paged.length === 0
          ? renderEmpty('No transactions', allTxns.length===0 ? 'Add accounts from the Accounts page.' : 'No matches.', '📋')
          : `<div class="tax-table-wrap"><table class="tax-table">
              <thead><tr>
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
    const cm      = CAT_META[t.category] || { icon:'•', color:'#94a3b8', label:t.category };
    const val     = t.costBasisSEK || (t.priceSEKPerUnit * t.amount) || 0;
    const isInternal = t.isInternalTransfer;
    return `
      <tr class="${t.needsReview?'tax-row-review':''} ${isInternal?'tax-row-internal':''}">
        <td>
          <span class="tax-cat-badge" style="background:${cm.color}22;color:${cm.color}">${cm.icon} ${cm.label}</span>
          ${isInternal?'<span class="tax-transfer-tag">↔ internal</span>':''}
        </td>
        <td class="tax-muted tax-nowrap">${fmtDateShort(t.date)}</td>
        <td>
          <div class="tax-asset-cell-col">
            <span class="tax-asset-sym">${t.assetSymbol||'—'}</span>
            ${t.category==='trade'&&t.inAsset?`<span style="font-size:11px;color:#8b5cf6">→ ${t.inAsset}</span>`:''}
            ${t.priceSource?`<span class="tax-price-src">${t.priceSource==='coingecko'?'📈':'💱'}</span>`:''}
          </div>
        </td>
        <td class="ta-r tax-mono">${TaxEngine.formatCrypto(t.amount,8)}</td>
        <td class="ta-r tax-mono">${t.priceSEKPerUnit?TaxEngine.formatSEK(t.priceSEKPerUnit,2):'<span class="tax-missing">—</span>'}</td>
        <td class="ta-r tax-mono">${val?TaxEngine.formatSEK(val):'<span class="tax-missing">—</span>'}</td>
        <td class="ta-r tax-mono">${t.feeSEK?TaxEngine.formatSEK(t.feeSEK,2):'—'}</td>
        <td>
          <div class="tax-row-actions">
            ${t.needsReview?'<span title="Needs review" style="font-size:13px">⚠️</span>':''}
            <button class="tax-icon-btn" onclick="TaxUI.editTx('${t.id}')">✏️</button>
            <button class="tax-icon-btn tax-icon-del" onclick="TaxUI.deleteTx('${t.id}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderCalendar() {
    const y = S.calYear, m = S.calMonth;
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const first   = new Date(y, m, 1).getDay();
    const days    = new Date(y, m+1, 0).getDate();
    const blanks  = first === 0 ? 6 : first - 1;
    const selDate = S.calField==='from' ? S.txFilter.dateFrom : S.txFilter.dateTo;
    let cells = '';
    for (let i=0;i<blanks;i++) cells+='<div class="tax-cal-cell empty"></div>';
    for (let d=1;d<=days;d++) {
      const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      cells += `<div class="tax-cal-cell${selDate===ds?' selected':''}" onclick="TaxUI.selectDate('${ds}')">${d}</div>`;
    }
    return `<div class="tax-calendar-wrap"><div class="tax-calendar">
      <div class="tax-cal-header">
        <button class="tax-cal-nav" onclick="TaxUI.calNav(-1)">‹</button>
        <span>${MONTHS[m]} ${y}</span>
        <button class="tax-cal-nav" onclick="TaxUI.calNav(1)">›</button>
      </div>
      <div class="tax-cal-grid">
        ${['Mo','Tu','We','Th','Fr','Sa','Su'].map(d=>`<div class="tax-cal-dow">${d}</div>`).join('')}
        ${cells}
      </div>
      <div class="tax-cal-footer"><button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.closeCal()">Close</button></div>
    </div></div>`;
  }

  function renderPagination(total) {
    const pages = Math.ceil(total / S.txPageSize);
    if (pages<=1) return '';
    return `<div class="tax-pagination">
      <button class="tax-page-btn" ${S.txPage===0?'disabled':''} onclick="TaxUI.setPage(${S.txPage-1})">‹</button>
      <span class="tax-page-info">${S.txPage+1} / ${pages}</span>
      <button class="tax-page-btn" ${S.txPage>=pages-1?'disabled':''} onclick="TaxUI.setPage(${S.txPage+1})">›</button>
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
              <input type="datetime-local" id="e-date" class="tax-input" value="${(t.date||'').slice(0,16)}">
            </div>
            <div class="tax-form-group">
              <label>Type</label>
              <select id="e-cat" class="tax-select">
                ${cats.map(([k,v])=>`<option value="${k}" ${t.category===k?'selected':''}>${v.label}</option>`).join('')}
              </select>
            </div>
            <div class="tax-form-group">
              <label>Asset</label>
              <input type="text" id="e-sym" class="tax-input" value="${t.assetSymbol||''}">
            </div>
            <div class="tax-form-group">
              <label>Amount</label>
              <input type="number" id="e-amt" class="tax-input" value="${t.amount||0}" step="any">
            </div>
            <div class="tax-form-group">
              <label>Price (SEK/unit)</label>
              <input type="number" id="e-price" class="tax-input" value="${t.priceSEKPerUnit||0}" step="any">
            </div>
            <div class="tax-form-group">
              <label>Fee (SEK)</label>
              <input type="number" id="e-fee" class="tax-input" value="${t.feeSEK||0}" step="any">
            </div>
          </div>
          ${t.category==='trade'?`
          <div class="tax-form-grid">
            <div class="tax-form-group">
              <label>Received Asset</label>
              <input type="text" id="e-inasset" class="tax-input" value="${t.inAsset||''}">
            </div>
            <div class="tax-form-group">
              <label>Received Amount</label>
              <input type="number" id="e-inamt" class="tax-input" value="${t.inAmount||0}" step="any">
            </div>
          </div>`:''}
          <div class="tax-form-group">
            <label>Notes</label>
            <input type="text" id="e-notes" class="tax-input" value="${t.notes||''}">
          </div>
          <label class="tax-check-label">
            <input type="checkbox" id="e-reviewed" ${!t.needsReview?'checked':''}>
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
          ${issues.length>0?`<div class="tax-page-actions"><button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.markAllReviewed()">Mark all OK</button></div>`:''}
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
                <div class="tax-review-fix-tip">💡 ${meta.fix}</div>
                <div class="tax-review-items">
                  ${items.map(({ txn }) => `
                    <div class="tax-review-item">
                      <div class="tax-ri-left">
                        <span class="tax-asset-sym">${txn.assetSymbol}</span>
                        <span class="tax-mono" style="font-size:12px">${TaxEngine.formatCrypto(txn.amount,8)}</span>
                        <span class="tax-muted">${fmtDateShort(txn.date)}</span>
                      </div>
                      <div class="tax-ri-right">
                        <button class="tax-btn tax-btn-xs tax-btn-primary" onclick="TaxUI.editTx('${txn.id}')">Edit</button>
                        <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.markReviewed('${txn.id}')">OK</button>
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
      if (!groups[issue.reason]) groups[issue.reason] = { reason:issue.reason, meta:issue.meta, items:[] };
      groups[issue.reason].items.push(issue);
    }
    return Object.values(groups);
  }

  // ════════════════════════════════════════════════════════════
  // REPORTS PAGE — K4 Section D, per-asset grouping
  // ════════════════════════════════════════════════════════════
  function renderReports() {
    const result  = getOrComputeTaxResult();
    const { summary, disposals } = result;
    const k4      = TaxEngine.generateK4Report(result);
    const issues  = TaxEngine.getReviewIssues().length;

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

        <div class="tax-report-hero">
          <div class="tax-rh-year">${S.taxYear}</div>
          <div class="tax-rh-title">Sammanfattning — K4 Sektion D</div>
          <div class="tax-rh-grid">
            <div class="tax-rh-item"><div class="tax-rh-label">Summa vinst → ruta 7.5</div><div class="tax-rh-val tax-green">${TaxEngine.formatSEK(k4.totalGains)}</div></div>
            <div class="tax-rh-item"><div class="tax-rh-label">Summa förlust → ruta 8.4</div><div class="tax-rh-val tax-red">${TaxEngine.formatSEK(k4.totalLosses)}</div></div>
            <div class="tax-rh-item"><div class="tax-rh-label">Avdragsgill förlust (70%)</div><div class="tax-rh-val tax-amber">${TaxEngine.formatSEK(k4.totalLosses * 0.70)}</div></div>
            <div class="tax-rh-item tax-rh-highlight"><div class="tax-rh-label">Uppskattad skatt 30%</div><div class="tax-rh-val">${TaxEngine.formatSEK(summary.estimatedTax)}</div></div>
          </div>
        </div>

        <!-- K4 Preview Table -->
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>K4 Sektion D — Kryptovalutor</h2>
            ${k4.formsNeeded>1?`<span class="tax-badge" style="background:rgba(99,102,241,.15);color:#818cf8">${k4.formsNeeded} blanketter</span>`:''}
            <div style="margin-left:auto;display:flex;gap:8px">
              <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.downloadK4CSV()">⬇ K4 CSV (SKV 2104-D)</button>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.printReport()">🖨 Skriv ut</button>
            </div>
          </div>

          <div class="tax-k4-explainer">
            Förenklad metod: en rad per tillgång och vinstsida. Fyll in värdena i K4-blankettens Sektion D.
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
                  ${k4.k4Rows.map((r,i)=>`
                    <tr class="${(i+1)%ROWS_PER_K4_FORM===0 && i!==k4.k4Rows.length-1 ? 'tax-k4-page-break':''}">
                      <td>
                        <div class="tax-asset-cell">
                          <span class="tax-asset-sym">${r.sym}</span>
                          <span class="tax-badge" style="margin-left:6px;${r.side==='gain'?'background:rgba(34,197,94,.1);color:#4ade80':'background:rgba(239,68,68,.1);color:#f87171'}">${r.side==='gain'?'Vinst':'Förlust'}</span>
                        </div>
                      </td>
                      <td class="ta-r tax-mono">${TaxEngine.formatCrypto(r.qty,8)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(r.proc)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(r.cost)}</td>
                      <td class="ta-r tax-mono ${r.gain>0?'tax-green':''}">${r.gain?TaxEngine.formatSEK(r.gain):''}</td>
                      <td class="ta-r tax-mono ${r.loss>0?'tax-red':''}">${r.loss?TaxEngine.formatSEK(r.loss):''}</td>
                    </tr>`).join('')}
                  <tr class="tax-k4-sum-row">
                    <td><strong>Summa</strong></td>
                    <td></td><td></td><td></td>
                    <td class="ta-r tax-green"><strong>${TaxEngine.formatSEK(k4.totalGains)}</strong></td>
                    <td class="ta-r tax-red"><strong>${TaxEngine.formatSEK(k4.totalLosses)}</strong></td>
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
  // ACTIONS
  // ════════════════════════════════════════════════════════════

  function openImport(type) { S.importModal = type; render(); }
  function closeImport()    { S.importModal = null; _pendingCSVText = null; render(); }

  function setFilter(key, val) { S.txFilter[key]=val; S.txPage=0; reRenderMain(); }
  function sortTxns(field) {
    S.txSort.dir = S.txSort.field===field ? (S.txSort.dir==='asc'?'desc':'asc') : 'desc';
    S.txSort.field = field;
    reRenderMain();
  }
  function setPage(p) { S.txPage=p; reRenderMain(); }
  function openCal(field)  { S.calField=field; S.calOpen=true; S.calMonth=new Date().getMonth(); S.calYear=new Date().getFullYear(); reRenderMain(); }
  function closeCal()      { S.calOpen=false; reRenderMain(); }
  function calNav(d)       { S.calMonth+=d; if(S.calMonth>11){S.calMonth=0;S.calYear++;} if(S.calMonth<0){S.calMonth=11;S.calYear--;} reRenderMain(); }
  function selectDate(ds)  { if(S.calField==='from') S.txFilter.dateFrom=ds; else S.txFilter.dateTo=ds; S.calOpen=false; reRenderMain(); }

  function editTx(id)      { S.editTxId=id; reRenderMain(); }
  function closeEdit()     { S.editTxId=null; S.taxResult=null; render(); }
  function deleteTx(id)    {
    if (!confirm('Delete this transaction? This will affect tax calculations.')) return;
    TaxEngine.deleteTransaction(id); S.taxResult=null; reRenderMain();
  }
  function saveEdit(id) {
    const d      = document.getElementById('e-date')?.value;
    const cat    = document.getElementById('e-cat')?.value;
    const sym    = document.getElementById('e-sym')?.value?.toUpperCase();
    const amt    = parseFloat(document.getElementById('e-amt')?.value)||0;
    const price  = parseFloat(document.getElementById('e-price')?.value)||0;
    const fee    = parseFloat(document.getElementById('e-fee')?.value)||0;
    const notes  = document.getElementById('e-notes')?.value||'';
    const rev    = document.getElementById('e-reviewed')?.checked;
    const inAsset  = document.getElementById('e-inasset')?.value?.toUpperCase()||undefined;
    const inAmount = parseFloat(document.getElementById('e-inamt')?.value)||undefined;
    TaxEngine.updateTransaction(id, {
      date:d?new Date(d).toISOString():undefined, category:cat,
      assetSymbol:sym, amount:amt, priceSEKPerUnit:price,
      costBasisSEK:price*amt, feeSEK:fee, notes,
      needsReview:!rev, reviewReason:rev?null:undefined,
      manualCategory:true, priceSource:'manual',
      ...(inAsset?{inAsset,inAmount}:{}),
    });
    S.editTxId=null; S.taxResult=null; render();
    showTaxToast('✅','Transaction updated');
  }

  function markReviewed(id)  { TaxEngine.updateTransaction(id,{needsReview:false,reviewReason:null}); S.taxResult=null; render(); }
  function markAllReviewed() {
    TaxEngine.getTransactions().filter(t=>t.needsReview).forEach(t =>
      TaxEngine.updateTransaction(t.id,{needsReview:false,reviewReason:null}));
    S.taxResult=null; render();
  }
  function removeAccount(id) {
    if (!confirm('Remove account? All its transactions will also be deleted.')) return;
    TaxEngine.removeAccount(id); S.taxResult=null; render();
    showTaxToast('✅','Account removed');
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
      if (sub) sub.textContent = `📄 ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
      const btn = document.getElementById('tax-csv-import-btn');
      if (btn) { btn.disabled=false; btn.textContent='Import Transactions'; }
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

    const label = document.getElementById('tax-csv-label')?.value||'';
    const acc   = TaxEngine.addAccount({ type:parser==='generic'?'csv':parser, label });

    let txns = [];
    try {
      const P = TaxEngine;
      if (parser==='binance')  txns = P.parseBinanceCSV(_pendingCSVText, acc.id);
      else if (parser==='kraken')   txns = P.parseKrakenCSV(_pendingCSVText, acc.id);
      else if (parser==='bybit')    txns = P.parseBybitCSV(_pendingCSVText, acc.id);
      else if (parser==='coinbase') txns = P.parseCoinbaseCSV(_pendingCSVText, acc.id);
      else                          txns = P.parseGenericCSV(_pendingCSVText, acc.id);
    } catch (e) {
      if (st) st.innerHTML = `<div class="tax-import-error">❌ Parse error: ${e.message}</div>`;
      return;
    }

    const added = TaxEngine.addTransactions(txns);
    TaxEngine.setImportStatus(acc.id, {
      status:    'synced',
      totalFetched: txns.length,
      totalTxns: added,
      source:    parser,
    });
    _pendingCSVText  = null;
    S.importModal    = null;
    S.taxResult      = null;
    S.page           = 'transactions';
    render();
    showTaxToast('✅',`Imported ${added} transactions`,`${txns.length-added} duplicates skipped`);
    // Auto-run pipeline
    setTimeout(triggerPipeline, 500);
  }

  async function importWallet(chain) {
    const addr  = document.getElementById('tax-wallet-addr')?.value?.trim();
    const label = document.getElementById('tax-wallet-label')?.value?.trim()||'';
    if (!addr) { showTaxToast('⚠️','Enter wallet address'); return; }

    const st = document.getElementById('tax-import-status');
    if (st) st.innerHTML = '<div class="tax-import-status-loading">⏳ Fetching full transaction history…</div>';

    const btn = document.querySelector('.tax-modal-footer .tax-btn-primary');
    if (btn) { btn.disabled=true; btn.textContent='Importing…'; }

    const acc = TaxEngine.addAccount({ type:chain==='eth'?'metamask':'phantom', label, address:addr });
    let res;
    try {
      const onProgress = p => {
        if (st) st.innerHTML = `<div class="tax-import-status-loading">⏳ ${p.msg}</div>`;
      };
      res = chain==='sol'
        ? await TaxEngine.importSolanaWallet(addr, acc.id, onProgress)
        : await TaxEngine.importEthWallet(addr, acc.id, onProgress);
    } catch (e) {
      if (st) st.innerHTML = `<div class="tax-import-error">❌ ${e.message}</div>`;
      if (btn) { btn.disabled=false; btn.textContent='Import Full History'; }
      return;
    }

    if (res.error && !res.txns?.length) {
      if (st) st.innerHTML = `<div class="tax-import-error">❌ ${res.error}</div>`;
      if (btn) { btn.disabled=false; btn.textContent='Import Full History'; }
      return;
    }

    const added = TaxEngine.addTransactions(res.txns||[]);
    S.importModal = null; S.taxResult = null; S.page = 'transactions';
    render();
    showTaxToast('✅',`Imported ${added} transactions`,`Total fetched: ${res.totalFetched||0}`);
    setTimeout(triggerPipeline, 500);
  }

  // ── Download / Print ──────────────────────────────────────
  function downloadK4CSV() {
    const result   = getOrComputeTaxResult();
    const userInfo = {};
    try { if(typeof AuthManager!=='undefined'){ const u=AuthManager.getUser(); if(u)userInfo.name=u.name; } } catch {}
    const csv  = TaxEngine.generateK4CSV(result, userInfo);
    const blob = new Blob(['\ufeff'+csv], { type:'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=`SKV2104_K4_D_krypto_${S.taxYear}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }
  function printReport() { window.print(); }

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
      if (f.category!=='all' && t.category!==f.category) return false;
      if (f.account!=='all'  && t.accountId!==f.account) return false;
      if (f.dateFrom && t.date < f.dateFrom) return false;
      if (f.dateTo   && t.date > f.dateTo+'T23:59:59') return false;
      if (f.needsReview && !t.needsReview) return false;
      return true;
    });
  }

  function sortTxnsArr(txns) {
    const {field,dir} = S.txSort;
    return [...txns].sort((a,b)=>{
      let av=a[field], bv=b[field];
      if (field==='amount'||field==='feeSEK') { av=parseFloat(av)||0; bv=parseFloat(bv)||0; }
      if (av<bv) return dir==='asc'?-1:1;
      if (av>bv) return dir==='asc'?1:-1;
      return 0;
    });
  }
  // aliased for event handlers
  function sortIcon(f) {
    if (S.txSort.field!==f) return '<span class="sort-icon">⇅</span>';
    return S.txSort.dir==='asc' ? '<span class="sort-icon active">↑</span>' : '<span class="sort-icon active">↓</span>';
  }

  function fmtDate(iso) { if(!iso) return '—'; return new Date(iso).toLocaleDateString('sv-SE'); }
  function fmtDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('sv-SE')+' '+d.toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'});
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

  function showTaxToast(icon, title, msg='', type='success') {
    if (typeof showToast==='function') showToast(icon, title, msg, type);
  }

  // ── Event binding ─────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll('.tax-nav-item').forEach(btn => {
      btn.addEventListener('click', () => { S.page=btn.dataset.page; render(); });
    });
    const yp = document.getElementById('tax-year-picker');
    if (yp) yp.addEventListener('change', () => {
      S.taxYear=parseInt(yp.value); S.taxResult=null;
      TaxEngine.saveSettings({...TaxEngine.getSettings(), taxYear:S.taxYear});
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
          const fakeEv = { target:{ files:[file] } };
          onCSVSelected(fakeEv, S.importModal);
        }
      });
    }
  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    // Load transactions from IndexedDB into in-memory cache before first render
    await TaxEngine.loadTransactions();
    S.taxYear = TaxEngine.getSettings().taxYear;
    S.taxResult = null;
    bindPipelineEvents();
    render();
  }

  function navigate(page) { S.page=page; render(); }

  // ── Public ────────────────────────────────────────────────
  return {
    init, render, navigate, triggerPipeline,
    openImport, closeImport,
    importWallet, importCSV, onCSVSelected,
    setFilter, sortTxns, setPage,
    openCal, closeCal, calNav, selectDate,
    editTx, closeEdit, saveEdit, deleteTx,
    markReviewed, markAllReviewed, removeAccount,
    downloadK4CSV, printReport,
    // expose for inline onclick patterns
    filterTxns, sortTxnsArr: txns => sortTxnsArr(txns),
  };

})();

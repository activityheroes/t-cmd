/* ============================================================
   T-CMD — Crypto Tax UI Module
   5 pages: Portfolio · Accounts · Transactions · Review · Reports
   Swedish tax focus (Genomsnittsmetoden / K4 / Skatteverket)
   ============================================================ */

const TaxUI = (() => {

  // ── State ─────────────────────────────────────────────────
  const state = {
    page:         'portfolio',   // portfolio | accounts | transactions | review | reports
    txFilter:     { search: '', category: 'all', dateFrom: '', dateTo: '', account: 'all', needsReview: false },
    txSort:       { field: 'date', dir: 'desc' },
    txPage:       0,
    txPageSize:   50,
    importModal:  null,   // null | 'metamask' | 'phantom' | 'binance' | 'kraken' | 'bybit' | 'coinbase' | 'csv'
    editTxId:     null,
    taxYear:      TaxEngine.getSettings().taxYear,
    taxResult:    null,
    loading:      false,
    calendarOpen: false,
    calendarField: null,  // 'from' | 'to'
    calendarMonth: new Date().getMonth(),
    calendarYear:  new Date().getFullYear(),
  };

  // ── Render Root ───────────────────────────────────────────
  function render() {
    const panel = document.getElementById('tax-panel');
    if (!panel) return;
    panel.innerHTML = `
      <div class="tax-root">
        <aside class="tax-sidebar">
          ${renderSidebar()}
        </aside>
        <main class="tax-main">
          ${renderPage()}
        </main>
      </div>
    `;
    bindEvents();
  }

  function renderSidebar() {
    const pages = [
      { id: 'portfolio',    icon: '💼', label: 'Portfolio' },
      { id: 'accounts',     icon: '🔗', label: 'Accounts' },
      { id: 'transactions', icon: '📋', label: 'Transactions' },
      { id: 'review',       icon: '🔍', label: 'Review' },
      { id: 'reports',      icon: '📊', label: 'Reports' },
    ];

    const txns = TaxEngine.getTransactions();
    const reviewCount = txns.filter(t => t.needsReview).length;

    const years = TaxEngine.getAvailableTaxYears();

    return `
      <div class="tax-logo">
        <span class="tax-logo-icon">🇸🇪</span>
        <div>
          <div class="tax-logo-title">Tax Calculator</div>
          <div class="tax-logo-sub">Skatteverket / K4</div>
        </div>
      </div>

      <div class="tax-year-select">
        <label>Tax Year</label>
        <select id="tax-year-picker" class="tax-select">
          ${years.map(y => `<option value="${y}" ${y == state.taxYear ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>

      <nav class="tax-nav">
        ${pages.map(p => `
          <button class="tax-nav-item ${state.page === p.id ? 'active' : ''}" data-page="${p.id}">
            <span class="tax-nav-icon">${p.icon}</span>
            <span class="tax-nav-label">${p.label}</span>
            ${p.id === 'review' && reviewCount > 0 ? `<span class="tax-nav-badge">${reviewCount}</span>` : ''}
          </button>
        `).join('')}
      </nav>

      <div class="tax-sidebar-footer">
        <div class="tax-storage-info">
          <span class="tax-storage-icon">💾</span>
          <span>${TaxEngine.getTransactions().length.toLocaleString()} transactions stored</span>
        </div>
      </div>
    `;
  }

  function renderPage() {
    switch (state.page) {
      case 'portfolio':    return renderPortfolio();
      case 'accounts':     return renderAccounts();
      case 'transactions': return renderTransactions();
      case 'review':       return renderReview();
      case 'reports':      return renderReports();
      default:             return renderPortfolio();
    }
  }

  // ── Portfolio Page ────────────────────────────────────────
  function renderPortfolio() {
    const result = getOrComputeTaxResult();
    const { summary, currentHoldings } = result;

    return `
      <div class="tax-page" id="tax-page-portfolio">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Portfolio Overview</h1>
          <span class="tax-page-subtitle">Tax Year ${state.taxYear}</span>
        </div>

        <div class="tax-stat-grid">
          <div class="tax-stat-card">
            <div class="tax-stat-label">Total Holdings</div>
            <div class="tax-stat-value">${currentHoldings.length} assets</div>
          </div>
          <div class="tax-stat-card ${summary.netGainLoss >= 0 ? 'gain' : 'loss'}">
            <div class="tax-stat-label">Net Gain/Loss ${state.taxYear}</div>
            <div class="tax-stat-value">${TaxEngine.formatSEK(summary.netGainLoss)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Estimated Tax</div>
            <div class="tax-stat-value tax-red">${TaxEngine.formatSEK(summary.estimatedTax)}</div>
          </div>
          <div class="tax-stat-card">
            <div class="tax-stat-label">Transactions</div>
            <div class="tax-stat-value">${summary.totalTransactions.toLocaleString()}</div>
          </div>
        </div>

        <div class="tax-section">
          <div class="tax-section-header">
            <h2>Current Holdings</h2>
            <span class="tax-section-count">${currentHoldings.length}</span>
          </div>
          ${currentHoldings.length === 0
            ? renderEmptyState('No holdings found', 'Import transactions to see your portfolio.', '💼')
            : `<table class="tax-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th class="ta-r">Quantity</th>
                    <th class="ta-r">Avg Cost (SEK)</th>
                    <th class="ta-r">Total Cost (SEK)</th>
                  </tr>
                </thead>
                <tbody>
                  ${currentHoldings.sort((a, b) => b.totalCostSEK - a.totalCostSEK).map(h => `
                    <tr>
                      <td>
                        <div class="tax-asset-cell">
                          <span class="tax-asset-icon">${assetEmoji(h.symbol)}</span>
                          <span class="tax-asset-sym">${h.symbol}</span>
                        </div>
                      </td>
                      <td class="ta-r tax-mono">${TaxEngine.formatCrypto(h.quantity)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(h.avgCostSEK, 2)}</td>
                      <td class="ta-r tax-mono">${TaxEngine.formatSEK(h.totalCostSEK)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>`
          }
        </div>

        ${summary.totalDisposals > 0 ? `
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>${state.taxYear} Gain/Loss Summary</h2>
          </div>
          <div class="tax-gain-loss-card">
            <div class="tax-gl-row">
              <span>Total gains</span>
              <span class="tax-green">${TaxEngine.formatSEK(summary.totalGains)}</span>
            </div>
            <div class="tax-gl-row">
              <span>Total losses</span>
              <span class="tax-red">−${TaxEngine.formatSEK(summary.totalLosses)}</span>
            </div>
            <div class="tax-gl-divider"></div>
            <div class="tax-gl-row tax-gl-total">
              <span>Net capital gain</span>
              <span class="${summary.netGainLoss >= 0 ? 'tax-green' : 'tax-red'}">${TaxEngine.formatSEK(summary.netGainLoss)}</span>
            </div>
            ${summary.deductibleLoss > 0 ? `
            <div class="tax-gl-row">
              <span>Deductible loss (70%)</span>
              <span class="tax-amber">${TaxEngine.formatSEK(summary.deductibleLoss)}</span>
            </div>` : ''}
            <div class="tax-gl-row tax-gl-highlight">
              <span>Estimated capital gains tax (30%)</span>
              <span>${TaxEngine.formatSEK(summary.estimatedTax)}</span>
            </div>
            ${summary.totalIncome > 0 ? `
            <div class="tax-gl-row">
              <span>Staking / income (note: income tax applies)</span>
              <span class="tax-amber">${TaxEngine.formatSEK(summary.totalIncome)}</span>
            </div>` : ''}
          </div>
        </div>` : ''}
      </div>
    `;
  }

  // ── Accounts Page ─────────────────────────────────────────
  function renderAccounts() {
    const accounts = TaxEngine.getAccounts();
    const txns = TaxEngine.getTransactions();

    const accTypes = [
      { type: 'metamask',  icon: '🦊', name: 'MetaMask',  description: 'Ethereum wallet — import by address', color: '#e2761b' },
      { type: 'phantom',   icon: '👻', name: 'Phantom',   description: 'Solana wallet — import by address',  color: '#ab9ff2' },
      { type: 'binance',   icon: '🟡', name: 'Binance',   description: 'Upload CSV export from Binance',     color: '#f0b90b' },
      { type: 'kraken',    icon: '🐙', name: 'Kraken',    description: 'Upload CSV from Kraken',             color: '#5741d9' },
      { type: 'bybit',     icon: '🔵', name: 'Bybit',     description: 'Upload CSV from Bybit',              color: '#f7a600' },
      { type: 'coinbase',  icon: '🔵', name: 'Coinbase',  description: 'Upload CSV from Coinbase',           color: '#0052ff' },
      { type: 'csv',       icon: '📄', name: 'CSV Upload', description: 'Generic CSV — any exchange',       color: '#64748b' },
    ];

    return `
      <div class="tax-page" id="tax-page-accounts">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Accounts</h1>
          <span class="tax-page-subtitle">Connect wallets and exchanges</span>
        </div>

        <div class="tax-section">
          <div class="tax-section-header">
            <h2>Recommended</h2>
          </div>
          <div class="tax-account-grid">
            ${accTypes.map(a => `
              <div class="tax-account-card" data-import-type="${a.type}">
                <div class="tax-ac-icon" style="background:${a.color}22;border-color:${a.color}44">${a.icon}</div>
                <div class="tax-ac-info">
                  <div class="tax-ac-name">${a.name}</div>
                  <div class="tax-ac-desc">${a.description}</div>
                </div>
                <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.openImport('${a.type}')">Connect</button>
              </div>
            `).join('')}
          </div>
        </div>

        ${accounts.length > 0 ? `
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>Connected Accounts</h2>
            <span class="tax-section-count">${accounts.length}</span>
          </div>
          <table class="tax-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Added</th>
                <th class="ta-r">Transactions</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${accounts.map(acc => {
                const accTxnCount = txns.filter(t => t.accountId === acc.id).length;
                const typeInfo = accTypes.find(a => a.type === acc.type) || { icon: '📂', name: acc.type };
                return `
                  <tr>
                    <td>
                      <div class="tax-asset-cell">
                        <span>${typeInfo.icon}</span>
                        <div>
                          <div class="tax-acc-name">${acc.label || acc.name || acc.address || acc.type}</div>
                          ${acc.address ? `<div class="tax-acc-addr">${acc.address.slice(0, 8)}...${acc.address.slice(-6)}</div>` : ''}
                        </div>
                      </div>
                    </td>
                    <td><span class="tax-badge">${typeInfo.name}</span></td>
                    <td class="tax-muted">${formatDate(acc.addedAt)}</td>
                    <td class="ta-r tax-mono">${accTxnCount.toLocaleString()}</td>
                    <td class="ta-r">
                      <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.removeAccount('${acc.id}')">Remove</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>` : ''}

        ${renderImportModal()}
      </div>
    `;
  }

  function renderImportModal() {
    if (!state.importModal) return '';

    const modals = {
      metamask: renderWalletImportModal('MetaMask', 'eth', '🦊', 'Ethereum'),
      phantom:  renderWalletImportModal('Phantom', 'sol', '👻', 'Solana'),
      binance:  renderCSVImportModal('Binance', '🟡', 'Go to Binance → Orders → Trade History → Export → Download CSV', 'binance'),
      kraken:   renderCSVImportModal('Kraken', '🐙', 'Go to Kraken → History → Export → All Ledgers → Download CSV', 'kraken'),
      bybit:    renderCSVImportModal('Bybit', '🔵', 'Go to Bybit → Orders → Trade History → Export → Download CSV', 'bybit'),
      coinbase: renderCSVImportModal('Coinbase', '🔵', 'Go to Coinbase → Reports → Generate → Transaction History CSV', 'coinbase'),
      csv:      renderCSVImportModal('Generic CSV', '📄', 'Upload a CSV with columns: date, type/category, asset, amount, price (SEK), fee', 'generic'),
    };

    return modals[state.importModal] || '';
  }

  function renderWalletImportModal(name, chain, icon, network) {
    return `
      <div class="tax-modal-overlay" id="tax-modal">
        <div class="tax-modal">
          <div class="tax-modal-header">
            <span>${icon} Connect ${name}</span>
            <button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button>
          </div>
          <div class="tax-modal-body">
            <p class="tax-modal-desc">Enter your ${network} wallet address (read-only — your private keys are never accessed or stored).</p>
            <div class="tax-form-group">
              <label>Wallet Address</label>
              <input type="text" id="tax-wallet-addr" class="tax-input" placeholder="${chain === 'eth' ? '0x...' : 'Enter Solana address'}" autocomplete="off">
            </div>
            <div class="tax-form-group">
              <label>Label (optional)</label>
              <input type="text" id="tax-wallet-label" class="tax-input" placeholder="My ${name} wallet">
            </div>
            <div id="tax-import-status"></div>
          </div>
          <div class="tax-modal-footer">
            <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeImport()">Cancel</button>
            <button class="tax-btn tax-btn-primary" onclick="TaxUI.importWallet('${chain}')">
              Import Transactions
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderCSVImportModal(name, icon, instructions, parser) {
    return `
      <div class="tax-modal-overlay" id="tax-modal">
        <div class="tax-modal">
          <div class="tax-modal-header">
            <span>${icon} Import ${name}</span>
            <button class="tax-modal-close" onclick="TaxUI.closeImport()">✕</button>
          </div>
          <div class="tax-modal-body">
            <div class="tax-import-instructions">
              <span class="tax-import-step-icon">ℹ️</span>
              <span>${instructions}</span>
            </div>
            <div class="tax-form-group">
              <label>Account Label (optional)</label>
              <input type="text" id="tax-csv-label" class="tax-input" placeholder="My ${name} account">
            </div>
            <div class="tax-form-group">
              <label>Upload CSV File</label>
              <div class="tax-dropzone" id="tax-dropzone" onclick="document.getElementById('tax-csv-file').click()">
                <div class="tax-dropzone-icon">📂</div>
                <div class="tax-dropzone-text">Click to select or drag & drop CSV file</div>
                <div class="tax-dropzone-sub" id="tax-dropzone-filename">Supported: .csv files up to 50 MB</div>
              </div>
              <input type="file" id="tax-csv-file" accept=".csv,.txt" style="display:none" onchange="TaxUI.onCSVSelected(event, '${parser}')">
            </div>
            <div id="tax-import-status"></div>
          </div>
          <div class="tax-modal-footer">
            <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeImport()">Cancel</button>
            <button class="tax-btn tax-btn-primary" id="tax-csv-import-btn" disabled onclick="TaxUI.importCSV('${parser}')">
              Import Transactions
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Transactions Page ─────────────────────────────────────
  function renderTransactions() {
    const allTxns = TaxEngine.getTransactions();
    const accounts = TaxEngine.getAccounts();
    const filtered = filterTransactions(allTxns);
    const sorted   = sortTransactions(filtered);
    const paged    = sorted.slice(state.txPage * state.txPageSize, (state.txPage + 1) * state.txPageSize);

    const cats = ['all', ...Object.values(TaxEngine.CATEGORIES)];

    return `
      <div class="tax-page" id="tax-page-transactions">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Transactions</h1>
          <div class="tax-page-actions">
            <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.openImport('csv')">+ Add CSV</button>
          </div>
        </div>

        <!-- Filter Bar -->
        <div class="tax-filter-bar">
          <div class="tax-search-wrap">
            <span class="tax-search-icon">🔍</span>
            <input type="text" id="tax-tx-search" class="tax-input tax-search-input"
              placeholder="Search asset, hash, notes…"
              value="${state.txFilter.search}"
              oninput="TaxUI.setTxFilter('search', this.value)">
          </div>

          <select class="tax-select tax-filter-select" onchange="TaxUI.setTxFilter('category', this.value)">
            ${cats.map(c => `<option value="${c}" ${state.txFilter.category === c ? 'selected' : ''}>${c === 'all' ? 'All Types' : capitalize(c)}</option>`).join('')}
          </select>

          <select class="tax-select tax-filter-select" onchange="TaxUI.setTxFilter('account', this.value)">
            <option value="all">All Accounts</option>
            ${accounts.map(a => `<option value="${a.id}" ${state.txFilter.account === a.id ? 'selected' : ''}>${a.label || a.type}</option>`).join('')}
          </select>

          <div class="tax-date-range">
            <div class="tax-date-input-wrap">
              <input type="text" id="tax-date-from" class="tax-input tax-date-input"
                placeholder="From date" value="${state.txFilter.dateFrom}" readonly
                onclick="TaxUI.openCalendar('from')">
              ${state.txFilter.dateFrom ? `<button class="tax-date-clear" onclick="TaxUI.setTxFilter('dateFrom','')">✕</button>` : ''}
            </div>
            <span class="tax-date-sep">→</span>
            <div class="tax-date-input-wrap">
              <input type="text" id="tax-date-to" class="tax-input tax-date-input"
                placeholder="To date" value="${state.txFilter.dateTo}" readonly
                onclick="TaxUI.openCalendar('to')">
              ${state.txFilter.dateTo ? `<button class="tax-date-clear" onclick="TaxUI.setTxFilter('dateTo','')">✕</button>` : ''}
            </div>
          </div>

          <label class="tax-check-label">
            <input type="checkbox" ${state.txFilter.needsReview ? 'checked' : ''} onchange="TaxUI.setTxFilter('needsReview', this.checked)">
            Needs Review
          </label>
        </div>

        ${state.calendarOpen ? renderCalendar() : ''}

        <!-- Count + sort row -->
        <div class="tax-table-meta">
          <span class="tax-muted">${filtered.length.toLocaleString()} transactions</span>
          ${filtered.length < allTxns.length ? `<span class="tax-filter-chip">Filtered from ${allTxns.length.toLocaleString()}</span>` : ''}
          <span class="tax-spacer"></span>
          ${renderPagination(filtered.length)}
        </div>

        <!-- Table -->
        ${paged.length === 0
          ? renderEmptyState('No transactions', allTxns.length === 0 ? 'Import transactions from the Accounts page.' : 'No transactions match the current filters.', '📋')
          : `<div class="tax-table-wrap">
              <table class="tax-table tax-tx-table">
                <thead>
                  <tr>
                    <th class="sortable" data-sort="category" onclick="TaxUI.sortTx('category')">Type ${sortIcon('category')}</th>
                    <th class="sortable" data-sort="date" onclick="TaxUI.sortTx('date')">Date ${sortIcon('date')}</th>
                    <th>Asset</th>
                    <th class="ta-r sortable" data-sort="amount" onclick="TaxUI.sortTx('amount')">Amount ${sortIcon('amount')}</th>
                    <th class="ta-r">Price (SEK)</th>
                    <th class="ta-r sortable" data-sort="feeSEK" onclick="TaxUI.sortTx('feeSEK')">Fee ${sortIcon('feeSEK')}</th>
                    <th class="ta-r">Value (SEK)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${paged.map(t => renderTxRow(t)).join('')}
                </tbody>
              </table>
            </div>`
        }
      </div>

      ${state.editTxId ? renderEditTxModal() : ''}
    `;
  }

  function renderTxRow(t) {
    const catInfo = CATEGORY_META[t.category] || { icon: '•', color: '#94a3b8', label: t.category };
    const valueSEK = t.costBasisSEK || (t.priceSEKPerUnit * t.amount) || 0;
    const accountName = getAccountName(t.accountId);

    return `
      <tr class="${t.needsReview ? 'tax-row-review' : ''}">
        <td>
          <span class="tax-cat-badge" style="background:${catInfo.color}22;color:${catInfo.color}">
            ${catInfo.icon} ${catInfo.label}
          </span>
        </td>
        <td class="tax-muted tax-nowrap">${formatDateShort(t.date)}</td>
        <td>
          <div class="tax-asset-cell">
            <span class="tax-asset-sym">${t.assetSymbol || '—'}</span>
            ${t.assetName ? `<span class="tax-asset-name">${t.assetName.slice(0, 20)}</span>` : ''}
            ${accountName ? `<span class="tax-acc-pill">${accountName}</span>` : ''}
          </div>
          ${t.category === 'trade' && t.inAsset ? `<div class="tax-trade-in">→ ${t.inAmount ? TaxEngine.formatCrypto(t.inAmount, 4) : ''} ${t.inAsset}</div>` : ''}
        </td>
        <td class="ta-r tax-mono">${TaxEngine.formatCrypto(t.amount, 8)}</td>
        <td class="ta-r tax-mono">${t.priceSEKPerUnit ? TaxEngine.formatSEK(t.priceSEKPerUnit, 4) : '—'}</td>
        <td class="ta-r tax-mono">${t.feeSEK ? TaxEngine.formatSEK(t.feeSEK, 2) : '—'}</td>
        <td class="ta-r tax-mono">${valueSEK ? TaxEngine.formatSEK(valueSEK) : '—'}</td>
        <td>
          <div class="tax-row-actions">
            ${t.needsReview ? '<span class="tax-review-dot" title="Needs review">⚠️</span>' : ''}
            <button class="tax-icon-btn" title="Edit" onclick="TaxUI.editTx('${t.id}')">✏️</button>
            <button class="tax-icon-btn tax-icon-del" title="Delete" onclick="TaxUI.deleteTx('${t.id}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderCalendar() {
    const year  = state.calendarYear;
    const month = state.calendarMonth;
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

    // Selected date
    const selDate = state.calendarField === 'from' ? state.txFilter.dateFrom : state.txFilter.dateTo;

    let cells = '';
    const blanks = firstDay === 0 ? 6 : firstDay - 1; // Mon-first
    for (let i = 0; i < blanks; i++) cells += '<div class="tax-cal-cell empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isSel = selDate === dateStr;
      cells += `<div class="tax-cal-cell${isSel ? ' selected' : ''}" onclick="TaxUI.selectDate('${dateStr}')">${d}</div>`;
    }

    return `
      <div class="tax-calendar-wrap" id="tax-calendar">
        <div class="tax-calendar">
          <div class="tax-cal-header">
            <button class="tax-cal-nav" onclick="TaxUI.calNav(-1)">‹</button>
            <span>${MONTHS[month]} ${year}</span>
            <button class="tax-cal-nav" onclick="TaxUI.calNav(1)">›</button>
          </div>
          <div class="tax-cal-grid">
            ${['Mo','Tu','We','Th','Fr','Sa','Su'].map(d => `<div class="tax-cal-dow">${d}</div>`).join('')}
            ${cells}
          </div>
          <div class="tax-cal-footer">
            <button class="tax-btn tax-btn-xs tax-btn-ghost" onclick="TaxUI.closeCalendar()">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderPagination(total) {
    const totalPages = Math.ceil(total / state.txPageSize);
    if (totalPages <= 1) return '';
    return `
      <div class="tax-pagination">
        <button class="tax-page-btn" ${state.txPage === 0 ? 'disabled' : ''} onclick="TaxUI.setPage(${state.txPage - 1})">‹</button>
        <span class="tax-page-info">${state.txPage + 1} / ${totalPages}</span>
        <button class="tax-page-btn" ${state.txPage >= totalPages - 1 ? 'disabled' : ''} onclick="TaxUI.setPage(${state.txPage + 1})">›</button>
      </div>
    `;
  }

  function renderEditTxModal() {
    const txns = TaxEngine.getTransactions();
    const t = txns.find(tx => tx.id === state.editTxId);
    if (!t) return '';
    const cats = Object.values(TaxEngine.CATEGORIES);
    return `
      <div class="tax-modal-overlay" id="tax-modal">
        <div class="tax-modal">
          <div class="tax-modal-header">
            <span>✏️ Edit Transaction</span>
            <button class="tax-modal-close" onclick="TaxUI.closeEditTx()">✕</button>
          </div>
          <div class="tax-modal-body">
            <div class="tax-form-grid">
              <div class="tax-form-group">
                <label>Date</label>
                <input type="datetime-local" id="edit-date" class="tax-input" value="${(t.date || '').slice(0,16)}">
              </div>
              <div class="tax-form-group">
                <label>Type</label>
                <select id="edit-category" class="tax-select">
                  ${cats.map(c => `<option value="${c}" ${t.category === c ? 'selected' : ''}>${capitalize(c)}</option>`).join('')}
                </select>
              </div>
              <div class="tax-form-group">
                <label>Asset Symbol</label>
                <input type="text" id="edit-asset" class="tax-input" value="${t.assetSymbol || ''}">
              </div>
              <div class="tax-form-group">
                <label>Amount</label>
                <input type="number" id="edit-amount" class="tax-input" value="${t.amount || 0}" step="any">
              </div>
              <div class="tax-form-group">
                <label>Price per Unit (SEK)</label>
                <input type="number" id="edit-price" class="tax-input" value="${t.priceSEKPerUnit || 0}" step="any">
              </div>
              <div class="tax-form-group">
                <label>Fee (SEK)</label>
                <input type="number" id="edit-fee" class="tax-input" value="${t.feeSEK || 0}" step="any">
              </div>
            </div>
            <div class="tax-form-group">
              <label>Notes</label>
              <input type="text" id="edit-notes" class="tax-input" value="${t.notes || ''}">
            </div>
            <div class="tax-form-group">
              <label class="tax-check-label">
                <input type="checkbox" id="edit-reviewed" ${!t.needsReview ? 'checked' : ''}>
                Mark as reviewed (remove ⚠️ flag)
              </label>
            </div>
          </div>
          <div class="tax-modal-footer">
            <button class="tax-btn tax-btn-ghost" onclick="TaxUI.closeEditTx()">Cancel</button>
            <button class="tax-btn tax-btn-primary" onclick="TaxUI.saveEditTx('${t.id}')">Save Changes</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Review Page ───────────────────────────────────────────
  function renderReview() {
    const txns = TaxEngine.getTransactions().filter(t => t.needsReview);

    return `
      <div class="tax-page" id="tax-page-review">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Review</h1>
          <span class="tax-page-subtitle">${txns.length} transactions need attention</span>
        </div>

        ${txns.length === 0 ? `
          <div class="tax-review-done">
            <div class="tax-review-done-icon">✅</div>
            <div class="tax-review-done-title">All transactions reviewed!</div>
            <div class="tax-review-done-sub">Your transaction data is complete and ready for tax calculation.</div>
          </div>
        ` : `
          <div class="tax-review-info">
            <span class="tax-review-info-icon">ℹ️</span>
            <span>These transactions are missing SEK prices or have been flagged for review. Edit each one to add the correct SEK value at time of transaction.</span>
          </div>

          <div class="tax-review-list">
            ${txns.map(t => renderReviewCard(t)).join('')}
          </div>

          <div class="tax-review-actions">
            <button class="tax-btn tax-btn-ghost" onclick="TaxUI.markAllReviewed()">Mark All As Reviewed</button>
          </div>
        `}

        ${state.editTxId ? renderEditTxModal() : ''}
      </div>
    `;
  }

  function renderReviewCard(t) {
    const catInfo = CATEGORY_META[t.category] || { icon: '•', color: '#94a3b8', label: t.category };
    return `
      <div class="tax-review-card">
        <div class="tax-review-card-left">
          <span class="tax-cat-badge" style="background:${catInfo.color}22;color:${catInfo.color}">${catInfo.icon} ${catInfo.label}</span>
          <div class="tax-review-card-asset">${t.assetSymbol || '—'} <span class="tax-muted">${TaxEngine.formatCrypto(t.amount, 8)}</span></div>
          <div class="tax-muted">${formatDateShort(t.date)}</div>
        </div>
        <div class="tax-review-card-issue">
          <span class="tax-review-issue-tag">⚠️ ${t.notes || 'Missing SEK price'}</span>
        </div>
        <div class="tax-review-card-actions">
          <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.editTx('${t.id}')">Edit</button>
          <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.markReviewed('${t.id}')">Mark OK</button>
        </div>
      </div>
    `;
  }

  // ── Reports Page ──────────────────────────────────────────
  function renderReports() {
    const result = getOrComputeTaxResult();
    const { summary, disposals } = result;
    const k4 = TaxEngine.generateK4Summary(result);

    return `
      <div class="tax-page" id="tax-page-reports">
        <div class="tax-page-header">
          <h1 class="tax-page-title">Tax Reports</h1>
          <span class="tax-page-subtitle">${state.taxYear} — Swedish Skatteverket / K4</span>
        </div>

        <!-- Summary card -->
        <div class="tax-report-hero">
          <div class="tax-rh-year">${state.taxYear}</div>
          <div class="tax-rh-title">Capital Gains Summary</div>
          <div class="tax-rh-grid">
            <div class="tax-rh-item">
              <div class="tax-rh-label">Gains (Box D)</div>
              <div class="tax-rh-val tax-green">${TaxEngine.formatSEK(k4.box_d_gains.gain)}</div>
            </div>
            <div class="tax-rh-item">
              <div class="tax-rh-label">Losses (Box D)</div>
              <div class="tax-rh-val tax-red">${TaxEngine.formatSEK(k4.box_d_losses.loss)}</div>
            </div>
            <div class="tax-rh-item">
              <div class="tax-rh-label">Net Gain/Loss</div>
              <div class="tax-rh-val ${summary.netGainLoss >= 0 ? 'tax-green' : 'tax-red'}">${TaxEngine.formatSEK(summary.netGainLoss)}</div>
            </div>
            <div class="tax-rh-item tax-rh-highlight">
              <div class="tax-rh-label">Estimated Tax (30%)</div>
              <div class="tax-rh-val">${TaxEngine.formatSEK(summary.estimatedTax)}</div>
            </div>
          </div>
        </div>

        <!-- K4 breakdown -->
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>K4 — Box D (Övriga tillgångar — Krypto)</h2>
          </div>

          <div class="tax-k4-section">
            <div class="tax-k4-header">Gains (Vinst)</div>
            <div class="tax-k4-row">
              <span>Total sale proceeds</span>
              <span class="tax-mono">${TaxEngine.formatSEK(k4.box_d_gains.proceeds)}</span>
            </div>
            <div class="tax-k4-row">
              <span>Less: cost basis</span>
              <span class="tax-mono">−${TaxEngine.formatSEK(k4.box_d_gains.costBasis)}</span>
            </div>
            <div class="tax-k4-row tax-k4-total">
              <span>Net gain</span>
              <span class="tax-mono tax-green">${TaxEngine.formatSEK(k4.box_d_gains.gain)}</span>
            </div>
          </div>

          ${k4.box_d_losses.loss > 0 ? `
          <div class="tax-k4-section">
            <div class="tax-k4-header">Losses (Förlust)</div>
            <div class="tax-k4-row">
              <span>Total sale proceeds</span>
              <span class="tax-mono">${TaxEngine.formatSEK(k4.box_d_losses.proceeds)}</span>
            </div>
            <div class="tax-k4-row">
              <span>Less: cost basis</span>
              <span class="tax-mono">−${TaxEngine.formatSEK(k4.box_d_losses.costBasis)}</span>
            </div>
            <div class="tax-k4-row tax-k4-total">
              <span>Net loss</span>
              <span class="tax-mono tax-red">−${TaxEngine.formatSEK(k4.box_d_losses.loss)}</span>
            </div>
            <div class="tax-k4-row">
              <span>Deductible amount (70%)</span>
              <span class="tax-mono tax-amber">−${TaxEngine.formatSEK(k4.deductibleLoss)}</span>
            </div>
          </div>` : ''}
        </div>

        <!-- Disclaimer -->
        <div class="tax-disclaimer">
          <span class="tax-disclaimer-icon">⚠️</span>
          <div>
            <strong>Disclaimer:</strong> This calculator uses Genomsnittsmetoden (average cost method) as required by Skatteverket for cryptocurrencies. Results are estimates only. Always verify with a certified Swedish tax advisor. You are responsible for filing accurate returns.
          </div>
        </div>

        <!-- Disposal list -->
        ${disposals.length > 0 ? `
        <div class="tax-section">
          <div class="tax-section-header">
            <h2>All Disposals ${state.taxYear}</h2>
            <div class="tax-report-dl-btns">
              <button class="tax-btn tax-btn-sm tax-btn-primary" onclick="TaxUI.downloadK4CSV()">⬇ Download K4 CSV</button>
              <button class="tax-btn tax-btn-sm tax-btn-ghost" onclick="TaxUI.printReport()">🖨 Print</button>
            </div>
          </div>
          <div class="tax-table-wrap">
            <table class="tax-table" id="tax-k4-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Asset</th>
                  <th class="ta-r">Amount Sold</th>
                  <th class="ta-r">Proceeds (SEK)</th>
                  <th class="ta-r">Cost Basis (SEK)</th>
                  <th class="ta-r">Gain/Loss (SEK)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${disposals.map(d => `
                  <tr class="${d.needsReview ? 'tax-row-review' : ''}">
                    <td class="tax-muted tax-nowrap">${formatDateShort(d.date)}</td>
                    <td>
                      <div class="tax-asset-cell">
                        <span class="tax-asset-sym">${d.assetSymbol}</span>
                        ${d.isTrade ? `<span class="tax-trade-tag">↔ ${d.inAsset || ''}</span>` : ''}
                      </div>
                    </td>
                    <td class="ta-r tax-mono">${TaxEngine.formatCrypto(d.amountSold, 8)}</td>
                    <td class="ta-r tax-mono">${TaxEngine.formatSEK(d.proceedsSEK)}</td>
                    <td class="ta-r tax-mono">${TaxEngine.formatSEK(d.costBasisSEK)}</td>
                    <td class="ta-r tax-mono ${d.gainLossSEK >= 0 ? 'tax-green' : 'tax-red'}">
                      ${d.gainLossSEK >= 0 ? '' : '−'}${TaxEngine.formatSEK(Math.abs(d.gainLossSEK))}
                    </td>
                    <td>${d.needsReview ? '<span title="Needs review">⚠️</span>' : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>` : `
          <div class="tax-section">
            ${renderEmptyState('No disposals in ' + state.taxYear, 'No sell transactions found for this tax year.', '📊')}
          </div>
        `}
      </div>
    `;
  }

  // ── Helpers ───────────────────────────────────────────────
  function getOrComputeTaxResult() {
    if (!state.taxResult || state.taxResult.year !== state.taxYear) {
      state.taxResult = TaxEngine.computeTaxYear(state.taxYear);
    }
    return state.taxResult;
  }

  function filterTransactions(txns) {
    const f = state.txFilter;
    return txns.filter(t => {
      if (f.search) {
        const q = f.search.toLowerCase();
        if (!t.assetSymbol?.toLowerCase().includes(q) &&
            !t.txHash?.toLowerCase().includes(q) &&
            !t.notes?.toLowerCase().includes(q) &&
            !t.assetName?.toLowerCase().includes(q)) return false;
      }
      if (f.category !== 'all' && t.category !== f.category) return false;
      if (f.account !== 'all' && t.accountId !== f.account) return false;
      if (f.dateFrom && t.date < f.dateFrom) return false;
      if (f.dateTo   && t.date > f.dateTo + 'T23:59:59') return false;
      if (f.needsReview && !t.needsReview) return false;
      return true;
    });
  }

  function sortTransactions(txns) {
    const { field, dir } = state.txSort;
    return [...txns].sort((a, b) => {
      let av = a[field], bv = b[field];
      if (field === 'date') { av = a.date; bv = b.date; }
      if (field === 'amount')  { av = parseFloat(a.amount) || 0; bv = parseFloat(b.amount) || 0; }
      if (field === 'feeSEK')  { av = parseFloat(a.feeSEK) || 0; bv = parseFloat(b.feeSEK) || 0; }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function sortIcon(field) {
    if (state.txSort.field !== field) return '<span class="sort-icon">⇅</span>';
    return state.txSort.dir === 'asc'
      ? '<span class="sort-icon active">↑</span>'
      : '<span class="sort-icon active">↓</span>';
  }

  function getAccountName(id) {
    const acc = TaxEngine.getAccounts().find(a => a.id === id);
    return acc ? (acc.label || acc.type || '').slice(0, 12) : '';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('sv-SE');
  }

  function formatDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('sv-SE') + ' ' + d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : s;
  }

  function assetEmoji(sym) {
    const map = { BTC: '₿', ETH: 'Ξ', SOL: '◎', BNB: '🟡', USDT: '💵', USDC: '💵' };
    return map[sym] || sym?.slice(0, 2) || '?';
  }

  function renderEmptyState(title, sub, icon) {
    return `
      <div class="tax-empty">
        <div class="tax-empty-icon">${icon}</div>
        <div class="tax-empty-title">${title}</div>
        <div class="tax-empty-sub">${sub}</div>
      </div>
    `;
  }

  // ── Category Metadata ─────────────────────────────────────
  const CATEGORY_META = {
    buy:          { icon: '↓', color: '#22c55e', label: 'Buy' },
    sell:         { icon: '↑', color: '#ef4444', label: 'Sell' },
    trade:        { icon: '↔', color: '#8b5cf6', label: 'Trade' },
    receive:      { icon: '⬇', color: '#06b6d4', label: 'Receive' },
    send:         { icon: '⬆', color: '#f59e0b', label: 'Send' },
    income:       { icon: '★', color: '#f59e0b', label: 'Income' },
    fee:          { icon: '💸', color: '#94a3b8', label: 'Fee' },
    transfer_in:  { icon: '←', color: '#64748b', label: 'Transfer In' },
    transfer_out: { icon: '→', color: '#64748b', label: 'Transfer Out' },
  };

  // ── Event Binding ─────────────────────────────────────────
  function bindEvents() {
    // Nav items
    document.querySelectorAll('.tax-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        state.page = btn.dataset.page;
        render();
      });
    });

    // Year picker
    const yearPicker = document.getElementById('tax-year-picker');
    if (yearPicker) {
      yearPicker.addEventListener('change', () => {
        state.taxYear = parseInt(yearPicker.value);
        state.taxResult = null; // invalidate cache
        TaxEngine.saveSettings({ ...TaxEngine.getSettings(), taxYear: state.taxYear });
        render();
      });
    }

    // Account card clicks
    document.querySelectorAll('.tax-account-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return; // handled by inline onclick
        const type = card.dataset.importType;
        if (type) openImport(type);
      });
    });

    // CSV drag & drop
    const dz = document.getElementById('tax-dropzone');
    if (dz) {
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', e => {
        e.preventDefault();
        dz.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleCSVFile(file, state.importModal);
      });
    }

    // Close calendar on outside click
    if (state.calendarOpen) {
      setTimeout(() => {
        document.addEventListener('click', closeCalendarOutside, { once: true });
      }, 100);
    }
  }

  function closeCalendarOutside(e) {
    const cal = document.getElementById('tax-calendar');
    if (cal && !cal.contains(e.target)) {
      state.calendarOpen = false;
      renderTransactionsInPlace();
    }
  }

  function renderTransactionsInPlace() {
    const panel = document.getElementById('tax-panel');
    if (!panel) return;
    // Light re-render instead of full re-render
    const mainEl = panel.querySelector('.tax-main');
    if (mainEl) mainEl.innerHTML = renderPage();
    bindEvents();
  }

  // ── Public Actions ────────────────────────────────────────
  function openImport(type) {
    state.importModal = type;
    render();
  }

  function closeImport() {
    state.importModal = null;
    render();
  }

  function setTxFilter(key, value) {
    state.txFilter[key] = value;
    state.txPage = 0;
    renderTransactionsInPlace();
  }

  function sortTx(field) {
    if (state.txSort.field === field) {
      state.txSort.dir = state.txSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.txSort.field = field;
      state.txSort.dir = 'desc';
    }
    renderTransactionsInPlace();
  }

  function setPage(p) {
    state.txPage = p;
    renderTransactionsInPlace();
  }

  function openCalendar(field) {
    state.calendarField = field;
    state.calendarOpen = true;
    // Set calendar to currently selected month if any
    const selDate = field === 'from' ? state.txFilter.dateFrom : state.txFilter.dateTo;
    if (selDate) {
      const d = new Date(selDate);
      state.calendarMonth = d.getMonth();
      state.calendarYear  = d.getFullYear();
    } else {
      state.calendarMonth = new Date().getMonth();
      state.calendarYear  = new Date().getFullYear();
    }
    renderTransactionsInPlace();
  }

  function closeCalendar() {
    state.calendarOpen = false;
    renderTransactionsInPlace();
  }

  function calNav(delta) {
    state.calendarMonth += delta;
    if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear++; }
    if (state.calendarMonth < 0)  { state.calendarMonth = 11; state.calendarYear--; }
    renderTransactionsInPlace();
  }

  function selectDate(dateStr) {
    if (state.calendarField === 'from') {
      state.txFilter.dateFrom = dateStr;
    } else {
      state.txFilter.dateTo = dateStr;
    }
    state.calendarOpen = false;
    state.txPage = 0;
    renderTransactionsInPlace();
  }

  function editTx(id) {
    state.editTxId = id;
    renderTransactionsInPlace();
  }

  function closeEditTx() {
    state.editTxId = null;
    render();
  }

  function saveEditTx(id) {
    const date     = document.getElementById('edit-date')?.value;
    const category = document.getElementById('edit-category')?.value;
    const asset    = document.getElementById('edit-asset')?.value?.toUpperCase();
    const amount   = parseFloat(document.getElementById('edit-amount')?.value) || 0;
    const price    = parseFloat(document.getElementById('edit-price')?.value) || 0;
    const fee      = parseFloat(document.getElementById('edit-fee')?.value) || 0;
    const notes    = document.getElementById('edit-notes')?.value || '';
    const reviewed = document.getElementById('edit-reviewed')?.checked;

    TaxEngine.updateTransaction(id, {
      date:           date ? new Date(date).toISOString() : undefined,
      category,
      assetSymbol:    asset,
      amount,
      priceSEKPerUnit: price,
      costBasisSEK:   price * amount,
      feeSEK:         fee,
      notes,
      needsReview:    !reviewed,
    });
    state.editTxId = null;
    state.taxResult = null; // invalidate
    render();
    showTaxToast('✅', 'Transaction updated');
  }

  function deleteTx(id) {
    if (!confirm('Delete this transaction? This will affect tax calculations.')) return;
    TaxEngine.deleteTransaction(id);
    state.taxResult = null;
    renderTransactionsInPlace();
    showTaxToast('🗑️', 'Transaction deleted');
  }

  function markReviewed(id) {
    TaxEngine.updateTransaction(id, { needsReview: false });
    state.taxResult = null;
    render();
  }

  function markAllReviewed() {
    const txns = TaxEngine.getTransactions();
    txns.forEach(t => { if (t.needsReview) TaxEngine.updateTransaction(t.id, { needsReview: false }); });
    state.taxResult = null;
    render();
  }

  function removeAccount(id) {
    if (!confirm('Remove this account? All imported transactions from it will also be deleted.')) return;
    TaxEngine.removeAccount(id);
    state.taxResult = null;
    render();
    showTaxToast('✅', 'Account removed');
  }

  // ── CSV File Handling ─────────────────────────────────────
  let pendingCSVText = null;
  let pendingCSVParser = null;

  function onCSVSelected(event, parser) {
    const file = event.target.files[0];
    if (file) handleCSVFile(file, parser);
  }

  function handleCSVFile(file, parser) {
    pendingCSVParser = parser;
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingCSVText = e.target.result;
      const fn = document.getElementById('tax-dropzone-filename');
      if (fn) fn.textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      const btn = document.getElementById('tax-csv-import-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Import Transactions'; }
      // Show preview count
      const status = document.getElementById('tax-import-status');
      if (status) {
        try {
          const preview = parser === 'generic' ? parser : parser;
          const lines = pendingCSVText.trim().split('\n').length - 1;
          status.innerHTML = `<div class="tax-import-preview">Found approximately ${lines} rows in CSV</div>`;
        } catch {}
      }
    };
    reader.readAsText(file);
  }

  function importCSV(parser) {
    if (!pendingCSVText) return;
    const status = document.getElementById('tax-import-status');
    if (status) status.innerHTML = '<div class="tax-import-status-loading">⏳ Importing…</div>';

    const label = document.getElementById('tax-csv-label')?.value || '';
    const acc = TaxEngine.addAccount({ type: parser === 'generic' ? 'csv' : parser, label });

    let txns = [];
    try {
      switch (parser) {
        case 'binance':  txns = TaxEngine.parseBinanceCSV(pendingCSVText, acc.id); break;
        case 'kraken':   txns = TaxEngine.parseKrakenCSV(pendingCSVText, acc.id);  break;
        case 'bybit':    txns = TaxEngine.parseBybitCSV(pendingCSVText, acc.id);   break;
        case 'coinbase': txns = TaxEngine.parseCoinbaseCSV(pendingCSVText, acc.id); break;
        default:         txns = TaxEngine.parseGenericCSV(pendingCSVText, acc.id);  break;
      }
    } catch (e) {
      if (status) status.innerHTML = `<div class="tax-import-error">❌ Parse error: ${e.message}</div>`;
      return;
    }

    const added = TaxEngine.addTransactions(txns);
    pendingCSVText = null;
    state.importModal = null;
    state.taxResult = null;
    state.page = 'transactions';
    render();
    showTaxToast('✅', `Imported ${added} transactions`, `${txns.length - added} duplicates skipped`);
  }

  async function importWallet(chain) {
    const addr  = document.getElementById('tax-wallet-addr')?.value?.trim();
    const label = document.getElementById('tax-wallet-label')?.value?.trim();
    if (!addr) { showTaxToast('⚠️', 'Enter a wallet address'); return; }

    const status = document.getElementById('tax-import-status');
    if (status) status.innerHTML = '<div class="tax-import-status-loading">⏳ Fetching transactions…</div>';

    try {
      const acc = TaxEngine.addAccount({ type: chain === 'eth' ? 'metamask' : 'phantom', label, address: addr });
      let txns = [];
      if (chain === 'sol') {
        txns = await TaxEngine.importSolanaWallet(addr, acc.id);
      } else {
        txns = await TaxEngine.importEthWallet(addr, acc.id);
      }

      const added = TaxEngine.addTransactions(txns);
      state.importModal = null;
      state.taxResult = null;
      state.page = 'transactions';
      render();
      showTaxToast('✅', `Imported ${added} transactions from ${chain.toUpperCase()} wallet`);
    } catch (e) {
      if (status) status.innerHTML = `<div class="tax-import-error">❌ ${e.message}</div>`;
    }
  }

  // ── Report Export ─────────────────────────────────────────
  function downloadK4CSV() {
    const result = getOrComputeTaxResult();
    const csv = TaxEngine.generateK4CSV(result);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `K4_crypto_${state.taxYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printReport() {
    window.print();
  }

  // ── Toast ─────────────────────────────────────────────────
  function showTaxToast(icon, title, msg = '') {
    if (typeof showToast === 'function') {
      showToast(icon, title, msg, 'success');
    } else {
      console.log(`[TaxUI] ${icon} ${title} ${msg}`);
    }
  }

  // ── Init / Navigation ─────────────────────────────────────
  function init() {
    const panel = document.getElementById('tax-panel');
    if (!panel) return;
    state.taxYear = TaxEngine.getSettings().taxYear;
    render();
  }

  function navigate(page) {
    state.page = page;
    render();
  }

  // ── Public API ────────────────────────────────────────────
  return {
    init, render, navigate,
    // Actions (called by inline onclick)
    openImport, closeImport,
    importWallet, importCSV, onCSVSelected,
    setTxFilter, sortTx, setPage,
    openCalendar, closeCalendar, calNav, selectDate,
    editTx, closeEditTx, saveEditTx, deleteTx,
    markReviewed, markAllReviewed,
    removeAccount,
    downloadK4CSV, printReport,
  };

})();

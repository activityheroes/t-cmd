/* ============================================================
   T-CMD — Whales & Wallets Panel
   Identify smart money, whales, ecosystem players on Solana.
   Admin-curated wallet list. Users browse + inspect activity.
   ============================================================ */

const WhalesPanel = (() => {

  let _chain = 'SOL';

  // Category inference from label/emoji
  function inferCategory(label = '') {
    const l = label.toLowerCase();
    if (/whale|fund|vc|capital|dao|treasury/.test(l)) return 'whale';
    if (/smart|alpha|sniper|wizard|degen|sigma/.test(l)) return 'smart';
    if (/eco|protocol|team|builder|dev/.test(l)) return 'eco';
    return 'power';
  }

  const CAT_META = {
    smart: { label: 'Smart Money', cls: 'cat-smart', icon: '🧠' },
    whale:  { label: 'Whale',       cls: 'cat-whale',  icon: '🐋' },
    eco:    { label: 'Ecosystem',   cls: 'cat-eco',    icon: '🌿' },
    power:  { label: 'Power User',  cls: 'cat-power',  icon: '⚡' }
  };

  const CHAIN_LABELS = {
    SOL:  { icon: '◎', name: 'Solana',   color: '#9945FF' },
    ETH:  { icon: 'Ξ', name: 'Ethereum', color: '#627EEA' },
    BASE: { icon: '🔵', name: 'Base',    color: '#0052FF' },
    BSC:  { icon: '🟡', name: 'BSC',     color: '#F0B90B' }
  };

  async function render() {
    const root = document.getElementById('whales-panel-root');
    if (!root) return;

    // Feature gate — admins always have access
    const isAdmin = typeof AuthManager !== 'undefined' && AuthManager.isAdmin();
    if (typeof AuthManager !== 'undefined' && !isAdmin && !AuthManager.hasFeature('whalesWallets')) {
      root.innerHTML = `
        <div class="whales-locked">
          <div class="whales-locked-icon">🔒</div>
          <div class="whales-locked-title">Whales & Wallets</div>
          <div class="whales-locked-desc">
            Identify funds, whales, ecosystem players and power users winning on Solana.<br>
            Analyze holder inflows/outflows, conviction, and wallet behavior patterns.<br><br>
            <strong>Contact admin to unlock this feature.</strong>
          </div>
        </div>`;
      return;
    }

    root.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">
      <div style="font-size:28px;animation:spin 1s linear infinite;display:inline-block;">⟳</div>
      <div style="margin-top:8px;">Loading wallets…</div>
    </div>`;

    const allWallets = await WalletTracker.getWallets();
    const chainWallets = allWallets.filter(w => w.chain === _chain);

    // Stats
    const cats = chainWallets.map(w => inferCategory(w.label));
    const smartCount = cats.filter(c => c === 'smart').length;
    const whaleCount = cats.filter(c => c === 'whale').length;

    const chainTabs = Object.entries(CHAIN_LABELS).map(([k, v]) => `
      <button class="whales-chain-tab${k === _chain ? ' active' : ''}"
        onclick="WhalesPanel.switchChain('${k}')">
        ${v.icon} ${k}
      </button>`).join('');

    const tableRows = chainWallets.length ? chainWallets.map((w, i) => {
      const cat = inferCategory(w.label);
      const meta = CAT_META[cat];
      const cfg = WalletTracker.CHAIN_CONFIG[_chain];
      const explorerUrl = cfg?.explorer(w.address) || '#';
      const short = w.address.slice(0, 6) + '…' + w.address.slice(-4);
      return `<tr>
        <td>
          <span class="whale-category-badge ${meta.cls}">${meta.icon} ${meta.label}</span>
        </td>
        <td>
          <div style="font-weight:600;font-size:12.5px;">${w.label}</div>
          <a href="${explorerUrl}" target="_blank"
            style="font-size:10.5px;color:var(--accent-cyan);font-family:var(--font-mono);text-decoration:none;"
            title="${w.address}">${short} ↗</a>
        </td>
        <td style="font-size:11px;color:var(--text-muted);">${_chain}</td>
        <td>
          <div class="whale-row-actions">
            <button class="whale-activity-btn" onclick="WhalesPanel.fetchActivity('${w.id}','${w.address}')">
              📋 Activity
            </button>
          </div>
          <div id="whale-act-${w.id}" style="display:none;margin-top:6px;"></div>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="4" class="whales-empty">
        No wallets tracked on ${CHAIN_LABELS[_chain].name} yet.<br>
        <span style="font-size:12px;">Ask admin to add wallets via Admin Panel → Wallet Tracker.</span>
      </td></tr>`;

    root.innerHTML = `
      <div class="whales-panel">
        <div class="whales-header">
          <div>
            <div class="whales-title">🐋 Whales & Wallets</div>
            <div class="whales-subtitle">
              Identify funds, whales, ecosystem players and power users winning on-chain.
              Analyze inflows/outflows, conviction and wallet behavior patterns.
            </div>
          </div>
          <div class="whales-stats-row">
            <div class="whale-stat-card">
              <div class="whale-stat-val">${chainWallets.length}</div>
              <div class="whale-stat-label">Tracked</div>
            </div>
            <div class="whale-stat-card">
              <div class="whale-stat-val" style="color:var(--accent-purple);">${smartCount}</div>
              <div class="whale-stat-label">Smart Money</div>
            </div>
            <div class="whale-stat-card">
              <div class="whale-stat-val" style="color:var(--accent-cyan);">${whaleCount}</div>
              <div class="whale-stat-label">Whales</div>
            </div>
          </div>
        </div>

        <div class="whales-chain-bar">${chainTabs}</div>

        <div class="whales-table-wrap">
          <table class="whales-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Wallet</th>
                <th>Chain</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>

        <div style="font-size:11.5px;color:var(--text-muted);padding:4px 0 8px;">
          Wallets curated by admin. Activity pulled from public RPC endpoints.
          ${_chain !== 'SOL' ? ' EVM activity requires an API key set in Admin → Wallet Tracker.' : ''}
        </div>
      </div>`;
  }

  async function fetchActivity(walletId, address) {
    const el = document.getElementById(`whale-act-${walletId}`);
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Fetching…</span>';

    const activity = _chain === 'SOL'
      ? await WalletTracker.fetchSolanaActivity(address, 5)
      : await WalletTracker.fetchEvmActivity(address, _chain);

    if (activity.error) {
      el.innerHTML = `<span style="font-size:11px;color:var(--accent-amber);">⚠️ ${activity.error}</span>`;
      return;
    }
    if (!activity.recent?.length) {
      el.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">No recent activity.</span>';
      return;
    }
    el.innerHTML = `<div class="wt-activity-list">
      ${activity.recent.map(tx => `
        <div class="wt-tx-row">
          ${tx.type ? `<span class="wt-tx-type ${tx.type.toLowerCase()}">${tx.type}</span>` : ''}
          ${tx.token ? `<span class="wt-tx-token">${tx.token}</span>` : ''}
          ${tx.amount ? `<span class="wt-tx-amount">${tx.amount}</span>` : ''}
          <span class="wt-tx-time">${tx.timeAgo}</span>
          ${tx.url ? `<a href="${tx.url}" target="_blank" class="wt-tx-link">tx ↗</a>` : ''}
        </div>`).join('')}
    </div>`;
  }

  function switchChain(chain) {
    _chain = chain;
    render();
  }

  return { render, fetchActivity, switchChain };
})();

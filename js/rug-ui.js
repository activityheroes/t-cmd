/**
 * RugUI — Rug Risk Panel UI controller
 * Ties together RugChecker + ClusterDetector with the DOM
 *
 * Public API (also window-scoped):
 *   RugUI.openPanel(address, chain?, name?)
 *   RugUI.closePanel()
 *   RugUI.copyReport()
 *   RugUI.rerun()
 *
 * T-CMD · Trade Command
 */
const RugUI = (() => {

  let _last = null; // { rugResult, clusterResult, bundleResult }

  // ── Signal metadata ──────────────────────────────────────────
  const SIGNALS = [
    { key: 'devHoldings',         icon: '👤', label: 'Dev Wallet Holdings'     },
    { key: 'lpNotLocked',         icon: '🔒', label: 'LP Lock Status'          },
    { key: 'mintExists',          icon: '🪙', label: 'Mint Authority'           },
    { key: 'blacklist',           icon: '🚫', label: 'Blacklist / Freeze Auth'  },
    { key: 'adjustableTax',       icon: '💰', label: 'Adjustable Tax'           },
    { key: 'lowLiquidity',        icon: '💧', label: 'Liquidity vs Market Cap'  },
    { key: 'holderConcentration', icon: '🐋', label: 'Holder Concentration'     },
    { key: 'liquidityRemoved',    icon: '🏃', label: 'Liquidity Removal Signal' },
    { key: 'washTrading',         icon: '🔄', label: 'Wash Trading'             },
    { key: 'repeatWallets',       icon: '👁️', label: 'Repeat Wallet Patterns'  },
    { key: 'devPriorRugs',        icon: '📜', label: 'Developer History'        },
    { key: 'ownershipActive',     icon: '🔑', label: 'Ownership Renounced'      }
  ];

  // ── Score → risk level ───────────────────────────────────────
  function level(score) {
    if (score >= 75) return { label: 'HIGH RISK',    color: '#ef4444', cls: 'rl-high'   };
    if (score >= 50) return { label: 'MEDIUM RISK',  color: '#f59e0b', cls: 'rl-medium' };
    if (score >= 25) return { label: 'LOW RISK',     color: '#3b82f6', cls: 'rl-low'    };
    return               { label: 'LIKELY SAFE',   color: '#22c55e', cls: 'rl-safe'   };
  }

  // ── Format helpers ───────────────────────────────────────────
  function fmtN(n) {
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${Number(n || 0).toFixed(0)}`;
  }

  // ── Open / close ─────────────────────────────────────────────
  function openPanel(tokenAddress, chain = null, tokenName = '') {
    const panel = document.getElementById('rug-panel');
    if (!panel) return;

    // Populate header
    const nameEl = panel.querySelector('.rp-token-name');
    const addrEl = panel.querySelector('.rp-token-addr');
    if (nameEl) nameEl.textContent = tokenName || 'Token Analysis';
    if (addrEl) {
      addrEl.textContent  = tokenAddress ? `${tokenAddress.slice(0, 8)}…${tokenAddress.slice(-6)}` : '';
      addrEl.dataset.full = tokenAddress || '';
    }

    // API key warning
    const { birdeye, helius } = ChainAPIs.getKeys();
    const kwarn = panel.querySelector('#rp-key-warn');
    if (kwarn) kwarn.style.display = (birdeye || helius) ? 'none' : 'flex';

    panel.classList.remove('rp-hidden');
    document.body.classList.add('rug-panel-open');

    // Run analysis
    runAnalysis(tokenAddress, chain, panel);
  }

  function closePanel() {
    document.getElementById('rug-panel')?.classList.add('rp-hidden');
    document.body.classList.remove('rug-panel-open');
    _last = null;
  }

  // ── Analysis runner ──────────────────────────────────────────
  async function runAnalysis(tokenAddress, chain, panel) {
    setLoading(panel, true);
    clearResults(panel);
    try {
      const [rugResult, clusterResult, bundleResult] = await Promise.all([
        RugChecker.analyzeToken(tokenAddress, chain),
        ClusterDetector.analyze(tokenAddress, chain || 'solana'),
        (typeof BundleDetector !== 'undefined')
          ? BundleDetector.analyze(tokenAddress, chain || 'solana')
          : Promise.resolve(null)
      ]);
      _last = { rugResult, clusterResult, bundleResult };
      // Store bundle result for compact card badges
      if (bundleResult?.success && typeof AppState !== 'undefined') {
        if (!AppState.bundleResults) AppState.bundleResults = {};
        AppState.bundleResults[tokenAddress] = bundleResult;
        // Trigger a lightweight card re-render for the bundle badge only
        const cardEl = document.querySelector(`.scanner-card[data-addr="${tokenAddress}"] .card-bundle-badge`);
        if (cardEl && bundleResult.bundle_risk_score >= 40) {
          const t = bundleResult.tier;
          cardEl.innerHTML = `🔗 ${t.label} ${bundleResult.bundle_risk_score}`;
          cardEl.className = `card-bundle-badge bundle-score-badge ${t.cls}`;
          cardEl.title = bundleResult.summary;
          cardEl.style.display = 'inline-flex';
        }
      }
      renderResults(panel, rugResult, clusterResult, bundleResult);
    } catch (err) {
      console.error('[RugUI]', err);
      showError(panel, err.message);
    } finally {
      setLoading(panel, false);
    }
  }

  function setLoading(panel, on) {
    panel.querySelector('#rp-loading')?.style && (panel.querySelector('#rp-loading').style.display = on ? 'flex' : 'none');
    panel.querySelector('#rp-results') && (panel.querySelector('#rp-results').style.display = on ? 'none' : 'block');
  }

  function clearResults(panel) {
    const r = panel.querySelector('#rp-results');
    if (r) r.innerHTML = '';
  }

  function showError(panel, msg) {
    const r = panel.querySelector('#rp-results');
    if (r) r.innerHTML = `<div class="rp-error">⚠️ Analysis failed: ${msg}<br><small>Check API keys in Admin panel.</small></div>`;
    setLoading(panel, false);
  }

  // ── Render full results ──────────────────────────────────────
  function renderResults(panel, rugResult, clusterResult, bundleResult) {
    const el = panel.querySelector('#rp-results');
    if (!el) return;

    const score   = rugResult.rugRiskScore;
    const lv      = level(score);
    const flagged = Object.values(rugResult.signals).filter(s => s?.flagged).length;
    const total   = SIGNALS.length;
    const circ    = 2 * Math.PI * 50; // r=50 → circumference ≈ 314
    const dash    = ((score / 100) * circ).toFixed(1);

    el.innerHTML = `
      <!-- ── Score hero ───────────────────────────────────────── -->
      <div class="rp-score-section">
        <div class="rp-score-ring">
          <svg viewBox="0 0 120 120" width="130" height="130">
            <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="11"/>
            <circle cx="60" cy="60" r="50" fill="none"
              stroke="${lv.color}" stroke-width="11"
              stroke-dasharray="${dash} ${circ}"
              stroke-linecap="round"
              transform="rotate(-90 60 60)"
              style="transition:stroke-dasharray 1.1s cubic-bezier(.4,0,.2,1)"/>
          </svg>
          <div class="rp-score-overlay">
            <div class="rp-score-num" style="color:${lv.color}">${score}</div>
            <div class="rp-score-sub">/ 100</div>
          </div>
        </div>
        <div class="rp-verdict-block">
          <div class="rp-verdict ${lv.cls}">${lv.label}</div>
          <div class="rp-verdict-meta">${flagged} of ${total} signals flagged</div>
          <div class="rp-chain-badge">${(rugResult.chain || 'SOL').toUpperCase()}</div>
          ${clusterResult?.clusters?.length
            ? `<div class="rp-cluster-warn">⚠️ ${clusterResult.clusters.length} cluster${clusterResult.clusters.length > 1 ? 's' : ''} detected — cluster risk ${clusterResult.clusterRiskScore}%</div>`
            : '<div class="rp-cluster-ok">✅ No wallet clusters detected</div>'}
          ${bundleResult?.bundle_risk_score >= 40
            ? `<div class="rp-bundle-verdict ${bundleResult.tier.cls}">${bundleResult.tier.emoji} Bundle: ${bundleResult.tier.label} (${bundleResult.bundle_risk_score}/100)</div>`
            : bundleResult?.success
              ? `<div class="rp-cluster-ok">✅ No bundle patterns detected</div>`
              : ''}
        </div>
      </div>

      <!-- ── 12-Signal grid ────────────────────────────────────── -->
      <div class="rp-section-title">🚨 12-Signal Analysis</div>
      <div class="rp-signals-grid">
        ${SIGNALS.map(m => signalCard(m, rugResult.signals[m.key])).join('')}
      </div>

      <!-- ── Bundle detection ──────────────────────────────────── -->
      ${bundleSection(bundleResult)}

      <!-- ── Cluster analysis ──────────────────────────────────── -->
      ${clusterSection(clusterResult)}

      <!-- ── Pair data ─────────────────────────────────────────── -->
      ${pairSection(rugResult.pair)}

      <!-- ── Action buttons ────────────────────────────────────── -->
      <div class="rp-actions">
        <button class="rp-btn" onclick="RugUI.rerun()">↺ Re-run</button>
        <button class="rp-btn rp-btn-copy" onclick="RugUI.copyReport()">📋 Copy Report</button>
      </div>
    `;
  }

  // ── Signal card ──────────────────────────────────────────────
  function signalCard(meta, result) {
    if (!result) result = { flagged: false, severity: 0, reason: 'Not checked', skipped: true };
    const { flagged, severity, reason, skipped } = result;

    const icon    = skipped ? '⬜' : flagged ? '🔴' : '✅';
    const sevCls  = severity >= 75 ? 'sev-crit' : severity >= 50 ? 'sev-high' : severity >= 25 ? 'sev-med' : 'sev-low';
    const cardCls = skipped ? 'sig-skip' : flagged ? 'sig-fail' : 'sig-pass';

    return `
      <div class="rp-sig-card ${cardCls}">
        <div class="rp-sig-head">
          <span class="rp-sig-icon">${icon}</span>
          <span class="rp-sig-name" title="${meta.label}">${meta.icon} ${meta.label}</span>
          ${skipped
            ? `<span class="rp-sig-score sev-low">—</span>`
            : `<span class="rp-sig-score ${sevCls}">${severity}</span>`}
        </div>
        <div class="rp-sig-reason">${reason || '—'}</div>
        ${!skipped && flagged && severity > 0
          ? `<div class="rp-sev-bar"><div class="rp-sev-fill ${sevCls}" style="width:${severity}%"></div></div>`
          : ''}
      </div>`;
  }

  // ── Bundle section ────────────────────────────────────────────
  function bundlePatternLabel(pattern) {
    const MAP = {
      fixedBuySize:     '💰 Fixed-Size Buys',
      sameBlock:        '🧱 Same-Block Bundle',
      burstTiming:      '⚡ Burst Timing',
      coordinatedSells: '📉 Coordinated Sells',
      regularTiming:    '⏱️ Regular Timing',
      sameFunder:       '🏦 Same Funder',
      relatedFunding:   '🔗 Related Funding'
    };
    return MAP[pattern] || pattern;
  }

  function bundleSection(br) {
    if (!br) return '';

    const score    = br.bundle_risk_score || 0;
    const t        = br.tier || (typeof BundleDetector !== 'undefined' ? BundleDetector.bundleTier(score) : { label: '—', cls: 'bd-low', color: '#22c55e', emoji: '✅' });
    const patterns = br.detected_patterns || [];
    const hasData  = br.success && patterns.length > 0;
    const stageStr = br.stage === 2
      ? `🔬 Deep analysis (Stage 2 · Helius) · ${br.early_buyers_analyzed || 0} early buyers`
      : br.stage === 1
        ? `⚡ Fast screen (Stage 1) · ${br.early_buyers_analyzed || 0} early buyers analyzed${!ChainAPIs.getKeys().helius ? ' · <em>Add Helius key for deeper analysis</em>' : ''}`
        : '';

    return `
      <div class="rp-section-title">🔗 Bundle Detection
        <span class="rp-bundle-badge ${t.cls}" style="background:${t.color}1a;border-color:${t.color}44;color:${t.color}">
          ${t.emoji} ${t.label} — ${score}/100
        </span>
      </div>
      <div class="rp-bundle-block">
        ${stageStr ? `<div class="rp-bundle-meta">${stageStr}</div>` : ''}
        ${hasData
          ? `
          <div class="rp-bundle-patterns">
            ${patterns.map(p => `
              <div class="rp-bpat">
                <div class="rp-bpat-head">
                  <span class="rp-bpat-name">${bundlePatternLabel(p.pattern)}</span>
                  <span class="rp-bpat-conf ${p.confidence >= 75 ? 'conf-red' : p.confidence >= 40 ? 'conf-yellow' : 'conf-green'}">${p.confidence}% confidence</span>
                </div>
                <div class="rp-bpat-detail">${p.details}</div>
                <div class="rp-sev-bar"><div class="rp-sev-fill ${p.confidence >= 75 ? 'sev-crit' : p.confidence >= 40 ? 'sev-high' : 'sev-med'}" style="width:${p.confidence}%"></div></div>
              </div>`).join('')}
          </div>
          ${br.estimated_cluster_supply_pct > 0
            ? `<div class="rp-bundle-supply">📊 Estimated cluster supply: <strong style="color:#f59e0b">~${br.estimated_cluster_supply_pct}%</strong> held by ${br.clusters?.[0]?.wallets?.length || 0} flagged wallets</div>`
            : ''}
          ${(br.clusters?.[0]?.wallets?.length || 0) > 0
            ? `<details class="rp-wallet-detail">
                <summary>View ${br.clusters[0].wallets.length} flagged wallet${br.clusters[0].wallets.length !== 1 ? 's' : ''}</summary>
                <div class="rp-wallet-list">
                  ${br.clusters[0].wallets.map(w => `<code class="rp-wallet-addr">${w}</code>`).join('')}
                </div>
              </details>`
            : ''}`
          : `<div class="rp-no-clusters">${br.reason || br.summary || 'No bundle patterns detected in early trading window.'}</div>`}
      </div>
    `;
  }

  // ── Cluster section ──────────────────────────────────────────
  function clusterSection(cr) {
    const hasData = cr?.success && cr.clusters?.length;
    return `
      <div class="rp-section-title">🕵️ Wallet Cluster Analysis
        ${hasData
          ? `<span class="rp-cluster-risk-badge ${cr.clusterRiskScore >= 75 ? 'crb-red' : cr.clusterRiskScore >= 40 ? 'crb-yellow' : 'crb-green'}">Risk ${cr.clusterRiskScore}%</span>`
          : ''}
      </div>
      ${hasData
        ? `<div class="rp-clusters">${cr.clusters.map((c, i) => clusterCard(c, i)).join('')}</div>`
        : `<div class="rp-no-clusters">${cr?.reason || 'No coordinated clusters found in the early trading window.'}</div>`}
    `;
  }

  function clusterCard(c, i) {
    const conf    = c.confidence;
    const confCls = conf >= 75 ? 'conf-red' : conf >= 40 ? 'conf-yellow' : 'conf-green';
    const s       = c.stats || {};

    return `
      <div class="rp-cluster-card">
        <div class="rp-cluster-head">
          <span class="rp-cluster-num">Cluster ${i + 1}</span>
          <span class="rp-cluster-size">${c.wallets?.length || 0} wallets</span>
          <span class="rp-cluster-conf ${confCls}">Confidence ${conf}%</span>
        </div>
        <div class="rp-cluster-stats">
          <div class="rp-cstat"><span>Supply</span><strong>${s.pctSupplyHeld ?? '?'}%</strong></div>
          <div class="rp-cstat"><span>Early Vol</span><strong>${s.pctEarlyVolume ?? '?'}%</strong></div>
          <div class="rp-cstat"><span>Avg Buy</span><strong>${(s.avgBuyNative || 0).toFixed(3)} SOL</strong></div>
          <div class="rp-cstat"><span>Avg +Time</span><strong>${s.avgBuyTimeOffsetSecs ?? '?'}s</strong></div>
        </div>
        <div class="rp-cluster-reasons">
          ${(c.reasons || []).slice(0, 4).map(r => `<div class="rp-creason">⚡ ${r}</div>`).join('')}
        </div>
        ${s.sharedFunders?.length
          ? `<div class="rp-funders">🏦 Shared funder${s.sharedFunders.length > 1 ? 's' : ''}: ${s.sharedFunders.map(f => `<code>${f.slice(0,5)}…${f.slice(-4)}</code>`).join(', ')}</div>`
          : ''}
        <details class="rp-wallet-detail">
          <summary>View ${c.wallets?.length || 0} wallets</summary>
          <div class="rp-wallet-list">
            ${(c.wallets || []).map(w => `<code class="rp-wallet-addr">${w}</code>`).join('')}
          </div>
        </details>
      </div>`;
  }

  // ── Pair info section ────────────────────────────────────────
  function pairSection(pair) {
    if (!pair) return '';
    const ch = (pair.priceChange?.h1 || 0) >= 0;
    return `
      <div class="rp-section-title">📊 Market Snapshot</div>
      <div class="rp-pair-grid">
        <div class="rp-pi"><span>DEX</span><strong>${pair.dexId || '—'}</strong></div>
        <div class="rp-pi"><span>Liquidity</span><strong>${fmtN(pair.liquidity?.usd)}</strong></div>
        <div class="rp-pi"><span>Market Cap</span><strong>${fmtN(pair.fdv || pair.marketCap)}</strong></div>
        <div class="rp-pi"><span>Vol 24h</span><strong>${fmtN(pair.volume?.h24)}</strong></div>
        <div class="rp-pi"><span>Δ 1h</span><strong class="${ch ? 'rp-green' : 'rp-red'}">${(pair.priceChange?.h1 || 0).toFixed(2)}%</strong></div>
        <div class="rp-pi"><span>Δ 24h</span><strong class="${(pair.priceChange?.h24||0)>=0?'rp-green':'rp-red'}">${(pair.priceChange?.h24||0).toFixed(2)}%</strong></div>
      </div>`;
  }

  // ── Quick-check input bar ────────────────────────────────────
  function initQuickCheck() {
    const input = document.getElementById('rug-quick-input');
    const btn   = document.getElementById('rug-quick-btn');
    if (!input || !btn) return;

    const go = () => {
      const addr = input.value.trim();
      if (addr.length < 10) { input.style.borderColor = '#ef4444'; return; }
      input.style.borderColor = '';
      openPanel(addr, null, addr.slice(0, 8) + '…');
    };

    btn.addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }

  // ── Copy report ──────────────────────────────────────────────
  function copyReport() {
    if (!_last) return;
    const { rugResult, clusterResult, bundleResult } = _last;
    const lv = level(rugResult.rugRiskScore);

    let txt = `🔍 T-CMD Rug Risk Report\n`;
    txt += `Token : ${rugResult.tokenAddress}\n`;
    txt += `Chain : ${(rugResult.chain || '?').toUpperCase()}\n`;
    txt += `Score : ${rugResult.rugRiskScore}/100 — ${lv.label}\n\n`;
    txt += `── 12 Signals ──────────────────────\n`;
    SIGNALS.forEach(m => {
      const s  = rugResult.signals[m.key];
      if (!s) return;
      const st = s.skipped ? '⬜ SKIP' : s.flagged ? '🔴 FAIL' : '✅ PASS';
      txt += `${st} [${s.severity || 0}/100] ${m.label}\n   ${s.reason}\n`;
    });

    if (bundleResult?.success) {
      txt += `\n── Bundle Detection ────────────────\n`;
      txt += `Bundle Risk Score: ${bundleResult.bundle_risk_score}/100 — ${bundleResult.tier?.label}\n`;
      txt += `Stage: ${bundleResult.stage === 2 ? 'Deep (Helius)' : 'Fast screen'} · ${bundleResult.early_buyers_analyzed || 0} early buyers\n`;
      if (bundleResult.detected_patterns?.length) {
        bundleResult.detected_patterns.forEach(p => {
          txt += `⚡ [${p.confidence}%] ${p.details}\n`;
        });
        if (bundleResult.estimated_cluster_supply_pct > 0) {
          txt += `Cluster supply: ~${bundleResult.estimated_cluster_supply_pct}%\n`;
        }
      } else {
        txt += `No bundle patterns detected\n`;
      }
    }

    if (clusterResult?.clusters?.length) {
      txt += `\n── Cluster Analysis ────────────────\n`;
      txt += `Overall cluster risk: ${clusterResult.clusterRiskScore}%\n`;
      clusterResult.clusters.forEach((c, i) => {
        txt += `\nCluster ${i + 1}: ${c.wallets?.length} wallets | Confidence ${c.confidence}%\n`;
        txt += `Supply held: ${c.stats?.pctSupplyHeld}% | Early vol: ${c.stats?.pctEarlyVolume}%\n`;
        txt += `Reasons: ${c.reasons?.join(' | ')}\n`;
      });
    }

    txt += `\nAnalyzed: ${new Date(rugResult.analyzedAt).toUTCString()}\n`;
    txt += `Powered by T-CMD | DexScreener · Birdeye · Helius`;

    navigator.clipboard.writeText(txt).then(() => {
      const btn = document.querySelector('.rp-btn-copy');
      if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '📋 Copy Report', 2500); }
    }).catch(() => {});
  }

  // ── Re-run ───────────────────────────────────────────────────
  function rerun() {
    const panel = document.getElementById('rug-panel');
    if (!panel) return;
    const addrEl = panel.querySelector('.rp-token-addr');
    const nameEl = panel.querySelector('.rp-token-name');
    const addr   = addrEl?.dataset?.full;
    if (addr) openPanel(addr, null, nameEl?.textContent || '');
  }

  // ── Init ─────────────────────────────────────────────────────
  function init() {
    initQuickCheck();

    // Close button
    document.getElementById('rp-close-btn')?.addEventListener('click', closePanel);

    // Backdrop click
    const panel = document.getElementById('rug-panel');
    if (panel) {
      panel.addEventListener('click', e => {
        if (e.target === panel) closePanel();
      });
    }

    // ESC key
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closePanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 150);
  }

  return { openPanel, closePanel, copyReport, rerun, level, SIGNALS };
})();

// Window alias
window.RugUI = RugUI;

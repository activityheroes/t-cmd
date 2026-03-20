'use strict';
/**
 * asset-identity.js — Canonical asset identity and provenance-matching utilities.
 *
 * Provides two layers:
 *  1. Canonical Asset Identity — maps raw asset symbols to a (strictId, economicId) pair.
 *     strictId = exact on-chain identity; economicId = economic family used for lot matching.
 *  2. Amount-matching utilities — fee-aware tolerances for linking movements across sources.
 *
 * Must be loaded BEFORE tax-engine.js.
 */
const AssetIdentity = (() => {

  // ── Economic family map ──────────────────────────────────────────────────────
  // Maps known asset symbol variants → their canonical economic family symbol.
  // Extends the engine's ASSET_CANONICAL with additional families and newer tokens.
  //
  // Key rule: two symbols share an economicId when they represent the same
  // underlying economic exposure (e.g. WSOL and SOL; STETH and ETH).
  // This does NOT mean they are fungible on-chain — strictId preserves that.
  const ECONOMIC_FAMILIES = {
    // ── SOL family ──────────────────────────────────────────────────────────
    WSOL:      'SOL',   // Wrapped SOL (Solana program)
    MSOL:      'SOL',   // Marinade staked SOL
    JITOSOL:   'SOL',   // Jito staked SOL
    JSOL:      'SOL',   // Jpool staked SOL
    BSOL:      'SOL',   // Blaze staked SOL
    STSOL:     'SOL',   // Lido staked SOL (Solana)
    SCNSOL:    'SOL',   // Sanctum staked SOL
    ESOL:      'SOL',   // Eversol staked SOL
    LAINESOL:  'SOL',   // Laine staked SOL
    HSOL:      'SOL',   // Helius staked SOL
    CGNTOSOL:  'SOL',   // Cogent staked SOL

    // ── ETH family ──────────────────────────────────────────────────────────
    WETH:      'ETH',   // Wrapped ETH (ERC-20)
    STETH:     'ETH',   // Lido staked ETH
    WSTETH:    'ETH',   // Wrapped stETH
    CBETH:     'ETH',   // Coinbase staked ETH
    RETH:      'ETH',   // Rocket Pool staked ETH
    ANKRETH:   'ETH',   // Ankr staked ETH
    SWETH:     'ETH',   // Swell staked ETH
    FRXETH:    'ETH',   // Frax staked ETH
    SFRXETH:   'ETH',   // Staked Frax ETH
    BETH:      'ETH',   // Binance staked ETH
    XETH:      'ETH',   // Alternate ETH name

    // ── BTC family ──────────────────────────────────────────────────────────
    WBTC:      'BTC',   // Wrapped BTC (ERC-20 standard)
    CBBTC:     'BTC',   // Coinbase Wrapped BTC
    TBTC:      'BTC',   // tBTC (threshold)
    RENBTC:    'BTC',   // RenBTC
    HBTC:      'BTC',   // Huobi BTC
    XBT:       'BTC',   // Kraken's name for BTC

    // ── BNB family ──────────────────────────────────────────────────────────
    WBNB:      'BNB',   // Wrapped BNB

    // ── POL / MATIC family ──────────────────────────────────────────────────
    WMATIC:    'POL',   // Wrapped MATIC
    MATIC:     'POL',   // Polygon (renamed to POL)

    // ── AVAX family ─────────────────────────────────────────────────────────
    WAVAX:     'AVAX',  // Wrapped AVAX

    // ── USDC multi-chain variants ────────────────────────────────────────────
    'USDC.E':       'USDC',
    USDCE:          'USDC',
    'USDC.B':       'USDC',
    USDBC:          'USDC',
    USDC_E:         'USDC',
    USDCAV2:        'USDC',
    USDC2:          'USDC',
    USD_COIN:       'USDC',
    BRIDGED_USDC:   'USDC',
    AUSDC:          'USDC',   // Aave USDC

    // ── USDT multi-chain variants ────────────────────────────────────────────
    'USDT.E':       'USDT',
    'USDT.B':       'USDT',
    USDTAV2:        'USDT',
    AUSDT:          'USDT',   // Aave USDT

    // ── DAI multi-chain variants ─────────────────────────────────────────────
    'DAI.E':        'DAI',
    BDAI:           'DAI',
    XDAI:           'DAI',
    WXDAI:          'DAI',
  };

  // ── Stablecoin fiat anchor ───────────────────────────────────────────────────
  // The fiat currency a stablecoin is pegged to (used by Swedish FX pricing).
  const STABLECOIN_ANCHORS = {
    USDC: 'USD', USDT: 'USD', DAI:   'USD', TUSD:  'USD',
    BUSD: 'USD', FRAX: 'USD', LUSD:  'USD', USDD:  'USD',
    USDS: 'USD', PYUSD:'USD', GUSD:  'USD', FDUSD: 'USD',
    EURC: 'EUR', EURS: 'EUR', AGEUR: 'EUR', EURT:  'EUR',
  };

  // ── Wrapper classification ───────────────────────────────────────────────────
  const WRAPPER_TYPES = {
    // native
    SOL:   'native', ETH:    'native', BTC:    'native',
    BNB:   'native', AVAX:   'native', POL:    'native', MATIC: 'native',
    // wrapped / staked
    WSOL:  'wrapped', MSOL:  'wrapped', JITOSOL:'wrapped', STSOL: 'wrapped',
    WETH:  'wrapped', STETH: 'wrapped', WSTETH: 'wrapped', CBETH: 'wrapped',
    RETH:  'wrapped', WBTC:  'wrapped', CBBTC:  'wrapped', TBTC:  'wrapped',
    WBNB:  'wrapped', WMATIC:'wrapped', WAVAX:  'wrapped',
  };

  // ── Amount-matching tolerances ───────────────────────────────────────────────
  // Relative (percentage) tolerance per transfer context.
  // "How much smaller can the received amount be vs. the sent amount?"
  const REL_TOL = {
    exchange_withdrawal: 0.03,  // up to 3% CEX withdrawal fee
    bridge:              0.04,  // up to 4% bridge fee + slippage
    provenance:          0.05,  // 5% for indirect BUY→RECEIVE ownership link
    internal:            0.005, // 0.5% wrap/unwrap within same wallet
    _default:            0.02,  // 2% generic
  };

  // Absolute (unit) dust threshold per asset — differences below this are always matched.
  const ABS_DUST = {
    BTC: 1e-6, ETH: 1e-5, SOL: 1e-4,
    USDC: 0.02, USDT: 0.02, DAI: 0.02,
    _default: 1e-4,
  };

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Map a raw asset symbol to its economic-family canonical id.
   * Returns the same symbol if no family mapping is known.
   * @param {string} sym – raw or already-normalized asset symbol
   * @returns {string}
   */
  function getEconomicId(sym) {
    if (!sym) return sym;
    const s = sym.trim().toUpperCase();
    return ECONOMIC_FAMILIES[s] || s;
  }

  /**
   * Full canonical identity object for a raw asset symbol.
   * @param {string}      sym            – raw asset symbol
   * @param {string|null} chain          – chain name if known (e.g. 'ethereum', 'solana')
   * @param {string|null} mintOrContract – on-chain address if known (makes identity 'high' confidence)
   * @returns {{ strictId, economicId, displaySymbol, chain, mintOrContract,
   *             nativeOrWrapped, stablecoinAnchor, aliases, confidence }}
   */
  function resolveCanonicalIdentity(sym, chain, mintOrContract) {
    if (!sym) return null;
    const s          = sym.trim().toUpperCase();
    const economicId = ECONOMIC_FAMILIES[s] || s;
    return {
      strictId:        s,
      economicId,
      displaySymbol:   s,
      chain:           chain          || null,
      mintOrContract:  mintOrContract || null,
      nativeOrWrapped: WRAPPER_TYPES[s] || 'token',
      stablecoinAnchor: STABLECOIN_ANCHORS[economicId] || null,
      aliases:         s !== economicId ? [economicId] : [],
      confidence:      mintOrContract ? 'high'
                     : (s in ECONOMIC_FAMILIES ? 'high' : 'medium'),
    };
  }

  /**
   * Decide whether two amounts plausibly represent the same economic movement
   * after fee deductions typical of the given transfer context.
   *
   * Rules:
   *  • recv must not exceed sent by more than dust (can't receive more than sent)
   *  • absolute dust: if |sent − recv| ≤ dust threshold → match
   *  • relative: (sent − recv) / sent must be ≤ tolerance for the given context
   *
   * @param {number} sent – outbound amount (source side; the larger one)
   * @param {number} recv – received amount (destination side; may be slightly smaller)
   * @param {string} sym  – canonical asset symbol (for dust threshold)
   * @param {string} ctx  – tolerance context: one of REL_TOL keys
   * @returns {boolean}
   */
  function amountsLikelyMatch(sent, recv, sym, ctx) {
    if (!sent || !recv || sent <= 0 || recv <= 0) return false;
    const dust = ABS_DUST[sym] || ABS_DUST._default;
    if (recv > sent + dust) return false;          // received MORE than sent → not a match
    if (Math.abs(sent - recv) <= dust) return true; // near-exact match
    const lost = (sent - recv) / sent;
    const tol  = REL_TOL[ctx] || REL_TOL._default;
    return lost >= 0 && lost <= tol;
  }

  /**
   * Build a human-readable ownership path description for review UI.
   * @param {string[]} steps – ordered list of step labels
   * @returns {string}
   */
  function describeOwnershipPath(steps) {
    return (steps && steps.length) ? steps.join(' → ') : 'Okänd källa';
  }

  return {
    ECONOMIC_FAMILIES,
    STABLECOIN_ANCHORS,
    WRAPPER_TYPES,
    getEconomicId,
    resolveCanonicalIdentity,
    amountsLikelyMatch,
    describeOwnershipPath,
  };
})();

/* ============================================================
   T-CMD — Memecoin Scanner
   DexScreener API + Pump Probability Scoring Engine
   ============================================================ */

const Scanner = (() => {

    // ── Native / infra token blocklist ────────────────────────
    // Filters out chain-native tokens, wrapped versions, stablecoins, and
    // major infrastructure tokens that are NOT meme coins.
    const BLOCKED_SYMBOLS = new Set([
        // Solana native & liquid staking
        'SOL','WSOL','MSOL','JSOL','BSOL','HSOL','STSOL','JITOSOL',
        // Ethereum / EVM natives
        'ETH','WETH',
        // BNB / BSC
        'BNB','WBNB',
        // Polygon
        'MATIC','WMATIC','POL',
        // Arbitrum
        'ARB',
        // Optimism
        'OP',
        // Avalanche
        'AVAX','WAVAX',
        // Cronos
        'CRO','WCRO',
        // Fantom
        'FTM','WFTM',
        // Base (Coinbase)
        'CBETH',
        // Other EVM chains
        'CELO','GLMR','MOVR','ONE','KLAY','METIS','ROSE',
        // Stablecoins
        'USDC','USDT','DAI','BUSD','TUSD','USDD','FRAX','LUSD','GUSD','USDP','USDH','USDE','PYUSD','FDUSD',
        // Wrapped Bitcoin
        'WBTC','BTCB',
        // Major blue-chips (appear in pairs but are not memes)
        'LINK','UNI','AAVE',
    ]);

    // Known contract addresses of wrapped/native tokens (lowercase)
    const BLOCKED_ADDRESSES = new Set([
        'so11111111111111111111111111111111111111112',           // WSOL (Solana)
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',           // WETH (Ethereum)
        '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',           // WBNB (BSC)
        '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',           // WMATIC (Polygon)
        '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',           // WETH (Arbitrum)
        '0x4200000000000000000000000000000000000006',           // WETH (Optimism & Base)
        '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',           // WAVAX (Avalanche)
        '0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23',           // WCRO (Cronos)
        '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83',           // WFTM (Fantom)
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',           // USDC (Ethereum)
        '0xdac17f958d2ee523a2206206994597c13d831ec7',           // USDT (Ethereum)
        '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',           // WBTC (Ethereum)
    ]);

    /**
     * Returns true if the token is a chain-native, wrapped, or stablecoin —
     * i.e. NOT a meme coin and should be excluded from scanner results.
     */
    function isBlockedToken(pair) {
        const sym  = (pair.baseToken?.symbol || '').trim().toUpperCase();
        const addr = (pair.baseToken?.address || '').toLowerCase();
        return BLOCKED_SYMBOLS.has(sym) || BLOCKED_ADDRESSES.has(addr);
    }

    // ── Manipulation risk helper (DexScreener-only signals) ────
    function calcManipulationRisk(pair) {
        const vol24h   = parseFloat(pair.volume?.h24 || 0);
        const vol1h    = parseFloat(pair.volume?.h1  || 0);
        const liq      = parseFloat(pair.liquidity?.usd || 0);
        const ch24h    = parseFloat(pair.priceChange?.h24 || 0);
        const ch1h     = parseFloat(pair.priceChange?.h1  || 0);
        const buys24h  = pair.txns?.h24?.buys  || 0;
        const sells24h = pair.txns?.h24?.sells || 0;
        const buys1h   = pair.txns?.h1?.buys   || 0;
        const sells1h  = pair.txns?.h1?.sells  || 0;
        const created  = pair.pairCreatedAt || 0;
        const ageMin   = (Date.now() - created) / 60000;
        const isPump   = (pair.pairAddress || '').toLowerCase().includes('pump') ||
                         (pair.baseToken?.address || '').toLowerCase().endsWith('pump');

        let penalty = 0;
        const flags = [];

        // ① Volume/Liquidity ratio — king manipulation signal
        const vlRatio = liq > 0 ? vol24h / liq : 0;
        if (vlRatio > 20) {
            penalty += 30;
            flags.push({ label: `Wash Trading — Vol/Liq ${vlRatio.toFixed(0)}×`, icon: '🚨', severity: 'critical' });
        } else if (vlRatio > 10) {
            penalty += 18;
            flags.push({ label: `High Vol/Liq ${vlRatio.toFixed(0)}× — likely wash`, icon: '⚠️', severity: 'high' });
        } else if (vlRatio > 5) {
            penalty += 6;
            flags.push({ label: `Elevated Vol/Liq ${vlRatio.toFixed(1)}×`, icon: '⚡', severity: 'medium' });
        }

        // ② Extreme spike on a very new token (< 3h) — classic pump & dump setup
        const isVeryNew = ageMin < 180;
        if (isVeryNew && (ch24h > 200 || ch1h > 100)) {
            penalty += 20;
            flags.push({ label: `New token extreme spike +${Math.round(Math.max(ch24h, ch1h))}%`, icon: '🎭', severity: 'high' });
        } else if (isVeryNew && (ch24h > 100 || ch1h > 50)) {
            penalty += 10;
            flags.push({ label: `Early pump signal +${Math.round(Math.max(ch24h, ch1h))}%`, icon: '🎭', severity: 'medium' });
        }

        // ③ PumpFun token with extreme buy ratio (bot-inflated) — real buys look like 60-70%, not 80%+
        const totalH1 = buys1h + sells1h;
        const buyRatioH1 = totalH1 > 20 ? buys1h / totalH1 : 0;
        if (isPump && buyRatioH1 > 0.82) {
            penalty += 12;
            flags.push({ label: `Bot buy ratio ${(buyRatioH1 * 100).toFixed(0)}% on PumpFun`, icon: '🤖', severity: 'high' });
        } else if (isPump && buyRatioH1 > 0.75 && isVeryNew) {
            penalty += 6;
            flags.push({ label: `Suspicious buy pressure ${(buyRatioH1 * 100).toFixed(0)}%`, icon: '🤖', severity: 'medium' });
        }

        // ④ Extremely low liquidity + high volume = guaranteed dump vector
        if (liq < 8_000 && vol24h > 50_000) {
            penalty += 15;
            flags.push({ label: `Thin pool — ${(vol24h / Math.max(liq, 1)).toFixed(0)}× vol vs liq`, icon: '🕳️', severity: 'critical' });
        }

        return { penalty: Math.min(penalty, 50), flags }; // cap penalty at 50pts
    }

    // ── Pump Scorer ────────────────────────────────────────
    function calcPumpScore(pair) {
        let score = 0;
        const volume24h = parseFloat(pair.volume?.h24 || 0);
        const volume1h = parseFloat(pair.volume?.h1 || 0);
        const volume5m = parseFloat(pair.volume?.m5 || 0);
        const priceChange24h = parseFloat(pair.priceChange?.h24 || 0);
        const priceChange1h = parseFloat(pair.priceChange?.h1 || 0);
        const priceChange5m = parseFloat(pair.priceChange?.m5 || 0);
        const liquidity = parseFloat(pair.liquidity?.usd || 0);
        const fdv = parseFloat(pair.fdv || 0);
        const mktCap = parseFloat(pair.marketCap || 0);
        const buys24h = pair.txns?.h24?.buys || 0;
        const sells24h = pair.txns?.h24?.sells || 0;
        const boostAmt = pair.boostAmount || 0;

        // Volume spike (5m vs 1h per minute average) — max 20pts
        // GUARD: if V/L ratio is suspicious, don't reward fake volume
        const liq = liquidity;
        const vlRatio = liq > 0 ? volume24h / liq : 0;
        const fakeVolSuspected = vlRatio > 10;
        const h1PerMin = volume1h / 60;
        if (!fakeVolSuspected) {
            if (h1PerMin > 0 && volume5m / 5 > h1PerMin * 3) score += 20;
            else if (h1PerMin > 0 && volume5m / 5 > h1PerMin * 1.5) score += 10;
        } else {
            // Reduced reward for suspected wash volume
            if (h1PerMin > 0 && volume5m / 5 > h1PerMin * 3) score += 8;
        }

        // Buy pressure — max 20pts (halved when bot buy ratio suspected)
        const totalTxns = buys24h + sells24h;
        if (totalTxns > 0) {
            const buyRatio = buys24h / totalTxns;
            const isPump = (pair.pairAddress || '').toLowerCase().includes('pump') ||
                           (pair.baseToken?.address || '').toLowerCase().endsWith('pump');
            const botSuspected = isPump && buyRatio > 0.82;
            score += Math.round(buyRatio * (botSuspected ? 8 : 20));
        }

        // Market cap sweet spot ($500K–$50M) — max 15pts
        if (mktCap >= 500_000 && mktCap <= 50_000_000) score += 15;
        else if (mktCap >= 50_000 && mktCap < 500_000) score += 7;
        else if (mktCap > 50_000_000 && mktCap < 200_000_000) score += 5;

        // Price momentum — max 15pts (capped for new-token extreme spikes)
        const ageMin = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 9999;
        const extremeSpike = ageMin < 180 && (priceChange24h > 150 || priceChange1h > 80);
        if (!extremeSpike) {
            if (priceChange5m > 5) score += 15;
            else if (priceChange5m > 2) score += 10;
            else if (priceChange1h > 10) score += 8;
            else if (priceChange24h > 20) score += 5;
        } else {
            // Suspicious pump — only partial credit
            score += 3;
        }

        // Liquidity health — max 15pts
        if (liquidity >= 50_000 && liquidity < 500_000) score += 15;
        else if (liquidity >= 10_000 && liquidity < 50_000) score += 8;
        else if (liquidity >= 500_000) score += 10;
        else score -= 10;  // tiny liquidity is BAD

        // Social / boost activity — max 15pts
        if (boostAmt > 1000) score += 15;
        else if (boostAmt > 500) score += 10;
        else if (boostAmt > 100) score += 6;
        const socials = pair.info?.socials || [];
        score += Math.min(10, socials.length * 3);

        // ── Deduct manipulation penalty ──────────────────────
        const { penalty } = calcManipulationRisk(pair);
        score -= penalty;

        return Math.min(100, Math.max(0, Math.round(score)));
    }

    // ── Rug / Honeypot Detection ───────────────────────────
    function detectRugFlags(pair) {
        const flags = [];
        const socials  = pair.info?.socials || [];
        const liquidity = parseFloat(pair.liquidity?.usd || 0);
        const fdv       = parseFloat(pair.fdv || 0);
        const mktCap    = parseFloat(pair.marketCap || 0);
        const buys24h   = pair.txns?.h24?.buys  || 0;
        const sells24h  = pair.txns?.h24?.sells || 0;
        const created   = pair.pairCreatedAt || 0;
        const ageHours  = (Date.now() - created) / 3600000;

        if (socials.length === 0) flags.push({ label: 'No Socials', icon: '🔕' });
        if (liquidity < 5_000) flags.push({ label: 'Tiny Liquidity', icon: '💧' });
        if (fdv > 0 && mktCap > 0 && fdv / mktCap > 20) flags.push({ label: 'FDV/MC Mismatch', icon: '⚠️' });
        if (buys24h + sells24h > 10 && sells24h / (buys24h + 1) > 2) flags.push({ label: 'Sell Heavy', icon: '🔻' });
        if (ageHours < 1) flags.push({ label: 'Very New (<1h)', icon: '🆕' });
        if ((pair.pairAddress || '').toLowerCase().includes('pump') ||
            (pair.baseToken?.address || '').toLowerCase().endsWith('pump')) {
            flags.push({ label: 'PumpFun Token', icon: '⚡' });
        }

        // Merge DexScreener-only manipulation flags
        const { flags: manipFlags } = calcManipulationRisk(pair);
        manipFlags.forEach(f => flags.push(f));

        return flags;
    }

    // ── Breakout Detection ────────────────────────────────
    function detectBreakout(pair) {
        const ch5m = parseFloat(pair.priceChange?.m5 || 0);
        const ch1h = parseFloat(pair.priceChange?.h1 || 0);
        const ch24h = parseFloat(pair.priceChange?.h24 || 0);
        const vol5m = parseFloat(pair.volume?.m5 || 0);
        const vol1h = parseFloat(pair.volume?.h1 || 0);
        const volAcceleration = vol1h > 0 ? (vol5m / 5) / (vol1h / 60) : 1;
        return (ch5m > 5 || ch1h > 15) && volAcceleration > 2;
    }

    // ── Signal type (Fresh vs Revived) ────────────────────
    function detectSignalType(pair) {
        const created = pair.pairCreatedAt || 0;
        const ageHours = (Date.now() - created) / 3600000;
        const ch24h = parseFloat(pair.priceChange?.h24 || 0);
        if (ageHours < 6 && ch24h > 0) return 'fresh';
        return 'revived';
    }

    // ── Multiplier tier ───────────────────────────────────
    function calcMultiplierTier(pair) {
        const mktCap = parseFloat(pair.marketCap || pair.fdv || 0);
        if (!mktCap || mktCap < 10_000) return { label: '—', tier: 'gray' };
        // Estimate potential based on sector similar coins
        const cap = mktCap;
        if (cap < 100_000) return { label: '10x+', tier: 'diamond' };
        if (cap < 1_000_000) return { label: '5x+', tier: 'gold' };
        if (cap < 10_000_000) return { label: '3x+', tier: 'silver' };
        if (cap < 50_000_000) return { label: '2x+', tier: 'bronze' };
        return { label: '1.5x+', tier: 'gray' };
    }

    // ── Memecoin Signal Generator ─────────────────────────
    // Signals only during accumulation phase, NOT at peak pump.
    // Strategy: enter quietly, TP at 2-3x, ride remainder risk-free.
    function generateMemeSignal(pair, score) {
        if (!pair || score < 60) return null;
        const price = parseFloat(pair.priceUSD || 0);
        if (!price || price <= 0) return null;

        // Suppress signals when manipulation penalty is high
        const { penalty } = calcManipulationRisk(pair);
        if (penalty >= 20) return null; // wash trading or extreme pump — no signal

        const ch5m = pair.priceChange?.m5 || 0;
        const ch1h = pair.priceChange?.h1 || 0;
        const isBreakout = pair.isBreakout;
        const liquidity = pair.liquidity || 0;

        // Don't signal at huge pumps — wait for pullback/accumulation
        if (ch5m > 20 || ch1h > 50) return null; // already pumped, high risk

        const volatility = Math.max(Math.abs(ch5m), Math.abs(ch1h)) / 100;
        const stopBuffer = Math.max(0.08, Math.min(0.25, volatility * 1.5)); // 8%-25% SL
        const tp1Mult = isBreakout ? 2.0 : 2.5; // TP at 2-2.5x
        const tp2Mult = isBreakout ? 3.0 : 4.0; // Extended TP at 3-4x

        const entry = price;
        const stopLoss = price * (1 - stopBuffer);
        const takeProfit = price * tp1Mult;
        const tp2 = price * tp2Mult;
        const rr = parseFloat((tp1Mult - 1) / stopBuffer).toFixed(1);

        const phase = isBreakout ? 'Breakout' : 'Accumulating';
        const note = isBreakout
            ? `Volume acceleration detected. Scale out 50% at 2x, ride rest. Exit if whales start selling.`
            : `Accumulation phase entry \u2014 low risk window. TP1 at 2.5x, TP2 at 4x. Watch big wallet exits.`;

        return { entry, stopLoss, takeProfit, tp2, rr, phase, note };
    }

    // ── Format pair data into a scanner token ─────────────
    function formatToken(pair, boostAmount = 0) {
        const base = pair.baseToken || {};
        const priceUSD = parseFloat(pair.priceUsd || 0);
        const score = calcPumpScore({ ...pair, boostAmount });
        const rugFlags = detectRugFlags(pair);
        const breakout = detectBreakout(pair);
        const sigType = detectSignalType(pair);
        const mult = calcMultiplierTier(pair);
        const socials = pair.info?.socials || [];
        const websites = pair.info?.websites || [];

        const tokenObj = {
            address: base.address || '',
            name: base.name || 'Unknown',
            symbol: base.symbol || '?',
            chainId: pair.chainId || 'solana',
            dexId: pair.dexId || 'raydium',
            pairAddress: pair.pairAddress || '',
            priceUSD,
            priceChange: {
                m5: parseFloat(pair.priceChange?.m5 || 0),
                h1: parseFloat(pair.priceChange?.h1 || 0),
                h6: parseFloat(pair.priceChange?.h6 || 0),
                h24: parseFloat(pair.priceChange?.h24 || 0)
            },
            volume: {
                m5: parseFloat(pair.volume?.m5 || 0),
                h1: parseFloat(pair.volume?.h1 || 0),
                h24: parseFloat(pair.volume?.h24 || 0)
            },
            liquidity: parseFloat(pair.liquidity?.usd || 0),
            fdv: parseFloat(pair.fdv || 0),
            mktCap: parseFloat(pair.marketCap || 0),
            txns: pair.txns || {},
            pumpScore: score,
            rugFlags,
            isBreakout: breakout,
            signalType: sigType,
            multiplier: mult,
            socials,
            websites,
            boostAmount,
            createdAt: pair.pairCreatedAt || Date.now(),
            dexUrl: pair.url || `https://dexscreener.com/${pair.chainId || 'solana'}/${pair.pairAddress || ''}`,
            imageUrl: pair.info?.imageUrl || null,
            scannedAt: Date.now()
        };
        // Attach memecoin signal if score >= 60
        tokenObj.memeSignal = generateMemeSignal(tokenObj, score);

        // Phase classification (synchronous, DexScreener data only)
        // Will be upgraded in autoAnalyzeOne() when MomentumDetector completes.
        if (typeof PhaseClassifier !== 'undefined') {
            const pc = PhaseClassifier.classify(tokenObj);
            tokenObj.phase         = pc.phase;
            tokenObj.phaseMeta     = pc.phaseMeta;
            tokenObj.accumScore    = pc.accumScore;
            tokenObj.trapScore     = pc.trapScore;
            tokenObj.breakoutScore = pc.breakoutScore;
            tokenObj.distScore     = pc.distScore;
            tokenObj.finalScore    = pc.finalScore;
            tokenObj.phaseReasons  = pc.reasons;
            tokenObj.phasePenalties = pc.penalties;
            tokenObj.phaseTier     = pc.tier;
            // Cache manipulation penalty for classifier re-use
            const { penalty } = calcManipulationRisk(pair);
            tokenObj._manipPenalty = penalty;
        } else {
            // Fallback: use pumpScore as finalScore
            tokenObj.phase      = tokenObj.isBreakout ? 'breakout' : 'accumulation';
            tokenObj.finalScore = tokenObj.pumpScore;
        }

        return tokenObj;
    }

    // ── Mock smart traders (simulated wallet data) ────────
    function generateSmartTraders(token) {
        const names = ['Sigma Wolf', 'Alpha Whale', 'Degen King', 'SOL Sniper', 'Trench Wizard', 'Moon Chaser', 'Gem Hunter'];
        const wallets = [
            'CXPLy5g2D6pqT6HMHwGvpxEY8VqaDuDXMW4X4yEq2DfK',
            'DkHPBkXxLQUqHPM8V6hB6JDJe6XbGqt7GadXV7PRqdSF',
            'AXfhKei96sh4MBEyKSBdHv8ZLXB3N9RFb5y6SrP7yyKc',
            'BmVh9rKjN4RQ9MKiJnxBxzBh5R3P7EJYxqtE3kZfB8e6',
            'E7HpK9QG4CenMa3NdyMxqJ6WbXMLEusmtAKJE4WGbGzp'
        ];
        const count = Math.floor(Math.random() * 5) + 2;
        return Array.from({ length: count }, (_, i) => {
            const bought = (Math.random() * 50000 + 1000).toFixed(0);
            const sold = Math.random() < 0.4 ? (parseFloat(bought) * (0.2 + Math.random() * 0.6)).toFixed(0) : '0';
            const roi = sold > 0 ? (((token.priceUSD * 1200 - bought) / bought) * 100).toFixed(1) : null;
            return {
                name: names[i % names.length],
                avatar: names[i % names.length][0],
                walletAddress: wallets[i % wallets.length],
                bought: parseFloat(bought),
                sold: parseFloat(sold),
                roi,
                ageHours: Math.floor(Math.random() * 72) + 1
            };
        });
    }

    // ── Technical Sentiment for memecoin ──────────────────
    function calcTechnicalSentiment(token) {
        const ch5m = token.priceChange.m5;
        const ch1h = token.priceChange.h1;
        const ch24h = token.priceChange.h24;
        const buys = token.txns?.h24?.buys || 0;
        const sells = token.txns?.h24?.sells || 0;
        const totalTxns = buys + sells || 1;
        const buyPressure = (buys / totalTxns) * 100;

        const momentumScore = Math.min(100, Math.max(0,
            50 + ch5m + ch1h * 0.5 + ch24h * 0.25
        ));

        return {
            momentum: Math.round(momentumScore),
            buyPressure: Math.round(buyPressure),
            volumeTrend: ch1h > 0 && token.volume.h1 > token.volume.h24 / 24 * 2 ? 'Rising' : 'Neutral',
            trend: ch24h > 10 ? 'Bullish' : ch24h < -10 ? 'Bearish' : 'Neutral',
            rsiEst: Math.min(90, Math.max(10, 50 + ch1h * 1.5 + ch5m * 2))
        };
    }

    // ── Fetch and process tokens ──────────────────────────
    async function fetchAndScore() {
        const results = [];
        try {
            // Fetch boosted tokens (most reliable signal for new memecoins)
            const [boosted, topBoosted] = await Promise.allSettled([
                API.DexScreener.getBoostedTokens(),
                API.DexScreener.getTopBoostedTokens()
            ]);

            const boostMap = {};
            const allBoosted = [
                ...(boosted.status === 'fulfilled' ? boosted.value : []),
                ...(topBoosted.status === 'fulfilled' ? topBoosted.value : [])
            ];
            allBoosted.forEach(b => { boostMap[b.tokenAddress] = (b.totalAmount || 0); });

            // Also fetch trending Solana pairs
            const trending = await API.DexScreener.getTrending().catch(() => []);
            const allPairs = trending.slice(0, 30);

            // Map boost info onto pairs (skip native/infra/stablecoin tokens)
            // Deduplicate by base token address — keep only the highest-liquidity pair per token
            const bestPairByAddr = new Map();
            for (const pair of allPairs) {
                if (isBlockedToken(pair)) continue;
                const addr = pair.baseToken?.address || '';
                if (!addr) continue;
                const liq = parseFloat(pair.liquidity?.usd || 0);
                const existing = bestPairByAddr.get(addr);
                if (!existing || liq > parseFloat(existing.liquidity?.usd || 0)) {
                    bestPairByAddr.set(addr, pair);
                }
            }
            for (const [addr, pair] of bestPairByAddr) {
                const token = formatToken(pair, boostMap[addr] || 0);
                if (token.priceUSD > 0) results.push(token);
            }

            // Try to also add boosted tokens we don't have pair data for
            for (const b of allBoosted.slice(0, 20)) {
                if (!results.find(r => r.address === b.tokenAddress)) {
                    try {
                        const pairs = await API.DexScreener.getTokenPairs(b.chainId || 'solana', b.tokenAddress);
                        const bestPair = pairs.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))[0];
                        if (bestPair && !isBlockedToken(bestPair) && parseFloat(bestPair.priceUsd || 0) > 0) {
                            results.push(formatToken(bestPair, b.totalAmount || 0));
                        }
                    } catch (_) { /* skip */ }
                }
            }
        } catch (err) {
            console.warn('Scanner fetch error:', err);
        }

        // Final dedup safety net — remove any remaining address duplicates (keep highest score)
        const seen = new Map();
        for (const t of results) {
            if (!t.address) continue;
            const existing = seen.get(t.address);
            const tScore = t.finalScore ?? t.pumpScore;
            if (!existing || tScore > (existing.finalScore ?? existing.pumpScore)) {
                seen.set(t.address, t);
            }
        }
        const deduped = [...seen.values()];

        // Sort by finalScore (phase-aware) falling back to pumpScore
        return deduped.sort((a, b) => (b.finalScore ?? b.pumpScore) - (a.finalScore ?? a.pumpScore));
    }

    // ══════════════════════════════════════════════════════════
    // HOLDER ANALYSIS — Markov Chain + Monte Carlo TP Prediction
    // ══════════════════════════════════════════════════════════
    const HolderAnalysis = {

        // Fetch top holders using Solana public RPC
        async fetchTopHolders(mint) {
            try {
                const rpc = 'https://api.mainnet-beta.solana.com';
                const res = await fetch(rpc, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0', id: 1,
                        method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }]
                    })
                });
                const data = await res.json();
                return (data.result?.value || []).map(h => ({
                    address: h.address, amount: parseFloat(h.uiAmountString || 0)
                }));
            } catch { return []; }
        },

        // Estimate average whale buy-in MC using historical price changes
        estimateWhaleBuyInMc(token, holderCount) {
            const currentMc = token.mktCap || 0;
            if (!currentMc) return { low: 0, high: 0, avg: 0 };

            // Use price change percentages to back-calculate when whales likely entered
            const ch5m = parseFloat(token.priceChange?.m5 || 0) / 100;
            const ch1h = parseFloat(token.priceChange?.h1 || 0) / 100;
            const ch6h = parseFloat(token.priceChange?.h6 || 0) / 100;
            const ch24h = parseFloat(token.priceChange?.h24 || 0) / 100;

            // Reconstruct historical MCs
            const mc5mAgo = currentMc / (1 + ch5m);
            const mc1hAgo = currentMc / (1 + ch1h);
            const mc6hAgo = currentMc / (1 + ch6h);
            const mc24hAgo = currentMc / (1 + ch24h);

            // Weight by holder concentration — big holders entered earlier
            const weights = [0.10, 0.25, 0.40, 0.25]; // 5m, 1h, 6h, 24h
            const mcs = [mc5mAgo, mc1hAgo, mc6hAgo, mc24hAgo];
            const avgBuyInMc = mcs.reduce((sum, mc, i) => sum + mc * weights[i], 0);

            return {
                low: Math.min(...mcs),
                high: Math.max(...mcs),
                avg: avgBuyInMc
            };
        },

        // Markov Chain state transition matrix for token price phases
        // States: ACCUMULATION(0), MARKUP(1), DISTRIBUTION(2), EXIT(3)
        _markovMatrix: [
            [0.55, 0.35, 0.05, 0.05], // From ACCUMULATING
            [0.10, 0.40, 0.40, 0.10], // From MARKUP
            [0.05, 0.20, 0.35, 0.40], // From DISTRIBUTION
            [0.20, 0.10, 0.10, 0.60]  // From EXIT/DUMP
        ],

        // Determine initial state from token metrics
        _getInitialState(token) {
            if (token.isBreakout) return 1;           // Markup
            const bp = token.txns?.h24?.buys / Math.max(1, token.txns?.h24?.buys + token.txns?.h24?.sells);
            if (bp > 0.65) return 0;                  // Accumulation
            if (bp < 0.40) return 3;                  // Exit
            return Math.round(token.pumpScore / 34);   // Score-based
        },

        // Monte Carlo simulation: predict where whales will take profits
        simulateTpZone(token, iterations = 1000) {
            const currentMc = token.mktCap || 0;
            if (!currentMc) return null;
            const supply = currentMc / (token.priceUSD || 1);
            const buyIn = this.estimateWhaleBuyInMc(token, 10);
            const initState = this._getInitialState(token);
            const matrix = this._markovMatrix;

            // Seed RNG deterministically from token address for consistent results
            let seed = (token.address || '').split('').reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0) >>> 0;
            const rand = () => {
                seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
                return (seed >>> 0) / 4294967296;
            };

            const exitMcs = [];
            for (let i = 0; i < iterations; i++) {
                let state = initState;
                let mc = currentMc;
                let steps = 0;

                while (state !== 3 && steps < 50) {
                    // State transition
                    const row = matrix[state];
                    const r = rand();
                    let cumPr = 0;
                    for (let s = 0; s < row.length; s++) {
                        cumPr += row[s];
                        if (r <= cumPr) { state = s; break; }
                    }
                    // Price change each step (roughly 5m intervals)
                    const drift = state === 1 ? 0.04  // Markup: +4%
                        : state === 2 ? 0.01  // Distribution: +1%
                            : state === 3 ? -0.08 // Exit: -8%
                                : 0.005;              // Accumulation: +0.5%
                    const noise = (rand() - 0.5) * 0.06;
                    mc = mc * (1 + drift + noise);
                    steps++;
                }
                // Record MC at exit
                if (mc > buyIn.avg * 1.1) exitMcs.push(mc); // Only profit-taking exits
            }

            if (!exitMcs.length) return null;
            exitMcs.sort((a, b) => a - b);
            const p25 = exitMcs[Math.floor(exitMcs.length * 0.25)];
            const p50 = exitMcs[Math.floor(exitMcs.length * 0.50)];
            const p75 = exitMcs[Math.floor(exitMcs.length * 0.75)];

            return {
                lowMc: p25,
                medMc: p50,
                highMc: p75,
                lowPrice: p25 / supply,
                medPrice: p50 / supply,
                highPrice: p75 / supply,
                confidence: Math.min(95, Math.round(50 + token.pumpScore * 0.4)),
                avgBuyInMc: buyIn.avg,
                currentMc
            };
        }
    };

    return { fetchAndScore, calcPumpScore, detectRugFlags, detectBreakout, formatToken, generateSmartTraders, calcTechnicalSentiment, HolderAnalysis };
})();

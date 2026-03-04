/* ============================================================
   T-CMD — Memecoin Scanner
   DexScreener API + Pump Probability Scoring Engine
   ============================================================ */

const Scanner = (() => {

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
        const h1PerMin = volume1h / 60;
        if (h1PerMin > 0 && volume5m / 5 > h1PerMin * 3) score += 20;
        else if (h1PerMin > 0 && volume5m / 5 > h1PerMin * 1.5) score += 10;

        // Buy pressure — max 20pts
        const totalTxns = buys24h + sells24h;
        if (totalTxns > 0) {
            const buyRatio = buys24h / totalTxns;
            score += Math.round(buyRatio * 20);
        }

        // Market cap sweet spot ($500K–$50M) — max 15pts
        if (mktCap >= 500_000 && mktCap <= 50_000_000) score += 15;
        else if (mktCap >= 50_000 && mktCap < 500_000) score += 7;
        else if (mktCap > 50_000_000 && mktCap < 200_000_000) score += 5;

        // Price momentum — max 15pts
        if (priceChange5m > 5) score += 15;
        else if (priceChange5m > 2) score += 10;
        else if (priceChange1h > 10) score += 8;
        else if (priceChange24h > 20) score += 5;

        // Liquidity health — max 15pts
        if (liquidity >= 50_000 && liquidity < 500_000) score += 15;
        else if (liquidity >= 10_000 && liquidity < 50_000) score += 8;
        else if (liquidity >= 500_000) score += 10;
        else score -= 10;  // tiny liquidity is BAD

        // Social / boost activity — max 15pts
        if (boostAmt > 1000) score += 15;
        else if (boostAmt > 500) score += 10;
        else if (boostAmt > 100) score += 6;
        // Check if token has socials
        const socials = pair.info?.socials || [];
        score += Math.min(10, socials.length * 3);

        return Math.min(100, Math.max(0, Math.round(score)));
    }

    // ── Rug / Honeypot Detection ───────────────────────────
    function detectRugFlags(pair) {
        const flags = [];
        const socials = pair.info?.socials || [];
        const liquidity = parseFloat(pair.liquidity?.usd || 0);
        const fdv = parseFloat(pair.fdv || 0);
        const mktCap = parseFloat(pair.marketCap || 0);
        const buys24h = pair.txns?.h24?.buys || 0;
        const sells24h = pair.txns?.h24?.sells || 0;
        const created = pair.pairCreatedAt || 0;
        const ageHours = (Date.now() - created) / 3600000;

        if (socials.length === 0) flags.push({ label: 'No Socials', icon: '🔕' });
        if (liquidity < 5_000) flags.push({ label: 'Tiny Liquidity', icon: '💧' });
        if (fdv > 0 && mktCap > 0 && fdv / mktCap > 20) flags.push({ label: 'FDV/MC Mismatch', icon: '⚠️' });
        if (buys24h + sells24h > 10 && sells24h / (buys24h + 1) > 2) flags.push({ label: 'Sell Heavy', icon: '🔻' });
        if (ageHours < 1) flags.push({ label: 'Very New (<1h)', icon: '🆕' });
        if (pair.pairAddress?.toLowerCase().includes('pump') || pair.baseToken?.address?.length < 40) {
            flags.push({ label: 'PumpFun Token', icon: '⚡' });
        }
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
            imageUrl: pair.info?.imageUrl || null
        };
        // Attach memecoin signal if score >= 60
        tokenObj.memeSignal = generateMemeSignal(tokenObj, score);
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

            // Map boost info onto pairs
            for (const pair of allPairs) {
                const addr = pair.baseToken?.address || '';
                const token = formatToken(pair, boostMap[addr] || 0);
                if (token.priceUSD > 0) results.push(token);
            }

            // Try to also add boosted tokens we don't have pair data for
            for (const b of allBoosted.slice(0, 20)) {
                if (!results.find(r => r.address === b.tokenAddress)) {
                    try {
                        const pairs = await API.DexScreener.getTokenPairs(b.chainId || 'solana', b.tokenAddress);
                        const bestPair = pairs.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))[0];
                        if (bestPair && parseFloat(bestPair.priceUsd || 0) > 0) {
                            results.push(formatToken(bestPair, b.totalAmount || 0));
                        }
                    } catch (_) { /* skip */ }
                }
            }
        } catch (err) {
            console.warn('Scanner fetch error:', err);
        }

        // Sort by pump score
        return results.sort((a, b) => b.pumpScore - a.pumpScore);
    }

    return { fetchAndScore, calcPumpScore, detectRugFlags, detectBreakout, formatToken, generateSmartTraders, calcTechnicalSentiment };
})();

/* ============================================================
   T-CMD — Signal Generation Engine
   RSI, MACD, EMA, Markov Chain, Monte Carlo
   ============================================================ */

const SignalEngine = (() => {

    // ── Technical Indicators ───────────────────────────────

    // Simple EMA
    function ema(values, period) {
        const k = 2 / (period + 1);
        let emaVal = values[0];
        const result = [emaVal];
        for (let i = 1; i < values.length; i++) {
            emaVal = values[i] * k + emaVal * (1 - k);
            result.push(emaVal);
        }
        return result;
    }

    // RSI (14-period default)
    function rsi(closes, period = 14) {
        if (closes.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff >= 0) gains += diff; else losses += Math.abs(diff);
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        const rsiValues = [];
        for (let i = period; i < closes.length; i++) {
            if (i > period) {
                const diff = closes[i] - closes[i - 1];
                const gain = diff > 0 ? diff : 0;
                const loss = diff < 0 ? Math.abs(diff) : 0;
                avgGain = (avgGain * (period - 1) + gain) / period;
                avgLoss = (avgLoss * (period - 1) + loss) / period;
            }
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsiValues.push(100 - 100 / (1 + rs));
        }
        return rsiValues;
    }

    // MACD (12, 26, 9)
    function macd(closes) {
        if (closes.length < 34) return null;
        const ema12 = ema(closes, 12);
        const ema26 = ema(closes, 26);
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const signalLine = ema(macdLine.slice(25), 9);
        const histogram = signalLine.map((s, i) => macdLine[i + 25] - s);
        return {
            macdLine: macdLine.slice(25),
            signalLine,
            histogram,
            last: { macd: macdLine[macdLine.length - 1], signal: signalLine[signalLine.length - 1], histogram: histogram[histogram.length - 1] }
        };
    }

    // Bollinger Bands
    function bollingerBands(closes, period = 20, stdDev = 2) {
        if (closes.length < period) return null;
        const middle = [];
        const upper = [];
        const lower = [];
        for (let i = period - 1; i < closes.length; i++) {
            const slice = closes.slice(i - period + 1, i + 1);
            const mean = slice.reduce((a, b) => a + b, 0) / period;
            const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
            const std = Math.sqrt(variance);
            middle.push(mean);
            upper.push(mean + stdDev * std);
            lower.push(mean - stdDev * std);
        }
        return { middle, upper, lower };
    }

    // ── Markov Chain ───────────────────────────────────────
    // States: 0=Distribution, 1=Accumulating, 2=Breakout
    function buildMarkovTransition(closes, rsiVals) {
        const states = classifyMarketStates(closes, rsiVals);
        const stateCount = 3;
        const counts = Array.from({ length: stateCount }, () => Array(stateCount).fill(0));
        for (let i = 0; i < states.length - 1; i++) {
            counts[states[i]][states[i + 1]]++;
        }
        return counts.map(row => {
            const total = row.reduce((a, b) => a + b, 0) || 1;
            return row.map(c => c / total);
        });
    }

    function classifyMarketStates(closes, rsiVals) {
        return closes.map((c, i) => {
            const rsiVal = rsiVals[i] || 50;
            const pctChange = i > 0 ? (c - closes[i - 1]) / closes[i - 1] * 100 : 0;
            if (rsiVal > 65 || pctChange > 3) return 2;  // Breakout
            if (rsiVal < 40 || pctChange < -2) return 0;  // Distribution
            return 1;  // Accumulating
        });
    }

    function currentState(closes, rsiVals) {
        if (!closes.length || !rsiVals.length) return 1;
        const states = classifyMarketStates(closes, rsiVals);
        return states[states.length - 1];
    }

    // ── Monte Carlo simulation ────────────────────────────
    function monteCarlo(transitionMatrix, currentStateIdx, simulations = 1000, steps = 5) {
        const stateNames = ['Distribution', 'Accumulating', 'Breakout'];
        const finalCounts = [0, 0, 0];
        for (let s = 0; s < simulations; s++) {
            let state = currentStateIdx;
            for (let t = 0; t < steps; t++) {
                const row = transitionMatrix[state];
                const r = Math.random();
                let cumProb = 0;
                for (let j = 0; j < row.length; j++) {
                    cumProb += row[j];
                    if (r < cumProb) { state = j; break; }
                }
            }
            finalCounts[state]++;
        }
        return {
            distribution: finalCounts[0] / simulations,
            accumulating: finalCounts[1] / simulations,
            breakout: finalCounts[2] / simulations,
            mostLikely: stateNames[finalCounts.indexOf(Math.max(...finalCounts))]
        };
    }

    // ── Support / Resistance estimation ───────────────────
    function findKeyLevels(closes, lookback = 30) {
        const recent = closes.slice(-lookback);
        const max = Math.max(...recent);
        const min = Math.min(...recent);
        const mid = (max + min) / 2;
        return { resistance: max, support: min, midpoint: mid };
    }

    // ── Liquidation range estimation ──────────────────────
    function estimateLiquidationRange(price, atr) {
        return {
            longLiqs: price - atr * 2.5,
            shortLiqs: price + atr * 2.5
        };
    }

    function atr(closes, period = 14) {
        if (closes.length < 2) return closes[0] * 0.02;
        const trValues = closes.slice(1).map((c, i) => Math.abs(c - closes[i]));
        const avgTR = trValues.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trValues.length);
        return avgTR;
    }

    // ── R:R calculation ────────────────────────────────────
    function calcRR(entry, stopLoss, takeProfit) {
        const risk = Math.abs(entry - stopLoss);
        const reward = Math.abs(takeProfit - entry);
        if (risk === 0) return 0;
        return (reward / risk).toFixed(2);
    }

    // ── Confidence score ───────────────────────────────────
    function calcConfidence(rsiVal, macdData, emaAlignment, breakoutProb, state) {
        let score = 45;  // base

        // RSI signal strength
        if (rsiVal < 30 || rsiVal > 70) score += 20;
        else if (rsiVal < 40 || rsiVal > 60) score += 10;

        // MACD confirmation
        if (macdData) {
            const { macd: m, signal: s, histogram: h } = macdData.last;
            if (Math.abs(h) > 0) score += 10;
            if ((m > s && h > 0) || (m < s && h < 0)) score += 5;
        }

        // EMA alignment
        if (emaAlignment) score += 10;

        // Monte Carlo breakout
        score += Math.round(breakoutProb * 15);

        return Math.min(95, Math.max(40, Math.round(score)));
    }

    // ── Main signal generator ──────────────────────────────
    function generateSignal(symbol, priceData, chartData) {
        try {
            const ohlcv = API.buildOHLCVFromChart(chartData);
            const closes = ohlcv.map(c => c.close).filter(Boolean);
            if (closes.length < 35) return null;

            const currentPrice = closes[closes.length - 1];
            const rsiVals = rsi(closes, 14);
            const macdData = macd(closes);
            const ema9 = ema(closes, 9);
            const ema21 = ema(closes, 21);
            const ema50 = ema(closes, 50);
            const bbands = bollingerBands(closes);
            const atrVal = atr(closes);
            const levels = findKeyLevels(closes, 30);

            const lastRsi = rsiVals ? rsiVals[rsiVals.length - 1] : 50;
            const lastEma9 = ema9[ema9.length - 1];
            const lastEma21 = ema21[ema21.length - 1];
            const lastEma50 = ema50.length > 0 ? ema50[ema50.length - 1] : currentPrice;

            // EMA alignment
            const bullishEMA = lastEma9 > lastEma21 && lastEma21 > lastEma50;
            const bearishEMA = lastEma9 < lastEma21 && lastEma21 < lastEma50;

            // Markov + Monte Carlo
            let markovProbs = { breakout: 0.33, accumulating: 0.34, distribution: 0.33, mostLikely: 'Accumulating' };
            try {
                const shortened = closes.slice(-60);
                const shortRsi = rsiVals ? rsiVals.slice(-60) : shortened.map(() => 50);
                const matrix = buildMarkovTransition(shortened, shortRsi);
                const curState = currentState(shortened, shortRsi);
                markovProbs = monteCarlo(matrix, curState, 800, 5);
            } catch (_) { /* fallback */ }

            // Direction logic
            let direction, entry, stopLoss, takeProfit, phase;

            const longConditions = (lastRsi < 40 && bullishEMA) || (lastRsi < 30) || markovProbs.breakout > 0.5;
            const shortConditions = (lastRsi > 65 && bearishEMA) || (lastRsi > 75) || markovProbs.distribution > 0.55;

            if (shortConditions && lastRsi > 60) {
                direction = 'SHORT';
                entry = currentPrice;
                stopLoss = currentPrice * 1.025;
                takeProfit = currentPrice * 0.935;
                phase = 'Distribution';
            } else {
                direction = 'LONG';
                entry = currentPrice;
                stopLoss = Math.max(levels.support, currentPrice * 0.96);
                takeProfit = Math.min(levels.resistance * 1.02, currentPrice * 1.08);
                phase = markovProbs.breakout > 0.4 ? 'Breakout' : 'Accumulating';
            }

            // Adjust TP/SL for minimum R:R of 1:2
            const risk = Math.abs(entry - stopLoss);
            if (direction === 'LONG' && takeProfit < entry + risk * 2) takeProfit = entry + risk * 2.5;
            if (direction === 'SHORT' && takeProfit > entry - risk * 2) takeProfit = entry - risk * 2.5;

            const rrRatio = calcRR(entry, stopLoss, takeProfit);
            const conf = calcConfidence(lastRsi, macdData, bullishEMA || bearishEMA, markovProbs.breakout, phase);
            const liqs = estimateLiquidationRange(currentPrice, atrVal);

            // Tags
            const tags = [];
            if (lastRsi < 35) tags.push({ label: 'RSI Oversold', color: 'green' });
            if (lastRsi > 65) tags.push({ label: 'RSI Overbought', color: 'red' });
            if (macdData && macdData.last.histogram > 0) tags.push({ label: 'MACD Bullish', color: 'cyan' });
            if (macdData && macdData.last.histogram < 0) tags.push({ label: 'MACD Bearish', color: 'red' });
            if (bullishEMA) tags.push({ label: 'Bull EMA Stack', color: 'green' });
            if (bearishEMA) tags.push({ label: 'Bear EMA Stack', color: 'red' });
            if (markovProbs.breakout > 0.45) tags.push({ label: 'Breakout Signal', color: 'amber' });
            if (markovProbs.accumulating > 0.5) tags.push({ label: 'Accumulating', color: 'cyan' });

            // Category tags
            if (symbol === 'BTC') tags.unshift({ label: 'Long-Term Uptrend', color: 'purple' });
            if (symbol === 'SOL') tags.unshift({ label: 'High Momentum', color: 'amber' });
            if (symbol === 'ETH') tags.unshift({ label: 'Layer 1', color: 'cyan' });

            return {
                id: `${symbol}-${Date.now()}`,
                symbol,
                direction,
                entry,
                stopLoss,
                takeProfit,
                phase,
                confidence: conf,
                rr: rrRatio,
                rsi: Math.round(lastRsi),
                macdBullish: macdData ? macdData.last.histogram > 0 : null,
                bullishEMA,
                bearishEMA,
                markov: markovProbs,
                liquidation: liqs,
                tags,
                priceData,
                currentPrice,
                timestamp: Date.now(),
                closes: closes.slice(-50)
            };
        } catch (err) {
            console.warn(`Signal generation failed for ${symbol}:`, err);
            return null;
        }
    }

    // ── Timeframe helpers ─────────────────────────────────
    function timeAgo(timestamp) {
        const diff = Date.now() - timestamp;
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return { value: mins || 1, unit: 'MIN' };
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return { value: hrs, unit: 'HRS' };
        return { value: Math.floor(hrs / 24), unit: 'DAYS' };
    }

    function formatPrice(p, sym) {
        if (!p) return '—';
        if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
        if (p >= 1) return '$' + p.toFixed(2);
        if (p >= 0.01) return '$' + p.toFixed(4);
        return '$' + p.toFixed(7);
    }

    function formatVol(v) {
        if (!v) return '—';
        if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
        return '$' + v.toFixed(0);
    }

    return { generateSignal, rsi, macd, ema, ema9: c => ema(c, 9), ema21: c => ema(c, 21), bollingerBands, atr, timeAgo, formatPrice, formatVol, calcRR };
})();

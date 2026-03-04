/* ============================================================
   T-CMD — Trading Log (Position Management)
   ============================================================ */

const TradeLog = (() => {
    const STORAGE_KEY = 'tcmd_positions';
    const CLOSED_KEY = 'tcmd_closed';

    function getPositions() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
    }

    function savePositions(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }

    function getClosedPositions() {
        try { return JSON.parse(localStorage.getItem(CLOSED_KEY)) || []; } catch { return []; }
    }

    function saveClosedPositions(p) { localStorage.setItem(CLOSED_KEY, JSON.stringify(p)); }

    return {
        getPositions,

        addPosition({ symbol, direction, entry, stopLoss, takeProfit, size, rr, fromSignalId }) {
            const positions = getPositions();
            const pos = {
                id: `pos-${Date.now()}`,
                symbol,
                direction: direction.toUpperCase(),
                entry: parseFloat(entry),
                stopLoss: parseFloat(stopLoss),
                takeProfit: parseFloat(takeProfit),
                size: parseFloat(size) || 1,
                rr: rr || '—',
                fromSignalId: fromSignalId || null,
                openedAt: Date.now(),
                currentPrice: parseFloat(entry)
            };
            positions.push(pos);
            savePositions(positions);
            return pos;
        },

        updatePrice(symbol, price) {
            const positions = getPositions();
            let changed = false;
            for (const p of positions) {
                if (p.symbol === symbol) { p.currentPrice = price; changed = true; }
            }
            if (changed) savePositions(positions);
        },

        closePosition(id, currentPrice) {
            const positions = getPositions();
            const idx = positions.findIndex(p => p.id === id);
            if (idx === -1) return null;
            const pos = positions[idx];
            const price = currentPrice || pos.currentPrice || pos.entry;
            const pnlPct = pos.direction === 'LONG'
                ? ((price - pos.entry) / pos.entry) * 100
                : ((pos.entry - price) / pos.entry) * 100;
            const closedPos = { ...pos, closePrice: price, pnlPct: parseFloat(pnlPct.toFixed(2)), closedAt: Date.now() };
            positions.splice(idx, 1);
            savePositions(positions);
            const closed = getClosedPositions();
            closed.unshift(closedPos);
            if (closed.length > 200) closed.splice(200);
            saveClosedPositions(closed);
            return closedPos;
        },

        calcPnL(pos) {
            const price = pos.currentPrice || pos.entry;
            if (pos.direction === 'LONG') {
                return ((price - pos.entry) / pos.entry) * 100;
            } else {
                return ((pos.entry - price) / pos.entry) * 100;
            }
        },

        getStats() {
            const closed = getClosedPositions();
            if (!closed.length) return { winRate: 0, totalPnl: 0, avgRR: 0, count: 0, wins: 0, losses: 0 };
            const wins = closed.filter(p => p.pnlPct > 0).length;
            const losses = closed.filter(p => p.pnlPct <= 0).length;
            const total = closed.reduce((sum, p) => sum + (p.pnlPct || 0), 0);
            return {
                winRate: Math.round((wins / closed.length) * 100),
                totalPnl: parseFloat(total.toFixed(2)),
                count: closed.length,
                wins, losses
            };
        },

        getClosedPositions
    };
})();

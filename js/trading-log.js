/* ============================================================
   T-CMD — Trading Log (Position Management)
   Per-user persistence via SupabaseDB
   ============================================================ */

const TradeLog = (() => {
    // In-memory cache (loaded from Supabase on init)
    let _positions = [];
    let _closed = [];
    let _loaded = false;

    function getPositions() { return _positions; }
    function getClosedPositions() { return _closed; }

    async function _persist() {
        try { await SupabaseDB.savePositions(_positions); } catch (e) {
            console.warn('[TradeLog] persist positions failed:', e.message);
        }
    }

    return {
        // Load from Supabase into memory (call once on app init)
        async init() {
            try {
                _positions = await SupabaseDB.getPositions();
                _closed = await SupabaseDB.getClosedPositions();
                _loaded = true;
            } catch (e) {
                console.warn('[TradeLog] init failed:', e.message);
                _positions = []; _closed = []; _loaded = true;
            }
        },

        getPositions,

        addPosition({ symbol, direction, entry, stopLoss, takeProfit, size, rr, fromSignalId }) {
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
            _positions.push(pos);
            _persist();
            return pos;
        },

        updatePrice(symbol, price) {
            let changed = false;
            for (const p of _positions) {
                if (p.symbol === symbol) { p.currentPrice = price; changed = true; }
            }
            if (changed) _persist();
        },

        closePosition(id, currentPrice) {
            const idx = _positions.findIndex(p => p.id === id);
            if (idx === -1) return null;
            const pos = _positions[idx];
            const price = currentPrice || pos.currentPrice || pos.entry;
            const pnlPct = pos.direction === 'LONG'
                ? ((price - pos.entry) / pos.entry) * 100
                : ((pos.entry - price) / pos.entry) * 100;
            const closedPos = { ...pos, closePrice: price, pnlPct: parseFloat(pnlPct.toFixed(2)), closedAt: Date.now() };
            _positions.splice(idx, 1);
            _persist();
            _closed.unshift(closedPos);
            if (_closed.length > 200) _closed.splice(200);
            SupabaseDB.saveClosedPosition(closedPos).catch(e =>
                console.warn('[TradeLog] saveClosedPosition failed:', e.message));
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
            if (!_closed.length) return { winRate: 0, totalPnl: 0, avgRR: 0, count: 0, wins: 0, losses: 0 };
            const wins = _closed.filter(p => p.pnlPct > 0).length;
            const losses = _closed.filter(p => p.pnlPct <= 0).length;
            const total = _closed.reduce((sum, p) => sum + (p.pnlPct || 0), 0);
            return {
                winRate: Math.round((wins / _closed.length) * 100),
                totalPnl: parseFloat(total.toFixed(2)),
                count: _closed.length,
                wins, losses
            };
        },

        getClosedPositions
    };
})();

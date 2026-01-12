import redis from '../config/redis';
import pool from '../config/database';

interface OrderData {
    orderId: string;
    userId: string;
    stockId: number;
    price: number;
    quantity: number;
    timestamp: number;
    remaining_quantity: number;
}

interface ParsedOrder {
    data: OrderData;
    price: number;
}

interface IEPResult {
    price: number;
    matchedVolume: number;
    surplus: number; // Demand - Supply
}

export class IEPEngine {

    /**
     * Calculate Indicative Equilibrium Price (IEP) for a symbol
     */
    static async calculateIEP(symbol: string): Promise<IEPResult | null> {
        // 1. Fetch Orderbook from Redis
        const [buyQueueRaw, sellQueueRaw] = await Promise.all([
            redis.zrange(`orderbook:${symbol}:buy`, 0, -1, 'WITHSCORES'),
            redis.zrange(`orderbook:${symbol}:sell`, 0, -1, 'WITHSCORES')
        ]);

        if (buyQueueRaw.length === 0 || sellQueueRaw.length === 0) {
            return null;
        }

        // 2. Parse Orders
        const buys = this.parseOrderQueue(buyQueueRaw);
        const sells = this.parseOrderQueue(sellQueueRaw);

        // 3. Get All Unique Price Levels
        const prices = new Set<number>();
        buys.forEach(o => prices.add(o.price));
        sells.forEach(o => prices.add(o.price));

        if (prices.size === 0) return null;

        const sortedPrices = Array.from(prices).sort((a, b) => a - b);

        // 4. Calculate Aggregate Demand and Supply at each price level
        // Demand at P: Sum of Buy Qty where BuyPrice >= P
        // Supply at P: Sum of Sell Qty where SellPrice <= P

        // Optimize: Pre-aggregate volume by price first
        const buyVolByPrice = new Map<number, number>();
        buys.forEach(o => buyVolByPrice.set(o.price, (buyVolByPrice.get(o.price) || 0) + o.data.remaining_quantity));

        const sellVolByPrice = new Map<number, number>();
        sells.forEach(o => sellVolByPrice.set(o.price, (sellVolByPrice.get(o.price) || 0) + o.data.remaining_quantity));

        const candidates: IEPResult[] = [];

        // We only need to check price levels present in the order book
        for (const p of sortedPrices) {
            let cumBuy = 0;
            let cumSell = 0;

            // Simple summation (Optimization: Could use prefix sums if performance is critical,
            // but for typical order book depth < 1000 levels, iteration is fine)

            // Cumulative Buy: Price >= p
            // Check all buy levels >= p
            for (const [bp, vol] of buyVolByPrice) {
                if (bp >= p) cumBuy += vol;
            }

            // Cumulative Sell: Price <= p
            // Check all sell levels <= p
            for (const [sp, vol] of sellVolByPrice) {
                if (sp <= p) cumSell += vol;
            }

            const matched = Math.min(cumBuy, cumSell);
            if (matched > 0) {
                candidates.push({
                    price: p,
                    matchedVolume: matched,
                    surplus: cumBuy - cumSell
                });
            }
        }

        if (candidates.length === 0) return null;

        // 5. Select Best Price
        // Criteria 1: Max Matched Volume
        candidates.sort((a, b) => b.matchedVolume - a.matchedVolume);

        const maxVol = candidates[0].matchedVolume;
        // Filter those with max volume
        let bestCandidates = candidates.filter(c => c.matchedVolume === maxVol);

        if (bestCandidates.length === 1) return bestCandidates[0];

        // Criteria 2: Min Absolute Surplus
        bestCandidates.sort((a, b) => Math.abs(a.surplus) - Math.abs(b.surplus));
        const minSurplus = Math.abs(bestCandidates[0].surplus);
        bestCandidates = bestCandidates.filter(c => Math.abs(c.surplus) === minSurplus);

        if (bestCandidates.length === 1) return bestCandidates[0];

        // Criteria 3: Closest to Previous Close
        // We need Prev Close. Fetch from DB.
        const prevClose = await this.getPrevClose(symbol);

        bestCandidates.sort((a, b) => Math.abs(a.price - prevClose) - Math.abs(b.price - prevClose));

        // If still tied (e.g. equidistant), usually pick higher price or existing price.
        // We'll pick the first one (which is lower due to initial sort if abs diff is same?
        // Wait, initial sort of `sortedPrices` was asc.
        // Logic: if P1=90, P2=110, Prev=100. Diff is 10.
        // IDX rule: If still tied, use the price closer to the last trade price (which is effectively prev close in pre-open).
        // If equidistant, usually the higher price is preferred in some markets, or price that leaves surplus on the side of the market pressure.
        // Let's just pick the first one after sorting by diff.

        return bestCandidates[0];
    }

    private static parseOrderQueue(raw: string[]): ParsedOrder[] {
        const parsed: ParsedOrder[] = [];
        for (let i = 0; i < raw.length; i += 2) {
            try {
                const data = JSON.parse(raw[i]);
                const price = parseFloat(raw[i+1]);
                if (data.remaining_quantity > 0) {
                    parsed.push({ data, price });
                }
            } catch (e) {
                // ignore
            }
        }
        return parsed;
    }

    private static async getPrevClose(symbol: string): Promise<number> {
        // Cache this ideally. For now, DB query.
        try {
            const res = await pool.query(`
                SELECT prev_close
                FROM daily_stock_data d
                JOIN stocks s ON d.stock_id = s.id
                WHERE s.symbol = $1
                ORDER BY d.session_id DESC LIMIT 1
            `, [symbol]);

            if (res.rows.length > 0) {
                return parseFloat(res.rows[0].prev_close);
            }
        } catch (e) {
            console.error('Error fetching prev close for IEP:', e);
        }
        return 0;
    }
}

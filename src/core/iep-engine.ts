// src/core/iep-engine.ts

import redis from '../config/redis';
import pool from '../config/database';
import { MatchingEngine } from './matching-engine';
import { getTickSize } from './market-logic';

interface IEPResult {
    symbol: string;
    iepPrice: number;
    matchVolume: number;
    surplus: number;
    buySurplus: boolean; // true if buy surplus, false if sell surplus
}

export class IEPEngine {

    /**
     * Calculate Indicative Equilibrium Price (IEP) for a stock
     * Logic:
     * 1. Maximize Tradable Volume
     * 2. Minimize Surplus (Unmatched quantity)
     * 3. Price closest to Previous Close (Reference Price)
     */
    static async calculateIEP(symbol: string): Promise<IEPResult | null> {
        // 1. Get all orders from Redis (Pre-open orders should be in Redis)
        const buyKey = `orderbook:${symbol}:buy`;
        const sellKey = `orderbook:${symbol}:sell`;

        const [buyOrdersRaw, sellOrdersRaw] = await Promise.all([
            redis.zrevrange(buyKey, 0, -1, 'WITHSCORES'),
            redis.zrange(sellKey, 0, -1, 'WITHSCORES')
        ]);

        if (buyOrdersRaw.length === 0 || sellOrdersRaw.length === 0) {
            return null; // No crossover possible if one side is empty
        }

        // 2. Parse Orders
        const buys = this.parseOrders(buyOrdersRaw).sort((a, b) => b.price - a.price); // Desc
        const sells = this.parseOrders(sellOrdersRaw).sort((a, b) => a.price - b.price); // Asc

        if (buys.length === 0 || sells.length === 0) return null;

        // Check if there is any overlap
        if (buys[0].price < sells[0].price) {
            return null; // Highest Bid < Lowest Ask -> No match
        }

        // 3. Get Price Levels (Union of all unique prices in range)
        const prices = new Set<number>();
        buys.forEach(o => prices.add(o.price));
        sells.forEach(o => prices.add(o.price));
        const sortedPrices = Array.from(prices).sort((a, b) => a - b);

        // 4. Calculate Cumulative Volume at each price level
        let candidates: { price: number; volume: number; surplus: number; buySurplus: boolean }[] = [];

        for (const price of sortedPrices) {
            // Demand: Sum of BUY qty where buy_price >= price
            const demand = buys.filter(b => b.price >= price).reduce((sum, b) => sum + b.quantity, 0);

            // Supply: Sum of SELL qty where sell_price <= price
            const supply = sells.filter(s => s.price <= price).reduce((sum, s) => sum + s.quantity, 0);

            const matchVol = Math.min(demand, supply);
            const surplus = Math.abs(demand - supply);
            const buySurplus = demand > supply;

            if (matchVol > 0) {
                candidates.push({ price, volume: matchVol, surplus, buySurplus });
            }
        }

        if (candidates.length === 0) return null;

        // 5. Select Best Price
        // Sort by: Volume (Desc) -> Surplus (Asc)
        candidates.sort((a, b) => {
            if (b.volume !== a.volume) return b.volume - a.volume;
            return a.surplus - b.surplus;
        });

        // If top candidates have same volume and surplus, use Reference Price (Prev Close)
        const topCandidate = candidates[0];
        const bestCandidates = candidates.filter(c =>
            c.volume === topCandidate.volume && c.surplus === topCandidate.surplus
        );

        let finalPrice = topCandidate.price;

        if (bestCandidates.length > 1) {
            // Fetch Prev Close
            const stockRes = await pool.query('SELECT prev_close FROM daily_stock_data d JOIN stocks s ON s.id = d.stock_id WHERE s.symbol = $1 ORDER BY d.session_id DESC LIMIT 1', [symbol]);
            const prevClose = parseFloat(stockRes.rows[0]?.prev_close || '0');

            // Find closest to prevClose
            bestCandidates.sort((a, b) => Math.abs(a.price - prevClose) - Math.abs(b.price - prevClose));
            finalPrice = bestCandidates[0].price;
        }

        const selected = candidates.find(c => c.price === finalPrice)!;

        return {
            symbol,
            iepPrice: selected.price,
            matchVolume: selected.volume,
            surplus: selected.surplus,
            buySurplus: selected.buySurplus
        };
    }

    // Helper to parse Redis ZRANGE results
    private static parseOrders(raw: string[]) {
        const orders = [];
        for (let i = 0; i < raw.length; i += 2) {
            const data = JSON.parse(raw[i]);
            orders.push({
                ...data,
                price: parseFloat(raw[i+1]),
                quantity: data.remaining_quantity || data.quantity
            });
        }
        return orders;
    }

    /**
     * Execute trades at the determined IEP
     */
    static async executeIEPTrades(symbol: string, iep: IEPResult) {
        if (!iep || iep.matchVolume === 0) return;

        console.log(`⚡ Executing IEP for ${symbol} @ ${iep.iepPrice} (Vol: ${iep.matchVolume})`);

        // We use MatchingEngine logic but strictly at one price
        // Actually, MatchingEngine.match logic might be complex to reuse for single-price auction
        // But essentially, we match orders that are executable at IEP price.
        // Orders: Buys >= IEP, Sells <= IEP.

        // Priority: Price (Better price first) -> Time (Earlier first)

        // Let's use a custom atomic matching transaction script or reuse logic.
        // Reusing MatchingEngine.match is tricky because it does continuous matching.
        // Here we just want to match UP TO iep.matchVolume.

        // Simpler approach:
        // 1. Fetch eligible orders
        // 2. Pair them up strictly
        // 3. Update DB & Redis

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const buyKey = `orderbook:${symbol}:buy`;
            const sellKey = `orderbook:${symbol}:sell`;

            // Get eligible orders
            // Buys: score >= iepPrice
            const buyOrders = await redis.zrangebyscore(buyKey, iep.iepPrice, '+inf'); // Standard ZRANGEBYSCORE is min max
            // Redis ZRANGEBYSCORE min max.

            // Sells: score <= iepPrice
            const sellOrders = await redis.zrangebyscore(sellKey, '-inf', iep.iepPrice);

            // Sort manually to be safe (Price Priority then Time Priority)
            const parsedBuys = buyOrders.map(s => JSON.parse(s)).sort((a: any, b: any) => {
                 if (b.price !== a.price) return b.price - a.price; // Higher buy price first
                 return a.timestamp - b.timestamp; // Earlier first
            });

            const parsedSells = sellOrders.map(s => JSON.parse(s)).sort((a: any, b: any) => {
                if (a.price !== b.price) return a.price - b.price; // Lower sell price first
                return a.timestamp - b.timestamp; // Earlier first
            });

            let volumeLeft = iep.matchVolume;
            let buyIdx = 0;
            let sellIdx = 0;

            const trades = [];
            const processedOrders = new Set<string>(); // Order IDs modified

            while (volumeLeft > 0 && buyIdx < parsedBuys.length && sellIdx < parsedSells.length) {
                const buyOrder = parsedBuys[buyIdx];
                const sellOrder = parsedSells[sellIdx];

                const tradeQty = Math.min(buyOrder.remaining_quantity, sellOrder.remaining_quantity, volumeLeft);

                // Record Trade
                trades.push({
                    buy_order_id: buyOrder.orderId,
                    sell_order_id: sellOrder.orderId,
                    price: iep.iepPrice,
                    quantity: tradeQty,
                    stock_id: buyOrder.stockId
                });

                // Update Local State
                buyOrder.remaining_quantity -= tradeQty;
                sellOrder.remaining_quantity -= tradeQty;
                volumeLeft -= tradeQty;

                processedOrders.add(buyOrder.orderId);
                processedOrders.add(sellOrder.orderId);

                // Move pointers
                if (buyOrder.remaining_quantity === 0) buyIdx++;
                if (sellOrder.remaining_quantity === 0) sellIdx++;
            }

            // Batch Database Updates
            for (const trade of trades) {
                // Insert Trade
                await client.query(`
                    INSERT INTO trades (buy_order_id, sell_order_id, price, quantity, stock_id)
                    VALUES ($1, $2, $3, $4, $5)
                `, [trade.buy_order_id, trade.sell_order_id, trade.price, trade.quantity, trade.stock_id]);

                // Update Orders
                // Only need to decrease remaining_quantity. If 0, status -> MATCHED (handled by check logic usually)
                // But here let's explicit update
                await client.query(`
                    UPDATE orders SET remaining_quantity = remaining_quantity - $1,
                    status = CASE WHEN remaining_quantity - $1 = 0 THEN 'MATCHED' ELSE 'PARTIAL' END
                    WHERE id = $2
                `, [trade.quantity, trade.buy_order_id]);

                 await client.query(`
                    UPDATE orders SET remaining_quantity = remaining_quantity - $1,
                    status = CASE WHEN remaining_quantity - $1 = 0 THEN 'MATCHED' ELSE 'PARTIAL' END
                    WHERE id = $2
                `, [trade.quantity, trade.sell_order_id]);

                 // Update Buyer Portfolio (Add Shares)
                 await client.query(`
                    INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
                    VALUES ((SELECT user_id FROM orders WHERE id = $1), $2, $3, $4)
                    ON CONFLICT (user_id, stock_id) DO UPDATE
                    SET quantity_owned = portfolios.quantity_owned + EXCLUDED.quantity_owned,
                        avg_buy_price = (portfolios.avg_buy_price * portfolios.quantity_owned + EXCLUDED.avg_buy_price * EXCLUDED.quantity_owned) / (portfolios.quantity_owned + EXCLUDED.quantity_owned)
                 `, [trade.buy_order_id, trade.stock_id, trade.quantity, trade.price]);

                 // Refund Buyer if Execution Price < Bid Price
                 // Need to fetch original bid price? No, we have it in memory or can fetch.
                 // We know the trade price (IEP) and the quantity.
                 // We need to know the User's BID price for this specific order.
                 // We can get it from 'orders' table.
                 const buyOrderRes = await client.query('SELECT price, user_id FROM orders WHERE id = $1', [trade.buy_order_id]);
                 const buyOrder = buyOrderRes.rows[0];
                 const bidPrice = parseFloat(buyOrder.price);

                 if (bidPrice > trade.price) {
                     const refundPerShare = bidPrice - trade.price;
                     const totalRefund = refundPerShare * trade.quantity * 100;
                     if (totalRefund > 0) {
                        await client.query(`
                            UPDATE users SET balance_rdn = balance_rdn + $1
                            WHERE id = $2
                        `, [totalRefund, buyOrder.user_id]);
                        console.log(`💸 Refunded ${totalRefund} to user ${buyOrder.user_id} (Bid: ${bidPrice}, Exec: ${trade.price})`);
                     }
                 }
            }

            // Refund Sellers (Realized Gains)
            // Seller money logic: (Price * Qty * 100) added to RDN
             for (const trade of trades) {
                 const totalValue = trade.price * trade.quantity * 100;
                 await client.query(`
                    UPDATE users SET balance_rdn = balance_rdn + $1
                    WHERE id = (SELECT user_id FROM orders WHERE id = $2)
                 `, [totalValue, trade.sell_order_id]);

                 // Reduce Seller Portfolio shares (Actually we only locked them logically in PlaceOrder,
                 // but typically we should decrement now if we haven't.
                 // Wait, OrderService.ts says: "JANGAN kurangi saham dari portfolio di sini (PlaceOrder)".
                 // So we MUST decrease it here.)
                 await client.query(`
                    UPDATE portfolios SET quantity_owned = quantity_owned - $1
                    WHERE user_id = (SELECT user_id FROM orders WHERE id = $2) AND stock_id = $3
                 `, [trade.quantity, trade.sell_order_id, trade.stock_id]);
             }

            await client.query('COMMIT');

            // Update Redis
            // We need to update or remove the orders we touched.
            // Simplest is to remove all involved and re-add if remaining > 0

            const pipeline = redis.pipeline();

            // Clean up old entries
            // Need original scores to remove efficiently or just ZREM with member
            // We have the JSON strings from raw fetch, but member strings might differ if we parsed/stringified differently?
            // Usually safest to Remove by ID matching if possible, but ZREM needs exact member.

            // For simplicity in IEP (batch), let's just re-sync specific orders or just update them.
            // We updated the objects in memory (parsedBuys/Sells).

            const updateRedisOrder = (order: any, type: 'buy' | 'sell') => {
                 const key = `orderbook:${symbol}:${type}`;
                 pipeline.zremrangebyscore(key, order.price, order.price); // CAREFUL: This removes ALL at that price!
                 // BETTER: ZREM member. But we need exact string.
                 // Let's rely on the fact that we can construct the exact string if we didn't change other props.
            };

            // Actually, best way is to iterate processedOrders and update/rem them.
            // Since this is complex to do perfectly atomically with Redis in this script without locking,
            // we will do a "Best Effort" update.

            for(const order of parsedBuys) {
                if (processedOrders.has(order.orderId)) {
                     // Remove old
                     // Since we don't have exact old string, we might struggle.
                     // But wait, we parsed it from `buyOrders` list.
                     // We can find the original string in `buyOrders` array?
                     // No, `buyOrders` was just values.

                     // It is safer to:
                     // 1. Remove the order from ZSET (we need to scan for it or use ZREM with exact content).
                     //    To find exact content, we can use ZRANGEBYSCORE and filter by ID.

                     const oldEntries = await redis.zrangebyscore(`orderbook:${symbol}:buy`, order.price, order.price);
                     for(const entry of oldEntries) {
                         if (entry.includes(order.orderId)) {
                             pipeline.zrem(`orderbook:${symbol}:buy`, entry);
                             break; // Found it
                         }
                     }

                     // 2. Add new if remaining > 0
                     if (order.remaining_quantity > 0) {
                         const newPayload = JSON.stringify(order);
                         pipeline.zadd(`orderbook:${symbol}:buy`, order.price, newPayload);
                     }
                }
            }

            for(const order of parsedSells) {
                if (processedOrders.has(order.orderId)) {
                     const oldEntries = await redis.zrangebyscore(`orderbook:${symbol}:sell`, order.price, order.price);
                     for(const entry of oldEntries) {
                         if (entry.includes(order.orderId)) {
                             pipeline.zrem(`orderbook:${symbol}:sell`, entry);
                             break;
                         }
                     }

                     if (order.remaining_quantity > 0) {
                         const newPayload = JSON.stringify(order);
                         pipeline.zadd(`orderbook:${symbol}:sell`, order.price, newPayload);
                     }
                }
            }

            await pipeline.exec();

            console.log(`✅ IEP Execution complete for ${symbol}`);

        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`❌ IEP Execution failed for ${symbol}:`, err);
        } finally {
            client.release();
        }
    }
}

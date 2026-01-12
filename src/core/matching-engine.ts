// core/matching-engine.ts

import { Server } from 'socket.io';
import pool from '../config/database';
import redis from '../config/redis';
import { IEPEngine } from './iep-engine';
import { SessionStatus } from '../config/market';

// Circuit Breaker States
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreaker {
    state: CircuitState;
    failures: number;
    lastFailure: number;
    successesInHalfOpen: number;
}

interface OrderData {
    orderId: string;
    userId: string;
    stockId: number;
    price: number;
    quantity: number;
    timestamp: number;
    remaining_quantity: number;
    avg_price_at_order?: number; // Added avg_price_at_order
}

interface ParsedOrder {
    data: OrderData;
    price: number;
    raw: string;
}

export class MatchingEngine {
    private static io: Server;

    // Lock sederhana untuk mencegah race condition pada saham yang sama
    private static processingQueue = new Map<string, { isProcessing: boolean; pending: number }>();

    // THROTTLING STATE untuk broadcast
    private static broadcastTimers = new Map<string, NodeJS.Timeout>();
    private static pendingBroadcasts = new Set<string>();

    // Circuit Breaker per symbol
    private static circuitBreakers = new Map<string, CircuitBreaker>();
    private static readonly CIRCUIT_FAILURE_THRESHOLD = 5;
    private static readonly CIRCUIT_RESET_TIMEOUT = 30000; // 30 seconds
    private static readonly CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD = 3;

    // Stats untuk monitoring
    private static stats = {
        matchesProcessed: 0,
        tradesExecuted: 0,
        errors: 0,
        circuitBroken: 0,
        lockTimeouts: 0,
        retries: 0,
        lastReset: Date.now()
    };

    // Configurable limits
    private static readonly MAX_ITERATIONS_PER_CYCLE = 100;
    private static readonly LOCK_TIMEOUT_MS = 30000;
    private static readonly BROADCAST_THROTTLE_MS = 500; // 500ms throttle for better responsiveness
    private static readonly DEBUG = false; // Set to true for detailed matching logs

    private static currentSessionStatus: SessionStatus = SessionStatus.CLOSED;

    static initialize(ioInstance: Server) {
        this.io = ioInstance;

        // Reset stats setiap menit
        setInterval(() => {
            const elapsed = (Date.now() - this.stats.lastReset) / 1000;
            const tps = this.stats.tradesExecuted / elapsed;
            console.log(`📈 Matching Engine Stats: ` +
                `Trades=${this.stats.tradesExecuted} (${tps.toFixed(2)} TPS), ` +
                `Matches=${this.stats.matchesProcessed}, ` +
                `Errors=${this.stats.errors}, ` +
                `CircuitBroken=${this.stats.circuitBroken}, ` +
                `LockTimeouts=${this.stats.lockTimeouts}`
            );
            this.stats = {
                matchesProcessed: 0,
                tradesExecuted: 0,
                errors: 0,
                circuitBroken: 0,
                lockTimeouts: 0,
                retries: 0,
                lastReset: Date.now()
            };
        }, 60000);

        // Cleanup stale orders periodically
        setInterval(() => this.cleanupStaleOrders(), 60000);

        console.log('✅ Matching Engine initialized with circuit breaker and monitoring');
    }

    static setSessionStatus(status: SessionStatus) {
        this.currentSessionStatus = status;
        console.log(`ℹ️ MatchingEngine Session Status updated to: ${status}`);
    }

    /**
     * Get or create circuit breaker for symbol
     */
    private static getCircuitBreaker(symbol: string): CircuitBreaker {
        if (!this.circuitBreakers.has(symbol)) {
            this.circuitBreakers.set(symbol, {
                state: 'CLOSED',
                failures: 0,
                lastFailure: 0,
                successesInHalfOpen: 0
            });
        }
        return this.circuitBreakers.get(symbol)!;
    }

    /**
     * Check if circuit allows request
     */
    private static canProcess(symbol: string): boolean {
        const cb = this.getCircuitBreaker(symbol);

        switch (cb.state) {
            case 'CLOSED':
                return true;
            case 'OPEN':
                // Check if timeout has passed
                if (Date.now() - cb.lastFailure >= this.CIRCUIT_RESET_TIMEOUT) {
                    cb.state = 'HALF_OPEN';
                    cb.successesInHalfOpen = 0;
                    console.log(`🔄 Circuit breaker HALF_OPEN for ${symbol}`);
                    return true;
                }
                return false;
            case 'HALF_OPEN':
                return true;
            default:
                return true;
        }
    }

    /**
     * Record success for circuit breaker
     */
    private static recordSuccess(symbol: string) {
        const cb = this.getCircuitBreaker(symbol);

        if (cb.state === 'HALF_OPEN') {
            cb.successesInHalfOpen++;
            if (cb.successesInHalfOpen >= this.CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD) {
                cb.state = 'CLOSED';
                cb.failures = 0;
                console.log(`✅ Circuit breaker CLOSED for ${symbol}`);
            }
        } else if (cb.state === 'CLOSED') {
            cb.failures = Math.max(0, cb.failures - 1);
        }
    }

    /**
     * Record failure for circuit breaker
     */
    private static recordFailure(symbol: string) {
        const cb = this.getCircuitBreaker(symbol);
        cb.failures++;
        cb.lastFailure = Date.now();

        if (cb.state === 'HALF_OPEN') {
            cb.state = 'OPEN';
            this.stats.circuitBroken++;
            console.log(`🔴 Circuit breaker OPEN for ${symbol} (half-open failure)`);
        } else if (cb.failures >= this.CIRCUIT_FAILURE_THRESHOLD) {
            cb.state = 'OPEN';
            this.stats.circuitBroken++;
            console.log(`🔴 Circuit breaker OPEN for ${symbol} (${cb.failures} failures)`);
        }
    }

    /**
     * Main entry point - triggers matching untuk symbol tertentu
     */
    static async match(symbol: string) {
        if (this.DEBUG) console.log(`🎯 [${symbol}] Match request received`);

        // Check circuit breaker
        if (!this.canProcess(symbol)) {
            console.log(`⚡ Circuit breaker preventing match for ${symbol}`);
            return;
        }

        // Initialize queue state
        if (!this.processingQueue.has(symbol)) {
            this.processingQueue.set(symbol, { isProcessing: false, pending: 0 });
        }

        const queueState = this.processingQueue.get(symbol)!;

        // If already processing, increment pending counter
        if (queueState.isProcessing) {
            queueState.pending++;
            if (this.DEBUG) console.log(`⏳ [${symbol}] Already processing, pending count: ${queueState.pending}`);
            return;
        }

        queueState.isProcessing = true;
        if (this.DEBUG) console.log(`▶️ [${symbol}] Starting matching process...`);

        // Safety timeout
        const timeout = setTimeout(() => {
            console.error(`⚠️ Matching timeout for ${symbol} - forcing release`);
            this.stats.lockTimeouts++;
            queueState.isProcessing = false;
            queueState.pending = 0;
        }, this.LOCK_TIMEOUT_MS);

        try {
            // Check Session Status
            if (this.currentSessionStatus === SessionStatus.PRE_OPEN || this.currentSessionStatus === SessionStatus.LOCKED) {
                // IEP Phase: Calculate & Broadcast only
                await this.processIEPCalculation(symbol);
            } else if (this.currentSessionStatus === SessionStatus.OPEN) {
                // Continuous Trading Phase
                await this.processMatching(symbol);
            } else {
                // Closed/Break
                if (this.DEBUG) console.log(`⏸️ [${symbol}] Market is ${this.currentSessionStatus}, skipping match.`);
            }

            this.recordSuccess(symbol);
        } catch (error: any) {
            this.stats.errors++;
            this.recordFailure(symbol);
            console.error(`❌ Matching error on ${symbol}:`, error.message || error);
        } finally {
            clearTimeout(timeout);
            queueState.isProcessing = false;

            // Process pending matches
            if (queueState.pending > 0) {
                queueState.pending = 0;
                setImmediate(() => this.match(symbol));
            }
        }
    }

    /**
     * IEP Calculation and Broadcast (No Execution)
     */
    private static async processIEPCalculation(symbol: string) {
        const iepData = await IEPEngine.calculateIEP(symbol);

        if (this.io) {
            // Broadcast Orderbook (still needed for user visibility)
            await this.throttledBroadcast(symbol);

            // Broadcast IEP
            // User requirement: "nilai ini hanya ada isinya ketika 5 detik locked IEP, sisanya null"
            // Wait, point 1: "15 detik Pre-Opening fase yang secara realtime berubah, dan 5 detik terakhir locked. Jadi totalnya 20 detik, diluar 20 detik itu isi nilainya dengan null."
            // So during PRE_OPEN and LOCKED, we broadcast the value.

            // However, strictly speaking, during LOCKED, the value shouldn't change because no new orders.
            // But we should still broadcast it.

            // The requirement allows showing it in PRE_OPEN too ("realtime berubah").

            const payload = iepData ? {
                symbol,
                iep: iepData.price,
                volume: iepData.matchedVolume,
                surplus: iepData.surplus,
                status: this.currentSessionStatus
            } : {
                symbol,
                iep: null,
                volume: 0,
                surplus: 0,
                status: this.currentSessionStatus
            };

            this.io.to(symbol).emit('iep_update', payload);
            if (this.DEBUG) console.log(`📊 [${symbol}] IEP Update:`, payload);
        }
    }

    /**
     * Execute IEP Match (Call Auction)
     * Called when transitioning LOCKED -> OPEN
     */
    static async executeIEP(symbol: string) {
        if (this.DEBUG) console.log(`🚀 [${symbol}] Executing IEP...`);

        // Ensure status is OPEN so we can execute
        // Actually this method is called exactly at the transition.

        const iepResult = await IEPEngine.calculateIEP(symbol);
        if (!iepResult || iepResult.matchedVolume === 0) {
            console.log(`ℹ️ [${symbol}] No IEP match possible.`);

            // Clear IEP display
            if (this.io) {
                this.io.to(symbol).emit('iep_update', { symbol, iep: null, status: SessionStatus.OPEN });
            }
            return;
        }

        const matchPrice = iepResult.price;
        console.log(`💎 [${symbol}] IEP Executing at ${matchPrice} with volume ${iepResult.matchedVolume}`);

        // Fetch all potential orders from Redis
        const [buyQueueRaw, sellQueueRaw] = await Promise.all([
            redis.zrevrange(`orderbook:${symbol}:buy`, 0, -1, 'WITHSCORES'),
            redis.zrange(`orderbook:${symbol}:sell`, 0, -1, 'WITHSCORES')
        ]);

        const buys = this.parseOrderQueue(buyQueueRaw, symbol, 'buy');
        const sells = this.parseOrderQueue(sellQueueRaw, symbol, 'sell');

        // Filter executable orders
        const executableBuys = buys.filter(b => b.price >= matchPrice);
        const executableSells = sells.filter(s => s.price <= matchPrice);

        // Sort by Priority (Price-Time)
        // Buy: Higher Price = Higher Priority (already sorted by Redis score usually, but check)
        // Redis zrevrange returns highest score first. So buys are sorted by Price Desc.
        // For same price, we need Time Asc. Redis handles score, but for same score, it uses Lexicographical order of member.
        // Our member is JSON string. This is NOT reliable for Time priority.
        // We MUST sort manually by Price (Best) then Timestamp (Oldest).

        executableBuys.sort((a, b) => b.price !== a.price ? b.price - a.price : a.data.timestamp - b.data.timestamp);
        executableSells.sort((a, b) => a.price !== b.price ? a.price - b.price : a.data.timestamp - b.data.timestamp);

        let remainingVolToMatch = iepResult.matchedVolume;
        let buyIdx = 0;
        let sellIdx = 0;

        while (remainingVolToMatch > 0 && buyIdx < executableBuys.length && sellIdx < executableSells.length) {
            const buyOrder = executableBuys[buyIdx];
            const sellOrder = executableSells[sellIdx];

            const matchQty = Math.min(
                remainingVolToMatch,
                buyOrder.data.remaining_quantity,
                sellOrder.data.remaining_quantity
            );

            // Execute Trade at IEP Price
            await this.executeTrade(
                buyOrder.data,
                sellOrder.data,
                matchPrice, // FORCE PRICE to IEP
                symbol,
                buyOrder.price,
                sellOrder.price,
                buyOrder.raw,
                sellOrder.raw
            );

            remainingVolToMatch -= matchQty;

            // Update local state to track remaining quantities (executeTrade updates DB/Redis, but not our local arrays)
            buyOrder.data.remaining_quantity -= matchQty;
            sellOrder.data.remaining_quantity -= matchQty;

            if (buyOrder.data.remaining_quantity <= 0) buyIdx++;
            if (sellOrder.data.remaining_quantity <= 0) sellIdx++;
        }

        // Broadcast final cleanup
        if (this.io) {
            this.io.to(symbol).emit('iep_update', { symbol, iep: null, status: SessionStatus.OPEN });
            await this.throttledBroadcast(symbol);
        }
    }

    /**
     * Core matching logic
     */
    private static async processMatching(symbol: string) {
        if (this.DEBUG) console.log(`🔄 [${symbol}] Processing matching cycle...`);
        let matchOccurred = true;
        let iterations = 0;

        while (matchOccurred && iterations < this.MAX_ITERATIONS_PER_CYCLE) {
            matchOccurred = false;
            iterations++;

            // Fetch orderbook dari Redis
            const [buyQueueRaw, sellQueueRaw] = await Promise.all([
                redis.zrevrange(`orderbook:${symbol}:buy`, 0, 19, 'WITHSCORES'),
                redis.zrange(`orderbook:${symbol}:sell`, 0, 19, 'WITHSCORES')
            ]);

            if (this.DEBUG) console.log(`📊 [${symbol}] Iteration ${iterations}: ${buyQueueRaw.length/2} buy orders, ${sellQueueRaw.length/2} sell orders`);

            if (buyQueueRaw.length === 0 || sellQueueRaw.length === 0) {
                if (this.DEBUG) console.log(`⚠️ [${symbol}] No orders to match (buy: ${buyQueueRaw.length/2}, sell: ${sellQueueRaw.length/2})`);
                break;
            }

            // Parse orders
            const buys = this.parseOrderQueue(buyQueueRaw, symbol, 'buy');
            const sells = this.parseOrderQueue(sellQueueRaw, symbol, 'sell');

            if (buys.length === 0 || sells.length === 0) break;

            // Sort by price-time priority
            buys.sort((a, b) => b.price !== a.price ? b.price - a.price : a.data.timestamp - b.data.timestamp);
            sells.sort((a, b) => a.price !== b.price ? a.price - b.price : a.data.timestamp - b.data.timestamp);

            const topBuy = buys[0];
            const topSell = sells[0];

            if (this.DEBUG) console.log(`🔍 [${symbol}] Matching Check: BUY ${topBuy.price} (${topBuy.data.remaining_quantity} lots) vs SELL ${topSell.price} (${topSell.data.remaining_quantity} lots)`);

            // Check if prices cross
            if (topBuy.price >= topSell.price) {
                matchOccurred = true;

                // Determine execution price (price-time priority)
                const executionPrice = topBuy.data.timestamp < topSell.data.timestamp
                    ? topBuy.price
                    : topSell.price;

                console.log(`✨ [${symbol}] MATCH FOUND! Executing @ ${executionPrice}`);

                // Execute trade
                await this.executeTrade(
                    topBuy.data, topSell.data,
                    executionPrice, symbol,
                    topBuy.price, topSell.price,
                    topBuy.raw, topSell.raw
                );

                this.stats.tradesExecuted++;
            } else {
                if (this.DEBUG) console.log(`❌ [${symbol}] No match: BUY ${topBuy.price} < SELL ${topSell.price}`);
            }
        }

        this.stats.matchesProcessed++;

        // Broadcast orderbook update
        if (this.io) {
            await this.throttledBroadcast(symbol);
        }
    }

    /**
     * Parse Redis ZRANGE result
     */
    private static parseOrderQueue(raw: string[], symbol: string, side: 'buy' | 'sell'): ParsedOrder[] {
        const parsed: ParsedOrder[] = [];

        for (let i = 0; i < raw.length; i += 2) {
            try {
                const scoreData = raw[i + 1];
                if (scoreData === undefined) continue;

                const data = JSON.parse(raw[i]) as OrderData;
                const price = parseFloat(scoreData);

                if (isNaN(price)) {
                    console.warn('⚠️ Invalid price in Redis:', scoreData);
                    redis.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => {});
                    continue;
                }

                // Basic validation
                if (!data.orderId || !data.userId) {
                    redis.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => {});
                    continue;
                }

                // Ensure remaining_quantity exists and is valid
                const qty = data.remaining_quantity ?? data.quantity;
                if (typeof qty !== 'number' || qty <= 0) {
                    redis.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => {});
                    continue;
                }

                parsed.push({
                    data: { ...data, remaining_quantity: qty },
                    price: price,
                    raw: raw[i]
                });
            } catch (e) {
                redis.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => {});
            }
        }

        return parsed;
    }

    /**
     * Cleanup stale/invalid orders from Redis
     */
    private static async cleanupStaleOrders() {
        try {
            let cursor = '0';
            do {
                const [newCursor, keys] = await redis.scan(cursor, 'MATCH', 'orderbook:*', 'COUNT', 50);
                cursor = newCursor;

                for (const key of keys) {
                    if (!key.endsWith(':buy') && !key.endsWith(':sell')) continue;

                    const orders = await redis.zrange(key, 0, -1);
                    const invalidOrders: string[] = [];

                    for (const orderStr of orders) {
                        try {
                            const order = JSON.parse(orderStr);
                            if (!order.orderId || !order.userId ||
                                !order.remaining_quantity || order.remaining_quantity <= 0) {
                                invalidOrders.push(orderStr);
                            }
                        } catch (e) {
                            invalidOrders.push(orderStr);
                        }
                    }

                    if (invalidOrders.length > 0) {
                        await redis.zrem(key, ...invalidOrders);
                        console.warn(`🧹 Cleaned ${invalidOrders.length} invalid orders from ${key}`);
                    }
                }
            } while (cursor !== '0');
        } catch (err) {
            // Ignore cleanup errors
        }
    }

    /**
     * Execute single trade
     */
    private static async executeTrade(
        buyOrder: OrderData,
        sellOrder: OrderData,
        matchPrice: number,
        symbol: string,
        originalBuyPrice: number,
        originalSellPrice: number,
        buyRaw: string,
        sellRaw: string
    ) {
        const client = await pool.connect();

        try {
            await client.query('SET LOCAL statement_timeout = 10000');
            await client.query('BEGIN');

            const isBuyBot = buyOrder.userId === 'SYSTEM_BOT' || buyOrder.orderId?.toString().startsWith('BOT-');
            const isSellBot = sellOrder.userId === 'SYSTEM_BOT' || sellOrder.orderId?.toString().startsWith('BOT-');

            // Verify real orders exist in database
            if (!isBuyBot || !isSellBot) {
                const orderIds = [];
                if (!isBuyBot) orderIds.push(buyOrder.orderId);
                if (!isSellBot) orderIds.push(sellOrder.orderId);

                if (orderIds.length > 0) {
                    const orderCheck = await client.query(
                        `SELECT id FROM orders WHERE id = ANY($1) AND status IN ('PENDING', 'PARTIAL')`,
                        [orderIds]
                    );

                    if (orderCheck.rowCount !== orderIds.length) {
                        console.warn(`⚠️ Order validation failed for ${symbol}`);

                        // Remove invalid orders from Redis
                        if (!isBuyBot && !orderCheck.rows.find((r: any) => r.id === buyOrder.orderId)) {
                            await redis.zrem(`orderbook:${symbol}:buy`, buyRaw);
                        }
                        if (!isSellBot && !orderCheck.rows.find((r: any) => r.id === sellOrder.orderId)) {
                            await redis.zrem(`orderbook:${symbol}:sell`, sellRaw);
                        }

                        await client.query('ROLLBACK');
                        return;
                    }
                }
            }

            // Calculate quantities
            const buyQtyAvailable = buyOrder.remaining_quantity || buyOrder.quantity;
            const sellQtyAvailable = sellOrder.remaining_quantity || sellOrder.quantity;
            const matchQty = Math.min(buyQtyAvailable, sellQtyAvailable);
            const buyRemaining = buyQtyAvailable - matchQty;
            const sellRemaining = sellQtyAvailable - matchQty;

            // --- DATABASE UPDATES FIRST ---
            // 1. Record trade (Always record trade, even for bots)
            // Bots will have NULL order_id in trades table
            await client.query(
                `INSERT INTO trades (buy_order_id, sell_order_id, stock_id, price, quantity)
                 VALUES ($1, $2, COALESCE($3, (SELECT id FROM stocks WHERE symbol = $6)), $4, $5)`,
                [
                    isBuyBot ? null : buyOrder.orderId,
                    isSellBot ? null : sellOrder.orderId,
                    buyOrder.stockId || sellOrder.stockId, // Try to get stockId from order data
                    matchPrice,
                    matchQty,
                    symbol // Fallback symbol lookup if stockId is missing (legacy orders)
                ]
            );

            // 2. Update orders in database
            if (!isBuyBot) {
                const buyStatus = buyRemaining > 0 ? 'PARTIAL' : 'MATCHED';
                await client.query(
                    `UPDATE orders SET status = $1, remaining_quantity = $2, updated_at = NOW() WHERE id = $3`,
                    [buyStatus, buyRemaining, buyOrder.orderId]
                );
            }

            if (!isSellBot) {
                const sellStatus = sellRemaining > 0 ? 'PARTIAL' : 'MATCHED';
                await client.query(
                    `UPDATE orders SET status = $1, remaining_quantity = $2, updated_at = NOW() WHERE id = $3`,
                    [sellStatus, sellRemaining, sellOrder.orderId]
                );
            }

            // 3. Update buyer portfolio & refund
            if (!isBuyBot) {
                await client.query(`
                    INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
                    VALUES ($1, (SELECT id FROM stocks WHERE symbol = $3), $2, $4)
                        ON CONFLICT (user_id, stock_id) DO UPDATE SET
                        avg_buy_price = CASE
                                                               WHEN portfolios.quantity_owned + $2 = 0 THEN 0
                                                               ELSE ((portfolios.avg_buy_price * portfolios.quantity_owned) + ($4 * $2)) / (portfolios.quantity_owned + $2)
                    END,
                    quantity_owned = portfolios.quantity_owned + $2
                `, [buyOrder.userId, matchQty, symbol, matchPrice]);

                // Refund excess balance if bought cheaper
                if (matchPrice < originalBuyPrice) {
                    const refund = (originalBuyPrice - matchPrice) * (matchQty * 100);
                    await client.query('UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2', [refund, buyOrder.userId]);
                }
            }

            // 4. Update seller balance and portfolio
            if (!isSellBot) {
                const gain = matchPrice * (matchQty * 100);
                await client.query('UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2', [gain, sellOrder.userId]);

                await client.query(`
                    UPDATE portfolios SET quantity_owned = quantity_owned - $1
                    WHERE user_id = $2 AND stock_id = (SELECT id FROM stocks WHERE symbol = $3)
                `, [matchQty, sellOrder.userId, symbol]);
            }

            // 5. Update daily candle stats
            await client.query(`
                UPDATE daily_stock_data SET
                                            open_price = COALESCE(open_price, $1),
                                            high_price = GREATEST(COALESCE(high_price, $1), $1),
                                            low_price = LEAST(COALESCE(low_price, $1), $1),
                                            close_price = $1,
                                            volume = COALESCE(volume, 0) + $2
                WHERE stock_id = (SELECT id FROM stocks WHERE symbol = $3)
                  AND session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
            `, [matchPrice, matchQty, symbol]);

            // COMMIT DATABASE TRANSACTION
            await client.query('COMMIT');

            // --- REDIS UPDATES AFTER DB COMMIT ---
            // Atomically remove and potentially add back to Redis
            const buyKey = `orderbook:${symbol}:buy`;
            const sellKey = `orderbook:${symbol}:sell`;

            const multi = redis.multi();
            multi.zrem(buyKey, buyRaw);
            multi.zrem(sellKey, sellRaw);

            if (buyRemaining > 0) {
                const newBuyOrder = { ...buyOrder, remaining_quantity: buyRemaining };
                multi.zadd(buyKey, originalBuyPrice, JSON.stringify(newBuyOrder));
            }
            if (sellRemaining > 0) {
                const newSellOrder = { ...sellOrder, remaining_quantity: sellRemaining };
                multi.zadd(sellKey, originalSellPrice, JSON.stringify(newSellOrder));
            }
            await multi.exec();

            const tradeLabel = (isBuyBot || isSellBot) ? '🤖 BOT MATCH' : '✅ MATCH';
            console.log(`${tradeLabel}! ${symbol}: ${matchQty} lots @ ${matchPrice}`);

            // 6. Emit notifications
            this.emitTradeNotifications(
                symbol, matchPrice, matchQty,
                buyOrder, sellOrder,
                buyRemaining, sellRemaining,
                isBuyBot, isSellBot
            );

        } catch (err: any) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('❌ Trade execution failed:', err.message);
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Throttled broadcast
     */
    private static async throttledBroadcast(symbol: string) {
        if (this.broadcastTimers.has(symbol)) {
            this.pendingBroadcasts.add(symbol);
            return;
        }

        await this.sendOrderbookUpdate(symbol);

        const timer = setTimeout(async () => {
            this.broadcastTimers.delete(symbol);
            if (this.pendingBroadcasts.has(symbol)) {
                this.pendingBroadcasts.delete(symbol);
                await this.throttledBroadcast(symbol);
            }
        }, this.BROADCAST_THROTTLE_MS);

        this.broadcastTimers.set(symbol, timer);
    }

    /**
     * Send orderbook update
     */
    private static async sendOrderbookUpdate(symbol: string) {
        try {
            const [buyOrders, sellOrders] = await Promise.all([
                redis.zrevrange(`orderbook:${symbol}:buy`, 0, 49, 'WITHSCORES'), // Ambil agak banyakan dikit buat safety
                redis.zrange(`orderbook:${symbol}:sell`, 0, 49, 'WITHSCORES')
            ]);

            // 1. Helper Parse dari Redis Raw String ke Object
            const parseOrders = (raw: string[]) => {
                const result = [];
                for (let i = 0; i < raw.length; i += 2) {
                    try {
                        const scoreData = raw[i + 1];
                        if (!raw[i] || scoreData === undefined) continue;

                        const data = JSON.parse(raw[i]) as OrderData;
                        const price = parseFloat(scoreData);

                        if (isNaN(price)) continue;

                        // Pastikan qty valid
                        const qty = data.remaining_quantity || data.quantity;
                        if (!qty || qty <= 0) continue;

                        result.push({ price, quantity: qty });
                    } catch (e) {
                        // Ignore parse error
                    }
                }
                return result;
            };

            // 2. Helper Aggregate (Grouping by Price)
            const aggregateByPrice = (orders: any[]) => {
                const priceMap = new Map<number, { totalQty: number, count: number }>();

                for (const order of orders) {
                    const price = order.price;
                    const qty = order.quantity;

                    const existing = priceMap.get(price) || { totalQty: 0, count: 0 };
                    existing.totalQty += qty;
                    existing.count += 1;
                    priceMap.set(price, existing);
                }

                // Convert Map to Array
                return Array.from(priceMap.entries()).map(([price, val]) => ({
                    price: Number(price),
                    totalQty: Number(val.totalQty), // Pastikan field ini 'totalQty'
                    count: Number(val.count)
                }));
            };

            // 3. Proses Data
            const bids = aggregateByPrice(parseOrders(buyOrders));
            const asks = aggregateByPrice(parseOrders(sellOrders));

            // 4. Sorting
            bids.sort((a, b) => b.price - a.price); // Bids: Highest to Lowest
            asks.sort((a, b) => a.price - b.price); // Asks: Lowest to Highest

            // 5. Validasi Akhir & Slice (PENTING: Cek field 'totalQty')
            const validBids = bids
                .filter(b => b.price > 0 && b.totalQty > 0) // Cek totalQty, BUKAN volume
                .slice(0, 20);

            const validAsks = asks
                .filter(a => a.price > 0 && a.totalQty > 0) // Cek totalQty, BUKAN volume
                .slice(0, 20);

            // 6. Broadcast
            this.io.to(symbol).emit('orderbook_update', {
                symbol,
                bids: validBids,
                asks: validAsks,
                timestamp: Date.now()
            });

            if (this.DEBUG) console.log(`📡 [${symbol}] Broadcast: ${validBids.length} bids, ${validAsks.length} asks`);

        } catch (err: any) {
            console.error('Broadcast error:', err.message);
        }
    }

    /**
     * Emit trade notifications
     */
    private static emitTradeNotifications(
        symbol: string,
        price: number,
        qty: number,
        buyOrder: OrderData,
        sellOrder: OrderData,
        buyRem: number,
        sellRem: number,
        isBuyBot: boolean,
        isSellBot: boolean
    ) {
        if (!this.io) return;

        setImmediate(async () => {
            try {
                // Get price data for change calculation
                const priceData = await pool.query(`
                    SELECT volume, prev_close
                    FROM daily_stock_data d
                             JOIN stocks s ON d.stock_id = s.id
                    WHERE s.symbol = $1
                      AND session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' LIMIT 1)
                `, [symbol]);

                const vol = priceData.rows[0]?.volume || 0;
                const prev = priceData.rows[0]?.prev_close || price;
                const chg = price - prev;
                const pct = prev > 0 ? (chg / prev) * 100 : 0;

                this.io.to(symbol).emit('price_update', {
                    symbol,
                    lastPrice: price,
                    change: chg,
                    changePercent: pct,
                    volume: vol,
                    timestamp: Date.now()
                });

                // Trade event for charts
                this.io.to(symbol).emit('trade', {
                    symbol,
                    price,
                    quantity: qty,
                    timestamp: Date.now()
                });

                // Personal notifications
                if (!isBuyBot) {
                    const status = buyRem > 0 ? 'PARTIAL' : 'MATCHED';
                    this.io.to(`user:${buyOrder.userId}`).emit('order_matched', {
                        type: 'BUY', symbol, price, quantity: qty,
                        message: `Beli ${symbol}: ${qty} lot @ Rp${price.toLocaleString()} (${status})`
                    });
                    this.io.to(`user:${buyOrder.userId}`).emit('order_status', {
                        order_id: buyOrder.orderId, status, price,
                        matched_quantity: qty, remaining_quantity: buyRem,
                        symbol, type: 'BUY', timestamp: Date.now()
                    });
                }

                if (!isSellBot) {
                    const status = sellRem > 0 ? 'PARTIAL' : 'MATCHED';
                    this.io.to(`user:${sellOrder.userId}`).emit('order_matched', {
                        type: 'SELL', symbol, price, quantity: qty,
                        message: `Jual ${symbol}: ${qty} lot @ Rp${price.toLocaleString()} (${status})`
                    });
                    this.io.to(`user:${sellOrder.userId}`).emit('order_status', {
                        order_id: sellOrder.orderId, status, price,
                        matched_quantity: qty, remaining_quantity: sellRem,
                        symbol, type: 'SELL', timestamp: Date.now()
                    });
                }
            } catch (err: any) {
                console.error('Notification emit error:', err.message);
            }
        });
    }

    /**
     * Force broadcast orderbook (for cancel order or admin)
     */
    static async forceBroadcast(symbol: string) {
        if (this.io) {
            await this.sendOrderbookUpdate(symbol);
        }
    }

    /**
     * Get stats for monitoring
     */
    static getStats() {
        return {
            ...this.stats,
            activeSymbols: Array.from(this.processingQueue.entries())
                .filter(([_, state]) => state.isProcessing)
                .map(([symbol]) => symbol),
            circuitBreakers: Object.fromEntries(
                Array.from(this.circuitBreakers.entries())
                    .filter(([_, cb]) => cb.state !== 'CLOSED')
                    .map(([symbol, cb]) => [symbol, cb.state])
            )
        };
    }

    /**
     * Reset circuit breaker manually (for admin)
     */
    static resetCircuitBreaker(symbol?: string) {
        if (symbol) {
            this.circuitBreakers.delete(symbol);
            console.log(`✅ Circuit breaker reset for ${symbol}`);
        } else {
            this.circuitBreakers.clear();
            console.log('✅ All circuit breakers reset');
        }
    }

    /**
     * Health check
     */
    static async healthCheck(): Promise<{ healthy: boolean; details: any }> {
        const details: any = {
            stats: this.getStats(),
            redisConnected: false,
            dbPoolStats: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount
            }
        };

        try {
            await redis.ping();
            details.redisConnected = true;
        } catch (err) {
            details.redisConnected = false;
        }

        const healthy = details.redisConnected &&
            pool.waitingCount < pool.totalCount * 0.8;

        return { healthy, details };
    }

}
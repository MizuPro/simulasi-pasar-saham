"use strict";
// core/matching-engine.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatchingEngine = void 0;
const database_1 = __importDefault(require("../config/database"));
const redis_1 = __importDefault(require("../config/redis"));
class MatchingEngine {
    static initialize(ioInstance) {
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
                `LockTimeouts=${this.stats.lockTimeouts}`);
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
    /**
     * Get or create circuit breaker for symbol
     */
    static getCircuitBreaker(symbol) {
        if (!this.circuitBreakers.has(symbol)) {
            this.circuitBreakers.set(symbol, {
                state: 'CLOSED',
                failures: 0,
                lastFailure: 0,
                successesInHalfOpen: 0
            });
        }
        return this.circuitBreakers.get(symbol);
    }
    /**
     * Check if circuit allows request
     */
    static canProcess(symbol) {
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
    static recordSuccess(symbol) {
        const cb = this.getCircuitBreaker(symbol);
        if (cb.state === 'HALF_OPEN') {
            cb.successesInHalfOpen++;
            if (cb.successesInHalfOpen >= this.CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD) {
                cb.state = 'CLOSED';
                cb.failures = 0;
                console.log(`✅ Circuit breaker CLOSED for ${symbol}`);
            }
        }
        else if (cb.state === 'CLOSED') {
            cb.failures = Math.max(0, cb.failures - 1);
        }
    }
    /**
     * Record failure for circuit breaker
     */
    static recordFailure(symbol) {
        const cb = this.getCircuitBreaker(symbol);
        cb.failures++;
        cb.lastFailure = Date.now();
        if (cb.state === 'HALF_OPEN') {
            cb.state = 'OPEN';
            this.stats.circuitBroken++;
            console.log(`🔴 Circuit breaker OPEN for ${symbol} (half-open failure)`);
        }
        else if (cb.failures >= this.CIRCUIT_FAILURE_THRESHOLD) {
            cb.state = 'OPEN';
            this.stats.circuitBroken++;
            console.log(`🔴 Circuit breaker OPEN for ${symbol} (${cb.failures} failures)`);
        }
    }
    /**
     * Main entry point - triggers matching untuk symbol tertentu
     */
    static async match(symbol) {
        if (this.DEBUG)
            console.log(`🎯 [${symbol}] Match request received`);
        // Check circuit breaker
        if (!this.canProcess(symbol)) {
            console.log(`⚡ Circuit breaker preventing match for ${symbol}`);
            return;
        }
        // Initialize queue state
        if (!this.processingQueue.has(symbol)) {
            this.processingQueue.set(symbol, { isProcessing: false, pending: 0 });
        }
        const queueState = this.processingQueue.get(symbol);
        // If already processing, increment pending counter
        if (queueState.isProcessing) {
            queueState.pending++;
            if (this.DEBUG)
                console.log(`⏳ [${symbol}] Already processing, pending count: ${queueState.pending}`);
            return;
        }
        queueState.isProcessing = true;
        if (this.DEBUG)
            console.log(`▶️ [${symbol}] Starting matching process...`);
        // Safety timeout
        const timeout = setTimeout(() => {
            console.error(`⚠️ Matching timeout for ${symbol} - forcing release`);
            this.stats.lockTimeouts++;
            queueState.isProcessing = false;
            queueState.pending = 0;
        }, this.LOCK_TIMEOUT_MS);
        try {
            await this.processMatching(symbol);
            this.recordSuccess(symbol);
        }
        catch (error) {
            this.stats.errors++;
            this.recordFailure(symbol);
            console.error(`❌ Matching error on ${symbol}:`, error.message || error);
        }
        finally {
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
     * Core matching logic
     */
    static async processMatching(symbol) {
        if (this.DEBUG)
            console.log(`🔄 [${symbol}] Processing matching cycle...`);
        let matchOccurred = true;
        let iterations = 0;
        while (matchOccurred && iterations < this.MAX_ITERATIONS_PER_CYCLE) {
            matchOccurred = false;
            iterations++;
            // Fetch orderbook dari Redis
            const [buyQueueRaw, sellQueueRaw] = await Promise.all([
                redis_1.default.zrevrange(`orderbook:${symbol}:buy`, 0, 19, 'WITHSCORES'),
                redis_1.default.zrange(`orderbook:${symbol}:sell`, 0, 19, 'WITHSCORES')
            ]);
            if (this.DEBUG)
                console.log(`📊 [${symbol}] Iteration ${iterations}: ${buyQueueRaw.length / 2} buy orders, ${sellQueueRaw.length / 2} sell orders`);
            if (buyQueueRaw.length === 0 || sellQueueRaw.length === 0) {
                if (this.DEBUG)
                    console.log(`⚠️ [${symbol}] No orders to match (buy: ${buyQueueRaw.length / 2}, sell: ${sellQueueRaw.length / 2})`);
                break;
            }
            // Parse orders
            const buys = this.parseOrderQueue(buyQueueRaw, symbol, 'buy');
            const sells = this.parseOrderQueue(sellQueueRaw, symbol, 'sell');
            if (buys.length === 0 || sells.length === 0)
                break;
            // Sort by price-time priority
            buys.sort((a, b) => b.price !== a.price ? b.price - a.price : a.data.timestamp - b.data.timestamp);
            sells.sort((a, b) => a.price !== b.price ? a.price - b.price : a.data.timestamp - b.data.timestamp);
            const topBuy = buys[0];
            const topSell = sells[0];
            if (this.DEBUG)
                console.log(`🔍 [${symbol}] Matching Check: BUY ${topBuy.price} (${topBuy.data.remaining_quantity} lots) vs SELL ${topSell.price} (${topSell.data.remaining_quantity} lots)`);
            // Check if prices cross
            if (topBuy.price >= topSell.price) {
                matchOccurred = true;
                // Determine execution price (price-time priority)
                const executionPrice = topBuy.data.timestamp < topSell.data.timestamp
                    ? topBuy.price
                    : topSell.price;
                console.log(`✨ [${symbol}] MATCH FOUND! Executing @ ${executionPrice}`);
                // Execute trade
                await this.executeTrade(topBuy.data, topSell.data, executionPrice, symbol, topBuy.price, topSell.price, topBuy.raw, topSell.raw);
                this.stats.tradesExecuted++;
            }
            else {
                if (this.DEBUG)
                    console.log(`❌ [${symbol}] No match: BUY ${topBuy.price} < SELL ${topSell.price}`);
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
    static parseOrderQueue(raw, symbol, side) {
        var _a;
        const parsed = [];
        for (let i = 0; i < raw.length; i += 2) {
            try {
                const scoreData = raw[i + 1];
                if (scoreData === undefined)
                    continue;
                const data = JSON.parse(raw[i]);
                const price = parseFloat(scoreData);
                if (isNaN(price)) {
                    console.warn('⚠️ Invalid price in Redis:', scoreData);
                    redis_1.default.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => { });
                    continue;
                }
                // Basic validation
                if (!data.orderId || !data.userId) {
                    redis_1.default.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => { });
                    continue;
                }
                // Ensure remaining_quantity exists and is valid
                const qty = (_a = data.remaining_quantity) !== null && _a !== void 0 ? _a : data.quantity;
                if (typeof qty !== 'number' || qty <= 0) {
                    redis_1.default.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => { });
                    continue;
                }
                parsed.push({
                    data: { ...data, remaining_quantity: qty },
                    price: price,
                    raw: raw[i]
                });
            }
            catch (e) {
                redis_1.default.zrem(`orderbook:${symbol}:${side}`, raw[i]).catch(() => { });
            }
        }
        return parsed;
    }
    /**
     * Cleanup stale/invalid orders from Redis
     */
    static async cleanupStaleOrders() {
        try {
            let cursor = '0';
            do {
                const [newCursor, keys] = await redis_1.default.scan(cursor, 'MATCH', 'orderbook:*', 'COUNT', 50);
                cursor = newCursor;
                for (const key of keys) {
                    if (!key.endsWith(':buy') && !key.endsWith(':sell'))
                        continue;
                    const orders = await redis_1.default.zrange(key, 0, -1);
                    const invalidOrders = [];
                    for (const orderStr of orders) {
                        try {
                            const order = JSON.parse(orderStr);
                            if (!order.orderId || !order.userId ||
                                !order.remaining_quantity || order.remaining_quantity <= 0) {
                                invalidOrders.push(orderStr);
                            }
                        }
                        catch (e) {
                            invalidOrders.push(orderStr);
                        }
                    }
                    if (invalidOrders.length > 0) {
                        await redis_1.default.zrem(key, ...invalidOrders);
                        console.warn(`🧹 Cleaned ${invalidOrders.length} invalid orders from ${key}`);
                    }
                }
            } while (cursor !== '0');
        }
        catch (err) {
            // Ignore cleanup errors
        }
    }
    /**
     * Execute single trade
     */
    static async executeTrade(buyOrder, sellOrder, matchPrice, symbol, originalBuyPrice, originalSellPrice, buyRaw, sellRaw) {
        var _a, _b;
        const client = await database_1.default.connect();
        try {
            await client.query('SET LOCAL statement_timeout = 10000');
            await client.query('BEGIN');
            const isBuyBot = buyOrder.userId === 'SYSTEM_BOT' || ((_a = buyOrder.orderId) === null || _a === void 0 ? void 0 : _a.toString().startsWith('BOT-'));
            const isSellBot = sellOrder.userId === 'SYSTEM_BOT' || ((_b = sellOrder.orderId) === null || _b === void 0 ? void 0 : _b.toString().startsWith('BOT-'));
            // Verify real orders exist in database
            if (!isBuyBot || !isSellBot) {
                const orderIds = [];
                if (!isBuyBot)
                    orderIds.push(buyOrder.orderId);
                if (!isSellBot)
                    orderIds.push(sellOrder.orderId);
                if (orderIds.length > 0) {
                    const orderCheck = await client.query(`SELECT id FROM orders WHERE id = ANY($1) AND status IN ('PENDING', 'PARTIAL')`, [orderIds]);
                    if (orderCheck.rowCount !== orderIds.length) {
                        console.warn(`⚠️ Order validation failed for ${symbol}`);
                        // Remove invalid orders from Redis
                        if (!isBuyBot && !orderCheck.rows.find((r) => r.id === buyOrder.orderId)) {
                            await redis_1.default.zrem(`orderbook:${symbol}:buy`, buyRaw);
                        }
                        if (!isSellBot && !orderCheck.rows.find((r) => r.id === sellOrder.orderId)) {
                            await redis_1.default.zrem(`orderbook:${symbol}:sell`, sellRaw);
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
            await client.query(`INSERT INTO trades (buy_order_id, sell_order_id, stock_id, price, quantity)
                 VALUES ($1, $2, $3, $4, $5)`, [
                isBuyBot ? null : buyOrder.orderId,
                isSellBot ? null : sellOrder.orderId,
                buyOrder.stockId, // Use stockId from order data
                matchPrice,
                matchQty
            ]);
            // 2. Update orders in database
            if (!isBuyBot) {
                const buyStatus = buyRemaining > 0 ? 'PARTIAL' : 'MATCHED';
                await client.query(`UPDATE orders SET status = $1, remaining_quantity = $2, updated_at = NOW() WHERE id = $3`, [buyStatus, buyRemaining, buyOrder.orderId]);
            }
            if (!isSellBot) {
                const sellStatus = sellRemaining > 0 ? 'PARTIAL' : 'MATCHED';
                await client.query(`UPDATE orders SET status = $1, remaining_quantity = $2, updated_at = NOW() WHERE id = $3`, [sellStatus, sellRemaining, sellOrder.orderId]);
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
            const multi = redis_1.default.multi();
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
            this.emitTradeNotifications(symbol, matchPrice, matchQty, buyOrder, sellOrder, buyRemaining, sellRemaining, isBuyBot, isSellBot);
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            console.error('❌ Trade execution failed:', err.message);
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Throttled broadcast
     */
    static async throttledBroadcast(symbol) {
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
    static async sendOrderbookUpdate(symbol) {
        try {
            const [buyOrders, sellOrders] = await Promise.all([
                redis_1.default.zrevrange(`orderbook:${symbol}:buy`, 0, 49, 'WITHSCORES'), // Ambil agak banyakan dikit buat safety
                redis_1.default.zrange(`orderbook:${symbol}:sell`, 0, 49, 'WITHSCORES')
            ]);
            // 1. Helper Parse dari Redis Raw String ke Object
            const parseOrders = (raw) => {
                const result = [];
                for (let i = 0; i < raw.length; i += 2) {
                    try {
                        const scoreData = raw[i + 1];
                        if (!raw[i] || scoreData === undefined)
                            continue;
                        const data = JSON.parse(raw[i]);
                        const price = parseFloat(scoreData);
                        if (isNaN(price))
                            continue;
                        // Pastikan qty valid
                        const qty = data.remaining_quantity || data.quantity;
                        if (!qty || qty <= 0)
                            continue;
                        result.push({ price, quantity: qty });
                    }
                    catch (e) {
                        // Ignore parse error
                    }
                }
                return result;
            };
            // 2. Helper Aggregate (Grouping by Price)
            const aggregateByPrice = (orders) => {
                const priceMap = new Map();
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
            if (this.DEBUG)
                console.log(`📡 [${symbol}] Broadcast: ${validBids.length} bids, ${validAsks.length} asks`);
        }
        catch (err) {
            console.error('Broadcast error:', err.message);
        }
    }
    /**
     * Emit trade notifications
     */
    static emitTradeNotifications(symbol, price, qty, buyOrder, sellOrder, buyRem, sellRem, isBuyBot, isSellBot) {
        if (!this.io)
            return;
        setImmediate(async () => {
            var _a, _b;
            try {
                // Get price data for change calculation
                const priceData = await database_1.default.query(`
                    SELECT volume, prev_close
                    FROM daily_stock_data d
                             JOIN stocks s ON d.stock_id = s.id
                    WHERE s.symbol = $1
                      AND session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' LIMIT 1)
                `, [symbol]);
                const vol = ((_a = priceData.rows[0]) === null || _a === void 0 ? void 0 : _a.volume) || 0;
                const prev = ((_b = priceData.rows[0]) === null || _b === void 0 ? void 0 : _b.prev_close) || price;
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
            }
            catch (err) {
                console.error('Notification emit error:', err.message);
            }
        });
    }
    /**
     * Force broadcast orderbook (for cancel order or admin)
     */
    static async forceBroadcast(symbol) {
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
            circuitBreakers: Object.fromEntries(Array.from(this.circuitBreakers.entries())
                .filter(([_, cb]) => cb.state !== 'CLOSED')
                .map(([symbol, cb]) => [symbol, cb.state]))
        };
    }
    /**
     * Reset circuit breaker manually (for admin)
     */
    static resetCircuitBreaker(symbol) {
        if (symbol) {
            this.circuitBreakers.delete(symbol);
            console.log(`✅ Circuit breaker reset for ${symbol}`);
        }
        else {
            this.circuitBreakers.clear();
            console.log('✅ All circuit breakers reset');
        }
    }
    /**
     * Health check
     */
    static async healthCheck() {
        const details = {
            stats: this.getStats(),
            redisConnected: false,
            dbPoolStats: {
                total: database_1.default.totalCount,
                idle: database_1.default.idleCount,
                waiting: database_1.default.waitingCount
            }
        };
        try {
            await redis_1.default.ping();
            details.redisConnected = true;
        }
        catch (err) {
            details.redisConnected = false;
        }
        const healthy = details.redisConnected &&
            database_1.default.waitingCount < database_1.default.totalCount * 0.8;
        return { healthy, details };
    }
}
exports.MatchingEngine = MatchingEngine;
// Lock sederhana untuk mencegah race condition pada saham yang sama
MatchingEngine.processingQueue = new Map();
// THROTTLING STATE untuk broadcast
MatchingEngine.broadcastTimers = new Map();
MatchingEngine.pendingBroadcasts = new Set();
// Circuit Breaker per symbol
MatchingEngine.circuitBreakers = new Map();
MatchingEngine.CIRCUIT_FAILURE_THRESHOLD = 5;
MatchingEngine.CIRCUIT_RESET_TIMEOUT = 30000; // 30 seconds
MatchingEngine.CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD = 3;
// Stats untuk monitoring
MatchingEngine.stats = {
    matchesProcessed: 0,
    tradesExecuted: 0,
    errors: 0,
    circuitBroken: 0,
    lockTimeouts: 0,
    retries: 0,
    lastReset: Date.now()
};
// Configurable limits
MatchingEngine.MAX_ITERATIONS_PER_CYCLE = 100;
MatchingEngine.LOCK_TIMEOUT_MS = 30000;
MatchingEngine.BROADCAST_THROTTLE_MS = 500; // 500ms throttle for better responsiveness
MatchingEngine.DEBUG = false; // Set to true for detailed matching logs

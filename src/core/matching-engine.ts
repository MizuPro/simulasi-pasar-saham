// core/matching-engine.ts

import { Server } from 'socket.io';
import pool from '../config/database';
import redis from '../config/redis';

export class MatchingEngine {
    private static io: Server;

    // Lock sederhana untuk mencegah race condition pada saham yang sama
    private static processingQueue = new Set<string>();

    // THROTTLING STATE: Ini "Rem Tangan" buat nyelamatin router lu
    // Menyimpan timer aktif untuk setiap saham
    private static broadcastTimers = new Map<string, NodeJS.Timeout>();
    // Menyimpan status apakah ada update susulan yang tertunda
    private static pendingBroadcasts = new Set<string>();

    static initialize(ioInstance: Server) {
        this.io = ioInstance;
    }

    static async match(symbol: string) {
        // 1. CEK LOCK: Kalau saham ini lagi diproses, skip dulu biar gak tabrakan
        if (this.processingQueue.has(symbol)) {
            // console.log(`⏭️ Skipping ${symbol} - already processing`); // Optional log
            return;
        }
        this.processingQueue.add(symbol);

        // CRITICAL: Set timeout to prevent infinite processing
        const timeout = setTimeout(() => {
            console.error(`⚠️ Matching timeout for ${symbol} - forcing release`);
            this.processingQueue.delete(symbol);
        }, 30000); // 30 seconds max

        try {
            let matchOccurred = true;
            let iterations = 0;
            const MAX_ITERATIONS = 100; // Prevent infinite loops

            // Loop terus selama masih ada transaksi yang terjadi (Market Sweep)
            while (matchOccurred && iterations < MAX_ITERATIONS) {
                matchOccurred = false;
                iterations++;

                // 2. FETCH BATCH: Ambil 10 order teratas untuk disortir manual
                const buyQueueRaw = await redis.zrevrange(`orderbook:${symbol}:buy`, 0, 10, 'WITHSCORES');
                const sellQueueRaw = await redis.zrange(`orderbook:${symbol}:sell`, 0, 10, 'WITHSCORES');

                if (buyQueueRaw.length === 0 || sellQueueRaw.length === 0) break;

                // Helper untuk parsing array Redis [string, score, string, score...]
                const parseQueue = (raw: string[]) => {
                    const parsed = [];
                    for (let i = 0; i < raw.length; i += 2) {
                        try {
                            parsed.push({
                                data: JSON.parse(raw[i]),
                                price: parseFloat(raw[i+1])
                            });
                        } catch (parseErr) {
                            console.error(`Error parsing order data:`, parseErr);
                            continue;
                        }
                    }
                    return parsed;
                };

                let buys = parseQueue(buyQueueRaw);
                let sells = parseQueue(sellQueueRaw);

                if (buys.length === 0 || sells.length === 0) break;

                // 3. SORTING TIME PRIORITY (FIFO)
                // Urutkan BUY: Harga Tertinggi -> Waktu Terlama (Timestamp Kecil)
                buys.sort((a, b) => {
                    if (b.price !== a.price) return b.price - a.price;
                    return a.data.timestamp - b.data.timestamp;
                });

                // Urutkan SELL: Harga Terendah -> Waktu Terlama (Timestamp Kecil)
                sells.sort((a, b) => {
                    if (a.price !== b.price) return a.price - b.price;
                    return a.data.timestamp - b.data.timestamp;
                });

                const topBuy = buys[0];
                const topSell = sells[0];

                // 4. CEK JODOH (Harga Beli >= Harga Jual)
                if (topBuy.price >= topSell.price) {
                    matchOccurred = true;

                    // Harga Transaksi mengikuti antrean yang diam (Passive Order / Maker)
                    // Aturan Bursa: Harga deal adalah harga dari order yang sudah mengantre lebih dulu.
                    const executionPrice = topBuy.data.timestamp < topSell.data.timestamp
                        ? topBuy.price
                        : topSell.price;

                    await this.executeTrade(topBuy.data, topSell.data, executionPrice, symbol, topBuy.price, topSell.price);
                }
            }

            if (iterations >= MAX_ITERATIONS) {
                console.warn(`⚠️ Max iterations reached for ${symbol}`);
            }

            // Broadcast orderbook update setelah matching selesai (DENGAN THROTTLING)
            if (this.io) {
                await this.broadcastOrderbook(symbol);
            }
        } catch (error) {
            console.error(`Matching error on ${symbol}:`, error);
        } finally {
            // CRITICAL: Always clear timeout and release lock
            clearTimeout(timeout);
            this.processingQueue.delete(symbol);
        }
    }

    // ============================================================================
    // 🛡️ THROTTLED BROADCAST: Jantung pertahanan Router lu
    // ============================================================================
    private static async broadcastOrderbook(symbol: string) {
        // 1. Cek apakah saham ini lagi masa "Cooldown"?
        if (this.broadcastTimers.has(symbol)) {
            // Kalau iya, tandain bahwa ada update baru yang tertunda
            this.pendingBroadcasts.add(symbol);
            return; // STOP DISINI, jangan kirim apa-apa dulu
        }

        // 2. Kalau gak lagi cooldown, kirim update SEKARANG
        await this.sendOrderbookUpdate(symbol);

        // 3. Pasang Timer Cooldown selama 1000ms (1 Detik)
        // Selama 1 detik ke depan, semua update orderbook akan di-hold
        const timer = setTimeout(async () => {
            // Hapus timer karena cooldown selesai
            this.broadcastTimers.delete(symbol);

            // Cek apakah selama cooldown tadi ada update yang masuk?
            if (this.pendingBroadcasts.has(symbol)) {
                // Hapus tanda pending
                this.pendingBroadcasts.delete(symbol);

                // Kirim update TERAKHIR yang paling fresh
                // (Rekursif biar kena throttle lagi untuk cycle berikutnya)
                await this.broadcastOrderbook(symbol);
            }
        }, 1000); // <-- UBAH KE 500 kalau mau lebih cepet dikit, tapi 1000 paling aman

        this.broadcastTimers.set(symbol, timer);
    }

    // Fungsi asli pengirim data ke Socket (Private, dipanggil oleh throttler)
    private static async sendOrderbookUpdate(symbol: string) {
        try {
            // Ambil top 10 bids & asks
            const buyOrders = await redis.zrevrange(`orderbook:${symbol}:buy`, 0, 9, 'WITHSCORES');
            const sellOrders = await redis.zrange(`orderbook:${symbol}:sell`, 0, 9, 'WITHSCORES');

            const parseOrders = (raw: string[]) => {
                const result = [];
                for (let i = 0; i < raw.length; i += 2) {
                    const data = JSON.parse(raw[i]);
                    result.push({
                        price: parseFloat(raw[i + 1]),
                        quantity: data.remaining_quantity || data.quantity
                    });
                }
                return result;
            };

            // Aggregate by price level
            const aggregateByPrice = (orders: any[]) => {
                const priceMap = new Map();
                for (const order of orders) {
                    const existing = priceMap.get(order.price) || { price: order.price, totalQty: 0, count: 0 };
                    existing.totalQty += order.quantity;
                    existing.count++;
                    priceMap.set(order.price, existing);
                }
                return Array.from(priceMap.values());
            };

            // Emit ke client
            this.io.to(symbol).emit('orderbook_update', {
                symbol,
                bids: aggregateByPrice(parseOrders(buyOrders)),
                asks: aggregateByPrice(parseOrders(sellOrders))
            });

            // console.log(`📡 Broadcast update for ${symbol}`);
        } catch (err) {
            console.error('Broadcast orderbook error:', err);
        }
    }

    private static async executeTrade(buyOrder: any, sellOrder: any, matchPrice: number, symbol: string, originalBuyPrice: number, originalSellPrice: number) {
        const client = await pool.connect();

        // CRITICAL: Set statement timeout for this transaction
        await client.query('SET LOCAL statement_timeout = 10000'); // 10 seconds

        try {
            await client.query('BEGIN');

            // DEFENSIVE CHECK: Verify orders exist before proceeding
            const orderCheck = await client.query(
                'SELECT id FROM orders WHERE id IN ($1, $2) AND status IN (\'PENDING\', \'PARTIAL\')',
                [buyOrder.orderId, sellOrder.orderId]
            );

            if (orderCheck.rowCount !== 2) {
                console.warn(`⚠️ Order validation failed. Buy: ${buyOrder.orderId}, Sell: ${sellOrder.orderId}`);

                // Remove invalid orders from Redis
                await redis.zrem(`orderbook:${symbol}:buy`, JSON.stringify(buyOrder));
                await redis.zrem(`orderbook:${symbol}:sell`, JSON.stringify(sellOrder));

                await client.query('ROLLBACK');
                return; // Skip this trade
            }

            // 1. Tentukan Quantity Match (Minimun dari keduanya)
            const buyQtyAvailable = buyOrder.remaining_quantity || buyOrder.quantity;
            const sellQtyAvailable = sellOrder.remaining_quantity || sellOrder.quantity;

            const matchQty = Math.min(buyQtyAvailable, sellQtyAvailable);

            // 2. Hitung Sisa (Partial Logic)
            const buyRemaining = buyQtyAvailable - matchQty;
            const sellRemaining = sellQtyAvailable - matchQty;

            // 3. Catat Transaksi (Trade Log)
            await client.query(`
                /* dialect: postgres */
                INSERT INTO trades (buy_order_id, sell_order_id, price, quantity) VALUES ($1, $2, $3, $4)
            `, [buyOrder.orderId, sellOrder.orderId, matchPrice, matchQty]);

            // 4. Update Order Pembeli (BUY) di Database & Redis
            await redis.zrem(`orderbook:${symbol}:buy`, JSON.stringify(buyOrder));

            if (buyRemaining > 0) {
                await client.query(
                    "UPDATE orders SET status = 'PARTIAL', remaining_quantity = $1 WHERE id = $2",
                    [buyRemaining, buyOrder.orderId]
                );
                buyOrder.remaining_quantity = buyRemaining;
                await redis.zadd(`orderbook:${symbol}:buy`, originalBuyPrice, JSON.stringify(buyOrder));
            } else {
                await client.query(
                    "UPDATE orders SET status = 'MATCHED', remaining_quantity = 0 WHERE id = $1",
                    [buyOrder.orderId]
                );
            }

            // 5. Update Order Penjual (SELL) di Database & Redis
            await redis.zrem(`orderbook:${symbol}:sell`, JSON.stringify(sellOrder));

            if (sellRemaining > 0) {
                await client.query(
                    "UPDATE orders SET status = 'PARTIAL', remaining_quantity = $1 WHERE id = $2",
                    [sellRemaining, sellOrder.orderId]
                );
                sellOrder.remaining_quantity = sellRemaining;
                await redis.zadd(`orderbook:${symbol}:sell`, originalSellPrice, JSON.stringify(sellOrder));
            } else {
                await client.query(
                    "UPDATE orders SET status = 'MATCHED', remaining_quantity = 0 WHERE id = $1",
                    [sellOrder.orderId]
                );
            }

            // 6. Update Portfolio Pembeli (Tambah saham yang dibeli)
            await client.query(`
                /* dialect: postgres */
                INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
                VALUES ($1, (SELECT id FROM stocks WHERE symbol = $3), $2, $4)
                ON CONFLICT (user_id, stock_id) DO UPDATE SET 
                avg_buy_price = ((portfolios.avg_buy_price * portfolios.quantity_owned) + ($4 * $2)) / (portfolios.quantity_owned + $2),
                quantity_owned = portfolios.quantity_owned + $2
            `, [buyOrder.userId, matchQty, symbol, matchPrice]);

            // 7. Update Saldo Penjual (Tambah hasil jual)
            const totalGain = matchPrice * (matchQty * 100);
            await client.query(
                'UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2',
                [totalGain, sellOrder.userId]
            );

            // 8. Refund jika harga eksekusi lebih rendah dari harga bid
            if (matchPrice < originalBuyPrice) {
                const priceDiff = originalBuyPrice - matchPrice;
                const refundAmount = priceDiff * (matchQty * 100);

                await client.query(
                    'UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2',
                    [refundAmount, buyOrder.userId]
                );

                console.log(`💸 Refund Rp ${refundAmount} ke User ${buyOrder.userId} (Hemat Beli)`);
            }

            // 9. Update Daily Stock Data (Open, High, Low, Close, Volume)
            await client.query(`
                /* dialect: postgres */
                UPDATE daily_stock_data SET
                    open_price = COALESCE(open_price, $1),
                    high_price = GREATEST(COALESCE(high_price, $1), $1),
                    low_price = LEAST(COALESCE(low_price, $1), $1),
                    close_price = $1,
                    volume = COALESCE(volume, 0) + $2
                WHERE stock_id = (SELECT id FROM stocks WHERE symbol = $3)
                AND session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
            `, [matchPrice, matchQty, symbol]);

            await client.query('COMMIT');

            console.log(`✅ MATCH! ${symbol}: ${matchQty} lots @ ${matchPrice}`);

            // 10. WebSocket Notifications
            if (this.io) {
                // Get prevClose for calculating change
                const prevCloseRes = await pool.query(`
                    /* dialect: postgres */
                    SELECT d.prev_close, d.volume
                    FROM daily_stock_data d
                    JOIN stocks s ON d.stock_id = s.id
                    WHERE s.symbol = $1
                    AND d.session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
                `, [symbol]);

                const prevClose = prevCloseRes.rows[0]?.prev_close || matchPrice;
                const totalVolume = (prevCloseRes.rows[0]?.volume || 0);
                const change = matchPrice - prevClose;
                const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

                // Broadcast harga terakhir
                // NOTE: Price update jarang bikin flooding parah dibanding orderbook,
                // tapi kalau mau super aman, bisa dikasih throttling juga nanti.
                this.io.to(symbol).emit('price_update', {
                    symbol: symbol,
                    lastPrice: matchPrice,
                    change: change,
                    changePercent: changePercent,
                    volume: totalVolume,
                    timestamp: Date.now()
                });

                // Notifikasi Personal Pembeli (Realtime penting, jangan di-throttle)
                const buyMsg = buyRemaining > 0 ? `Partial Match ${matchQty} Lot` : `Full Match ${matchQty} Lot`;
                const buyStatus = buyRemaining > 0 ? 'PARTIAL' : 'MATCHED';

                this.io.to(`user:${buyOrder.userId}`).emit('order_matched', {
                    type: 'BUY', symbol, price: matchPrice, quantity: matchQty, message: `Beli ${symbol}: ${buyMsg}`
                });

                this.io.to(`user:${buyOrder.userId}`).emit('order_status', {
                    order_id: buyOrder.orderId,
                    status: buyStatus,
                    price: matchPrice,
                    matched_quantity: matchQty,
                    remaining_quantity: buyRemaining,
                    symbol: symbol,
                    type: 'BUY',
                    timestamp: Date.now()
                });

                // Notifikasi Personal Penjual (Realtime penting, jangan di-throttle)
                const sellMsg = sellRemaining > 0 ? `Partial Match ${matchQty} Lot` : `Full Match ${matchQty} Lot`;
                const sellStatus = sellRemaining > 0 ? 'PARTIAL' : 'MATCHED';

                this.io.to(`user:${sellOrder.userId}`).emit('order_matched', {
                    type: 'SELL', symbol, price: matchPrice, quantity: matchQty, message: `Jual ${symbol}: ${sellMsg}`
                });

                this.io.to(`user:${sellOrder.userId}`).emit('order_status', {
                    order_id: sellOrder.orderId,
                    status: sellStatus,
                    price: matchPrice,
                    matched_quantity: matchQty,
                    remaining_quantity: sellRemaining,
                    symbol: symbol,
                    type: 'SELL',
                    timestamp: Date.now()
                });
            }

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Execute Trade Error:', err);
        } finally {
            client.release();
        }
    }
}
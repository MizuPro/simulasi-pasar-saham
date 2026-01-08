//routes/admin.ts

import { Router, Request, Response } from 'express';
import pool from '../config/database';
import redis from '../config/redis';
import { calculateLimits, getTickSize } from '../core/market-logic';
import { adminAuth, AuthRequest } from '../middlewares/auth';
import { AuthService } from '../services/auth-service';

const router = Router();

// POST /api/admin/init-session - Hitung ARA/ARB berdasarkan harga prev close (ADMIN ONLY)
router.post('/init-session', adminAuth, async (req: AuthRequest, res: Response) => {
    const { symbol, prevClose } = req.body;

    try {
        const { araLimit, arbLimit } = calculateLimits(prevClose);

        res.json({
            symbol,
            prevClose,
            araLimit,
            arbLimit,
            tickSize: getTickSize(prevClose)
        });
    } catch (err) {
        res.status(500).send('Error calculating limits');
    }
});

// POST /api/admin/session/open - Buka sesi trading baru (ADMIN ONLY)
router.post('/session/open', adminAuth, async (req: AuthRequest, res: Response) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Cek apakah sudah ada sesi yang OPEN
        const existingSession = await client.query(`
            /* dialect: postgres */
            SELECT id FROM trading_sessions WHERE status = 'OPEN'
        `);

        if ((existingSession.rowCount ?? 0) > 0) {
            throw new Error('Sudah ada sesi trading yang sedang berjalan');
        }

        // 2. Buat sesi baru dengan session_number otomatis
        const sessionRes = await client.query(`
            /* dialect: postgres */
            INSERT INTO trading_sessions (session_number, status, started_at)
            VALUES (
                COALESCE((SELECT MAX(session_number) FROM trading_sessions), 0) + 1,
                'OPEN',
                NOW()
            )
            RETURNING id, session_number, status, started_at
        `);

        const session = sessionRes.rows[0];

        // 3. Siapkan data harian untuk setiap saham aktif
        const stocks = await client.query(`
            /* dialect: postgres */
            SELECT id, symbol FROM stocks WHERE is_active = true
        `);

        for (const stock of stocks.rows) {
            // Ambil harga close terakhir (dari candle terakhir atau sesi sebelumnya)
            const lastCandle = await client.query(`
                /* dialect: postgres */
                SELECT close_price FROM stock_candles
                WHERE stock_id = $1
                ORDER BY start_time DESC LIMIT 1
            `, [stock.id]);

            let prevClose = 1000; // Default untuk saham baru

            if ((lastCandle.rowCount ?? 0) > 0) {
                prevClose = parseFloat(lastCandle.rows[0].close_price);
            } else {
                // Coba ambil dari sesi terakhir
                const lastSession = await client.query(`
                    /* dialect: postgres */
                    SELECT close_price, prev_close FROM daily_stock_data
                    WHERE stock_id = $1
                    ORDER BY session_id DESC LIMIT 1
                `, [stock.id]);

                if ((lastSession.rowCount ?? 0) > 0) {
                    prevClose = parseFloat(lastSession.rows[0].close_price || lastSession.rows[0].prev_close || 1000);
                }
            }

            const { araLimit, arbLimit } = calculateLimits(prevClose);

            await client.query(`
                /* dialect: postgres */
                INSERT INTO daily_stock_data (
                    stock_id, 
                    session_id, 
                    prev_close, 
                    open_price, 
                    close_price,
                    ara_limit, 
                    arb_limit
                )
                VALUES ($1, $2, $3, $3, $3, $4, $5)
            `, [stock.id, session.id, prevClose, araLimit, arbLimit]);

            console.log(`✅ Init ${stock.symbol}: prev=${prevClose}, ara=${araLimit}, arb=${arbLimit}`);
        }

        await client.query('COMMIT');

        res.json({
            message: 'Sesi trading berhasil dibuka',
            session
        });
    } catch (err: any) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// POST /api/admin/session/close - Tutup sesi trading (ADMIN ONLY)
router.post('/session/close', adminAuth, async (req: AuthRequest, res: Response) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Update status sesi jadi CLOSED
        const result = await client.query(`
            /* dialect: postgres */
            UPDATE trading_sessions 
            SET status = 'CLOSED', ended_at = NOW()
            WHERE status = 'OPEN'
            RETURNING id
        `);

        if ((result.rowCount ?? 0) === 0) {
            throw new Error('Tidak ada sesi yang sedang berjalan');
        }

        const sessionId = result.rows[0].id;

        // 2. Cancel semua order yang masih PENDING/PARTIAL
        // Ambil dulu semua order untuk di-refund
        const pendingOrders = await client.query(`
            /* dialect: postgres */
            SELECT o.*, s.symbol FROM orders o
            JOIN stocks s ON o.stock_id = s.id
            WHERE o.session_id = $1 AND o.status IN ('PENDING', 'PARTIAL')
        `, [sessionId]);

        for (const order of pendingOrders.rows) {
            const remainingQty = parseInt(order.remaining_quantity);

            if (order.type === 'BUY') {
                // Kembalikan saldo RDN
                const refund = order.price * (remainingQty * 100);
                await client.query(
                    'UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2',
                    [refund, order.user_id]
                );
            } else if (order.type === 'SELL') {
                // Kembalikan saham ke portfolio
                await client.query(`
                    /* dialect: postgres */
                    UPDATE portfolios SET quantity_owned = quantity_owned + $1
                    WHERE user_id = $2 AND stock_id = $3
                `, [remainingQty, order.user_id, order.stock_id]);
            }

            // Update status order
            await client.query(
                "UPDATE orders SET status = 'CANCELED' WHERE id = $1",
                [order.id]
            );

            // Hapus dari Redis
            const redisKey = `orderbook:${order.symbol}:${order.type.toLowerCase()}`;
            const allOrders = await redis.zrange(redisKey, 0, -1);
            for (const orderData of allOrders) {
                const parsed = JSON.parse(orderData);
                if (parsed.orderId === order.id || parsed.orderId === parseInt(order.id)) {
                    await redis.zrem(redisKey, orderData);
                }
            }
        }

        await client.query('COMMIT');

        // IMPORTANT: Flush all orderbook data from Redis to prevent stale orders
        console.log('🧹 Cleaning up Redis orderbook...');

        // Get all unique symbols
        const symbols = await client.query('SELECT DISTINCT symbol FROM stocks WHERE is_active = true');

        for (const stock of symbols.rows) {
            const buyKey = `orderbook:${stock.symbol}:buy`;
            const sellKey = `orderbook:${stock.symbol}:sell`;

            await redis.del(buyKey);
            await redis.del(sellKey);

            console.log(`  ✅ Cleared orderbook for ${stock.symbol}`);
        }

        console.log('✅ Redis orderbook cleanup complete!');

        res.json({
            message: 'Sesi trading berhasil ditutup',
            canceledOrders: pendingOrders.rowCount
        });
    } catch (err: any) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// GET /api/admin/orderbook/:symbol - Lihat orderbook (bid/ask)
router.get('/orderbook/:symbol', async (req: Request, res: Response) => {
    try {
        const symbol = req.params.symbol;

        // Ambil dari Redis
        const buyOrders = await redis.zrevrange(`orderbook:${symbol}:buy`, 0, 19, 'WITHSCORES');
        const sellOrders = await redis.zrange(`orderbook:${symbol}:sell`, 0, 19, 'WITHSCORES');

        // Parse hasil Redis
        const parseOrders = (raw: string[]) => {
            const result = [];
            for (let i = 0; i < raw.length; i += 2) {
                const data = JSON.parse(raw[i]);
                result.push({
                    price: parseFloat(raw[i + 1]),
                    quantity: data.remaining_quantity || data.quantity,
                    timestamp: data.timestamp
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

        const bids = aggregateByPrice(parseOrders(buyOrders));
        const asks = aggregateByPrice(parseOrders(sellOrders));

        res.json({
            symbol,
            bids, // Buy orders (harga tinggi ke rendah)
            asks  // Sell orders (harga rendah ke tinggi)
        });
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil orderbook' });
    }
});

// GET /api/admin/stocks - Daftar semua saham (untuk admin)
router.get('/stocks', async (req: Request, res: Response) => {
    try {
        const result = await pool.query(`
            /* dialect: postgres */
            SELECT s.*, d.prev_close, d.ara_limit, d.arb_limit, d.open_price, d.close_price
            FROM stocks s
            LEFT JOIN daily_stock_data d ON s.id = d.stock_id
                AND d.session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
            ORDER BY s.symbol
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data saham' });
    }
});

// PUT /api/admin/users/:userId/balance - Ubah saldo pengguna (ADMIN ONLY)
router.put('/users/:userId/balance', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { amount, reason } = req.body;
        const { userId } = req.params;

        if (typeof amount !== 'number' || Number.isNaN(amount)) {
            return res.status(400).json({ error: 'amount wajib berupa angka (positif/negatif)' });
        }

        if (amount === 0) {
            return res.status(400).json({ error: 'amount tidak boleh nol' });
        }

        const user = await AuthService.adjustUserBalance(userId, amount);

        if (!user) {
            return res.status(404).json({ error: 'User tidak ditemukan' });
        }

        console.log(`🪙 Admin ${req.userId} adjust balance ${amount} for ${userId}. reason=${reason || 'n/a'}`);

        res.json({
            message: 'Balance pengguna berhasil diperbarui',
            change: amount,
            reason: reason || null,
            user
        });
    } catch (err: any) {
        if (err.message === 'Balance tidak boleh negatif') {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Gagal memperbarui balance: ' + err.message });
    }
});

export default router;
//routes/admin.ts

import { Router, Request, Response } from 'express';
import pool from '../config/database';
import redis from '../config/redis';
import { calculateLimits, getTickSize } from '../core/market-logic';
import { adminAuth, AuthRequest } from '../middlewares/auth';
import { AuthService } from '../services/auth-service';
import { BotService } from '../services/bot-service';
import { MatchingEngine } from '../core/matching-engine';
import { MARKET_CONFIG, SessionStatus } from '../config/market';

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

        // 1. Cek apakah sudah ada sesi yang OPEN / PRE_OPEN / LOCKED
        const existingSession = await client.query(`
            /* dialect: postgres */
            SELECT id FROM trading_sessions WHERE status IN ('OPEN', 'PRE_OPEN', 'LOCKED')
        `);

        if ((existingSession.rowCount ?? 0) > 0) {
            throw new Error('Sudah ada sesi trading yang sedang berjalan');
        }

        // 2. Buat sesi baru - START with PRE_OPEN
        const sessionRes = await client.query(`
            /* dialect: postgres */
            INSERT INTO trading_sessions (session_number, status, started_at)
            VALUES (
                COALESCE((SELECT MAX(session_number) FROM trading_sessions), 0) + 1,
                'PRE_OPEN',
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

        // 4. Inject Order "Pending" dari saat market offline
        // Update session_id untuk order yang pending dari session sebelumnya
        const prevSessionRes = await client.query(`
            SELECT id FROM trading_sessions
            WHERE status = 'CLOSED' AND id < $1
            ORDER BY ended_at DESC
            LIMIT 1
        `, [session.id]);

        if ((prevSessionRes.rowCount ?? 0) > 0) {
            const prevSessionId = prevSessionRes.rows[0].id;

            // Ambil orders dari session sebelumnya yang statusnya PENDING
            const offlineOrders = await client.query(`
                SELECT o.*, s.symbol
                FROM orders o
                JOIN stocks s ON o.stock_id = s.id
                WHERE o.session_id = $1 AND o.status = 'PENDING'
            `, [prevSessionId]);

            console.log(`🔄 Moving ${offlineOrders.rowCount} offline orders to new session...`);

            if ((offlineOrders.rowCount ?? 0) > 0) {
                // Update session ID ke session baru
                await client.query(`
                    UPDATE orders
                    SET session_id = $1
                    WHERE session_id = $2 AND status = 'PENDING'
                `, [session.id, prevSessionId]);

                // Masukkan ke Redis
                for (const order of offlineOrders.rows) {
                    const redisPayload = JSON.stringify({
                        orderId: order.id,
                        userId: order.user_id,
                        stockId: order.stock_id,
                        price: parseFloat(order.price),
                        quantity: parseInt(order.quantity),
                        timestamp: new Date(order.created_at).getTime(),
                        remaining_quantity: parseInt(order.remaining_quantity)
                    });

                    const redisKey = `orderbook:${order.symbol}:${order.type.toLowerCase()}`;
                    await redis.zadd(redisKey, order.price, redisPayload);
                }

                // Trigger matching untuk simbol yang ada order offline-nya
                const affectedSymbols = new Set(offlineOrders.rows.map(o => o.symbol));
                affectedSymbols.forEach((sym) => {
                    MatchingEngine.match(sym as string);
                });
            }
        }

        await client.query('COMMIT');

        // 5. Start State Transitions in Background
        MatchingEngine.setSessionStatus(SessionStatus.PRE_OPEN);

        const PRE_OPEN_MS = MARKET_CONFIG.PRE_OPEN_DURATION;
        const LOCKED_MS = MARKET_CONFIG.LOCKED_DURATION;

        console.log(`⏰ Session started: PRE_OPEN (${PRE_OPEN_MS}ms) -> LOCKED (${LOCKED_MS}ms) -> OPEN`);

        setTimeout(async () => {
            // TRANSITION: PRE_OPEN -> LOCKED
            console.log('🔒 Entering LOCKED Phase...');
            MatchingEngine.setSessionStatus(SessionStatus.LOCKED);
            await pool.query("UPDATE trading_sessions SET status = 'LOCKED' WHERE id = $1", [session.id]);

            // Re-trigger IEP calc for all stocks to ensure display is updated
            const stocks = await pool.query('SELECT symbol FROM stocks WHERE is_active = true');
            for (const stock of stocks.rows) {
                MatchingEngine.match(stock.symbol);
            }

            setTimeout(async () => {
                // TRANSITION: LOCKED -> OPEN (Execute IEP)
                console.log('🔓 Entering OPEN Phase (IEP Execution)...');
                MatchingEngine.setSessionStatus(SessionStatus.OPEN);
                await pool.query("UPDATE trading_sessions SET status = 'OPEN' WHERE id = $1", [session.id]);

                // Execute IEP for all stocks
                const stocks = await pool.query('SELECT symbol FROM stocks WHERE is_active = true');
                for (const stock of stocks.rows) {
                    await MatchingEngine.executeIEP(stock.symbol);
                }

                console.log('✅ Market fully OPEN');

            }, LOCKED_MS);
        }, PRE_OPEN_MS);

        res.json({
            message: 'Sesi trading berhasil dibuka (Pre-Opening)',
            session,
            timeline: {
                preOpen: PRE_OPEN_MS,
                locked: LOCKED_MS,
                totalPreOpen: PRE_OPEN_MS + LOCKED_MS
            }
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
            WHERE status IN ('OPEN', 'PRE_OPEN', 'LOCKED')
            RETURNING id
        `);

        if ((result.rowCount ?? 0) === 0) {
            throw new Error('Tidak ada sesi yang sedang berjalan');
        }

        const sessionId = result.rows[0].id;
        MatchingEngine.setSessionStatus(SessionStatus.CLOSED);

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
                // TIDAK PERLU kembalikan saham ke portfolio karena sekarang saham tidak dikurangi saat pasang order
                // Saham hanya dikurangi saat MATCH terjadi di Matching Engine.
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

// GET /api/admin/orderbook/:symbol - Lihat orderbook (bid/ask) - ADMIN AUTH
router.get('/orderbook/:symbol', adminAuth, async (req: AuthRequest, res: Response) => {
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

// GET /api/admin/stocks - Daftar semua saham (untuk admin) - ADMIN AUTH
router.get('/stocks', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const result = await pool.query(`
            /* dialect: postgres */
            SELECT 
                s.*, 
                (SELECT COALESCE(SUM(quantity_owned), 0) FROM portfolios WHERE stock_id = s.id) as total_shares,
                d.prev_close, d.ara_limit, d.arb_limit, d.open_price, d.close_price
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

// PUT /api/admin/users/:userId/portfolio/:stockId - Ubah jumlah saham pengguna (ADMIN ONLY)
router.put('/users/:userId/portfolio/:stockId', adminAuth, async (req: AuthRequest, res: Response) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { userId, stockId } = req.params;
        const { amount, reason } = req.body;

        if (typeof amount !== 'number' || Number.isNaN(amount)) {
            throw new Error('amount wajib berupa angka (lot)');
        }

        if (amount === 0) {
            throw new Error('amount tidak boleh nol');
        }

        // 1. Cek stok saham & max_shares (jika menambah)
        const stockRes = await client.query('SELECT * FROM stocks WHERE id = $1 FOR UPDATE', [stockId]);
        if ((stockRes.rowCount ?? 0) === 0) throw new Error('Saham tidak ditemukan');
        const stock = stockRes.rows[0];

        // 2. Jika menambah, cek limit max_shares
        if (amount > 0) {
            const circulatingRes = await client.query('SELECT SUM(quantity_owned) as total FROM portfolios WHERE stock_id = $1', [stockId]);
            const circulating = parseInt(circulatingRes.rows[0].total || '0');

            if (circulating + amount > parseInt(stock.max_shares)) {
                throw new Error(`Gagal menambah: Total saham beredar akan melebihi batas maximal (${stock.max_shares} lot). Saat ini beredar: ${circulating} lot.`);
            }
        }

        // 2a. Jika mengurangi, cek apakah user memiliki saham yang cukup
        if (amount < 0) {
            const currentPortfolioRes = await client.query('SELECT quantity_owned FROM portfolios WHERE user_id = $1 AND stock_id = $2', [userId, stockId]);

            if (currentPortfolioRes.rowCount === 0) {
                throw new Error('User tidak memiliki saham ini sama sekali');
            }

            const currentQuantity = parseInt(currentPortfolioRes.rows[0].quantity_owned || '0');
            if (currentQuantity + amount < 0) { // amount sudah negatif
                throw new Error(`Jumlah saham tidak cukup untuk dikurangi. User memiliki ${currentQuantity} lot, diminta mengurangi ${Math.abs(amount)} lot.`);
            }
        }

        // 3. Update atau Insert ke portfolio user
        const portfolioRes = await client.query(`
            /* dialect: postgres */
            INSERT INTO portfolios (user_id, stock_id, quantity_owned)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, stock_id) 
            DO UPDATE SET quantity_owned = portfolios.quantity_owned + EXCLUDED.quantity_owned
            RETURNING *
        `, [userId, stockId, amount]);

        const updatedPortfolio = portfolioRes.rows[0];

        // 4. Jika quantity jadi 0, biarkan saja atau bisa dihapus.
        // Tapi constraint check(quantity_owned >= 0) akan melempar error jika amount negatif membuat qty < 0.

        await client.query('COMMIT');

        console.log(`📊 Admin ${req.userId} adjust portfolio for ${userId}: stock ${stock.symbol}, change ${amount} lot. reason=${reason || 'n/a'}`);

        res.json({
            message: 'Portfolio pengguna berhasil diperbarui',
            change: amount,
            symbol: stock.symbol,
            newQuantity: updatedPortfolio.quantity_owned,
            reason: reason || null
        });
    } catch (err: any) {
        await client.query('ROLLBACK');
        if (err.message.includes('portfolios_quantity_owned_check')) {
            return res.status(400).json({ error: 'Jumlah saham tidak cukup untuk dikurangi' });
        }
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// POST /api/admin/stocks - Tambah saham baru (ADMIN ONLY)
router.post('/stocks', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol, name, max_shares } = req.body;

        if (!symbol || !name) {
            return res.status(400).json({ error: 'Symbol dan Name wajib diisi' });
        }

        const result = await pool.query(`
            /* dialect: postgres */
            INSERT INTO stocks (symbol, name, max_shares)
            VALUES ($1, $2, $3)
            RETURNING *
        `, [symbol.toUpperCase(), name, max_shares || 0]);

        res.json({
            message: 'Saham berhasil ditambahkan',
            stock: {
                ...result.rows[0],
                total_shares: 0 // New stock has 0 circulating shares
            }
        });
    } catch (err: any) {
        res.status(500).json({ error: 'Gagal menambahkan saham: ' + err.message });
    }
});

// PUT /api/admin/stocks/:id - Update data saham (ADMIN ONLY)
router.put('/stocks/:id', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { symbol, name, max_shares, is_active } = req.body;

        const result = await pool.query(`
            /* dialect: postgres */
            UPDATE stocks
            SET symbol = COALESCE($1, symbol),
                name = COALESCE($2, name),
                max_shares = COALESCE($3, max_shares),
                is_active = COALESCE($4, is_active)
            WHERE id = $5
            RETURNING *
        `, [symbol?.toUpperCase(), name, max_shares, is_active, id]);

        if ((result.rowCount ?? 0) === 0) {
            return res.status(404).json({ error: 'Saham tidak ditemukan' });
        }

        // Get circulating shares
        const circulatingRes = await pool.query('SELECT SUM(quantity_owned) as total FROM portfolios WHERE stock_id = $1', [id]);
        const circulating = parseInt(circulatingRes.rows[0].total || '0');

        res.json({
            message: 'Saham berhasil diperbarui',
            stock: {
                ...result.rows[0],
                total_shares: circulating
            }
        });
    } catch (err: any) {
        res.status(500).json({ error: 'Gagal memperbarui saham: ' + err.message });
    }
});

// POST /api/admin/stocks/:id/issue - Berikan saham ke user (ADMIN ONLY)
router.post('/stocks/:id/issue', adminAuth, async (req: AuthRequest, res: Response) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params; // stock_id
        const { userId, quantity } = req.body; // quantity dalam LOT

        if (!userId || !quantity || quantity <= 0) {
            throw new Error('UserId dan quantity (positif) wajib diisi');
        }

        // 1. Cek stok saham & max_shares
        const stockRes = await client.query('SELECT * FROM stocks WHERE id = $1 FOR UPDATE', [id]);
        if ((stockRes.rowCount ?? 0) === 0) throw new Error('Saham tidak ditemukan');
        const stock = stockRes.rows[0];

        // 2. Cek total saham yang sudah beredar saat ini
        const circulatingRes = await client.query('SELECT SUM(quantity_owned) as total FROM portfolios WHERE stock_id = $1', [id]);
        const circulating = parseInt(circulatingRes.rows[0].total || '0');

        if (circulating + quantity > parseInt(stock.max_shares)) {
            throw new Error(`Gagal issue: Total saham beredar akan melebihi batas maximal (${stock.max_shares} lot). Saat ini beredar: ${circulating} lot.`);
        }

        // 3. Tambahkan ke portfolio user
        const portfolioRes = await client.query(`
            /* dialect: postgres */
            INSERT INTO portfolios (user_id, stock_id, quantity_owned)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, stock_id) 
            DO UPDATE SET quantity_owned = portfolios.quantity_owned + EXCLUDED.quantity_owned
            RETURNING *
        `, [userId, id, quantity]);

        await client.query('COMMIT');

        res.json({
            message: 'Saham berhasil di-issue ke user',
            portfolio: portfolioRes.rows[0],
            total_shares: circulating + quantity,
            max_shares: parseInt(stock.max_shares),
            available_supply: parseInt(stock.max_shares) - (circulating + quantity)
        });
    } catch (err: any) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// GET /api/admin/users - Daftar semua user (ADMIN ONLY)
router.get('/users', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const result = await pool.query(`
            WITH latest_session AS (
                SELECT id FROM trading_sessions ORDER BY id DESC LIMIT 1
            ),
            stock_prices AS (
                SELECT
                    stock_id,
                    COALESCE(close_price, prev_close, 0) as price
                FROM daily_stock_data
                WHERE session_id = (SELECT id FROM latest_session)
            ),
            user_stock_value AS (
                SELECT
                    p.user_id,
                    SUM(p.quantity_owned * sp.price * 100) as stock_value
                FROM portfolios p
                JOIN stock_prices sp ON p.stock_id = sp.stock_id
                GROUP BY p.user_id
            )
            SELECT
                u.id,
                u.username,
                u.full_name,
                u.balance_rdn,
                u.role,
                u.created_at,
                (CAST(u.balance_rdn AS NUMERIC) + COALESCE(usv.stock_value, 0)) as equity
            FROM users u
            LEFT JOIN user_stock_value usv ON u.id = usv.user_id
            ORDER BY u.created_at DESC
        `);

        // Convert numeric strings to numbers if needed, though pg driver might do it.
        // Usually numeric/decimal types come back as strings in JS to preserve precision.
        const users = result.rows.map(u => ({
            ...u,
            balance_rdn: parseFloat(u.balance_rdn),
            equity: parseFloat(u.equity)
        }));

        res.json(users);
    } catch (err: any) {
        res.status(500).json({ error: 'Gagal mengambil data user: ' + err.message });
    }
});

// GET /api/admin/orders - Daftar semua order terbaru (ADMIN ONLY)
router.get('/orders', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { status, symbol, limit = 100 } = req.query;
        let query = `
            SELECT o.*, s.symbol, u.username
            FROM orders o
            JOIN stocks s ON o.stock_id = s.id
            JOIN users u ON o.user_id = u.id
            WHERE 1=1
        `;
        const params: any[] = [];

        if (status) {
            params.push(status);
            query += ` AND o.status = $${params.length}`;
        }
        if (symbol) {
            params.push(symbol);
            query += ` AND s.symbol = $${params.length}`;
        }

        query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err: any) {
        res.status(500).json({ error: 'Gagal mengambil data order: ' + err.message });
    }
});

// GET /api/admin/trades - Daftar semua trade terbaru (ADMIN ONLY)
router.get('/trades', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { limit = 100 } = req.query;
        // REVISI: Handle nullable buy_order_id/sell_order_id (BOT) dan gunakan stock_id langsung dari trades
        const result = await pool.query(`
            SELECT t.*, s.symbol, 
                   COALESCE(bu.username, 'SYSTEM_BOT') as buyer,
                   COALESCE(su.username, 'SYSTEM_BOT') as seller
            FROM trades t
            LEFT JOIN orders bo ON t.buy_order_id = bo.id
            LEFT JOIN orders so ON t.sell_order_id = so.id
            JOIN stocks s ON t.stock_id = s.id
            LEFT JOIN users bu ON bo.user_id = bu.id
            LEFT JOIN users su ON so.user_id = su.id
            ORDER BY t.executed_at DESC
            LIMIT $1
        `, [limit]);
        res.json(result.rows);
    } catch (err: any) {
        res.status(500).json({ error: 'Gagal mengambil data trade: ' + err.message });
    }
});

// ========================================
// BOT MANAGEMENT ENDPOINTS
// ========================================

// POST /api/admin/bot/populate - Isi orderbook dengan bot orders untuk symbol tertentu
router.post('/bot/populate', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol, minLot, maxLot, spreadPercent, priceLevels } = req.body;

        if (!symbol) {
            return res.status(400).json({ error: 'Symbol diperlukan' });
        }

        const result = await BotService.populateOrderbook(symbol, {
            minLot,
            maxLot,
            spreadPercent,
            priceLevels
        });

        // Trigger matching engine agar terpantau realtime di user
        await MatchingEngine.match(symbol);

        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/bot/populate-all - Isi orderbook untuk semua saham aktif
router.post('/bot/populate-all', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { minLot, maxLot, spreadPercent, priceLevels } = req.body;

        const result = await BotService.populateAllStocks({
            minLot,
            maxLot,
            spreadPercent,
            priceLevels
        });

        // Trigger matching engine untuk semua saham yang baru diisi
        const stocksRes = await pool.query('SELECT symbol FROM stocks WHERE is_active = true');
        for (const stock of stocksRes.rows) {
            await MatchingEngine.match(stock.symbol);
        }

        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/bot/clear - Hapus bot orders dari orderbook
router.delete('/bot/clear', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol } = req.query;

        const result = await BotService.clearBotOrders(symbol as string | undefined);

        // Jika symbol spesifik diclear, broadcast update
        if (symbol) {
            await MatchingEngine.match(symbol as string);
        } else {
            // Jika semua diclear, broadcast semua
            const stocksRes = await pool.query('SELECT symbol FROM stocks WHERE is_active = true');
            for (const stock of stocksRes.rows) {
                await MatchingEngine.match(stock.symbol);
            }
        }

        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/bot/stats/:symbol - Dapatkan statistik orderbook (bot vs user)
router.get('/bot/stats/:symbol', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol } = req.params;

        const stats = await BotService.getOrderbookStats(symbol);

        res.json(stats);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/bot/supply/:symbol - Cek supply saham (beredar vs max)
router.get('/bot/supply/:symbol', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol } = req.params;
        const supplyInfo = await BotService.getStockSupplyInfo(symbol);
        res.json(supplyInfo);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/health - System health check (ADMIN ONLY)
router.get('/health', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const healthResult = await MatchingEngine.healthCheck();

        res.json({
            status: healthResult.healthy ? 'healthy' : 'unhealthy',
            timestamp: Date.now(),
            ...healthResult.details
        });
    } catch (err: any) {
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

// GET /api/admin/engine/stats - Matching engine stats (ADMIN ONLY)
router.get('/engine/stats', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const stats = MatchingEngine.getStats();
        res.json(stats);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/engine/reset-circuit - Reset circuit breaker (ADMIN ONLY)
router.post('/engine/reset-circuit', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol } = req.body;
        MatchingEngine.resetCircuitBreaker(symbol);
        res.json({
            success: true,
            message: symbol
                ? `Circuit breaker reset for ${symbol}`
                : 'All circuit breakers reset'
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/orderbook/validate - Validasi integritas orderbook (ADMIN ONLY)
router.get('/orderbook/validate', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol diperlukan' });

        const [buyOrders, sellOrders] = await Promise.all([
            redis.zrange(`orderbook:${symbol}:buy`, 0, -1),
            redis.zrange(`orderbook:${symbol}:sell`, 0, -1)
        ]);

        const validate = (orders: string[]) => {
            const issues = [];
            for (const o of orders) {
                try {
                    const parsed = JSON.parse(o);
                    if (!parsed.orderId || !parsed.userId || !parsed.price) issues.push(o);
                } catch {
                    issues.push(o);
                }
            }
            return issues;
        };

        const buyIssues = validate(buyOrders);
        const sellIssues = validate(sellOrders);

        res.json({
            success: true,
            symbol,
            healthy: buyIssues.length === 0 && sellIssues.length === 0,
            totalBuyOrders: buyOrders.length,
            totalSellOrders: sellOrders.length,
            validBuyOrders: buyOrders.length - buyIssues.length,
            validSellOrders: sellOrders.length - sellIssues.length,
            issues: {
                buy: buyIssues,
                sell: sellIssues
            }
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/engine/force-broadcast - Paksa broadcast orderbook (ADMIN ONLY)
router.post('/engine/force-broadcast', adminAuth, async (req: AuthRequest, res: Response) => {
    try {
        const { symbol } = req.body;
        if (!symbol) return res.status(400).json({ error: 'Symbol diperlukan' });

        await MatchingEngine.forceBroadcast(symbol);
        res.json({ success: true, message: `Force broadcast sent for ${symbol}` });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
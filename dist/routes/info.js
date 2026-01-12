"use strict";
// routes/info.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = __importDefault(require("../config/database"));
// Import auth middleware dari path yang benar
const auth_1 = require("../middlewares/auth");
const watchlist_service_1 = require("../services/watchlist-service");
const market_service_1 = require("../services/market-service");
const router = (0, express_1.Router)();
// GET /stocks - Daftar semua saham aktif
router.get('/stocks', async (req, res) => {
    try {
        // Query yang aman - hanya gunakan kolom yang pasti ada
        const result = await database_1.default.query(`
            /* dialect: postgres */
            SELECT
                s.id,
                s.symbol,
                s.name,
                s.is_active,
                s.max_shares,
                (SELECT COALESCE(SUM(quantity_owned), 0) FROM portfolios WHERE stock_id = s.id) as total_shares,
                d.open_price,
                d.close_price as last_price,
                d.prev_close,
                d.ara_limit as ara,
                d.arb_limit as arb,
                COALESCE(d.volume, 0) as volume,
                d.session_id
            FROM stocks s
            LEFT JOIN daily_stock_data d ON s.id = d.stock_id
                AND d.session_id = (
                    SELECT id FROM trading_sessions
                    WHERE status = 'OPEN'
                    ORDER BY id DESC
                    LIMIT 1
                )
            WHERE s.is_active = true
            ORDER BY s.symbol
        `);
        // Calculate change and changePercent for each stock
        const stocks = result.rows.map(stock => {
            // Check if stock has session data
            const hasSessionData = stock.session_id !== null;
            // last_price comes from close_price in daily_stock_data
            // If no session data, use prev_close from last session or default
            const lastPrice = hasSessionData
                ? parseFloat(stock.last_price || stock.prev_close || 1000)
                : parseFloat(stock.prev_close || 1000);
            const prevClose = parseFloat(stock.prev_close || lastPrice);
            const change = lastPrice - prevClose;
            const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
            // ARA/ARB should be non-zero if session is open
            const ara = parseFloat(stock.ara || stock.ara_limit || 0);
            const arb = parseFloat(stock.arb || stock.arb_limit || 0);
            return {
                id: stock.id,
                symbol: stock.symbol,
                name: stock.name || stock.symbol,
                is_active: stock.is_active,
                max_shares: parseInt(stock.max_shares || 0),
                total_shares: parseInt(stock.total_shares || 0),
                lastPrice: lastPrice,
                prevClose: prevClose,
                change: change,
                changePercent: changePercent,
                ara: ara,
                arb: arb,
                volume: parseInt(stock.volume || 0),
                hasSessionData: hasSessionData // Flag for debugging
            };
        });
        console.log(`✅ Fetched ${stocks.length} stocks`);
        res.json(stocks);
    }
    catch (err) {
        console.error('❌ Error fetching stocks:', err.message);
        console.error('Stack:', err.stack);
        res.status(500).json({
            error: 'Gagal ambil data saham',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});
// GET /portfolio - Portofolio user (butuh token)
router.get('/portfolio', auth_1.auth, async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) {
            res.status(401).json({ error: 'User ID missing' });
            return;
        }
        // Query portfolio - hanya gunakan kolom yang pasti ada
        const result = await database_1.default.query(`
            /* dialect: postgres */
            SELECT
                s.id as stock_id,
                s.symbol,
                s.name,
                p.quantity_owned,
                p.avg_buy_price
            FROM portfolios p
            JOIN stocks s ON p.stock_id = s.id
            WHERE p.user_id = $1 AND p.quantity_owned > 0
            ORDER BY s.symbol
        `, [userId]);
        // Query user balance
        const userRes = await database_1.default.query(`
            /* dialect: postgres */
            SELECT balance_rdn, full_name FROM users WHERE id = $1
        `, [userId]);
        if (userRes.rows.length === 0) {
            res.status(404).json({ error: 'User tidak ditemukan' });
            return;
        }
        console.log(`✅ Fetched portfolio for user ${userId}: ${result.rows.length} stocks`);
        res.json({
            full_name: userRes.rows[0].full_name || '',
            balance_rdn: parseFloat(userRes.rows[0].balance_rdn || '0'),
            stocks: result.rows
        });
    }
    catch (err) {
        console.error('❌ Error fetching portfolio:', err.message);
        console.error('Stack:', err.stack);
        res.status(500).json({
            error: 'Gagal ambil portfolio',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});
// GET /session - Status sesi trading (publik)
router.get('/session', async (req, res) => {
    try {
        // Check if trading_sessions table exists
        const tableCheck = await database_1.default.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'trading_sessions'
            );
        `);
        if (!tableCheck.rows[0].exists) {
            console.warn('⚠️ trading_sessions table does not exist');
            res.json({
                id: 0,
                status: 'CLOSED',
                session_number: 0,
                started_at: new Date().toISOString(),
                ended_at: null,
                message: 'Database belum diinisialisasi. Jalankan schema.sql terlebih dahulu.'
            });
            return;
        }
        const result = await database_1.default.query(`
            /* dialect: postgres */
            SELECT id, status, session_number, started_at, ended_at
            FROM trading_sessions
            ORDER BY id DESC
            LIMIT 1
        `);
        if (result.rows.length === 0) {
            res.json({
                id: 0,
                status: 'CLOSED',
                session_number: 0,
                started_at: new Date().toISOString(),
                ended_at: null,
                message: 'Tidak ada sesi aktif'
            });
            return;
        }
        res.json(result.rows[0]);
    }
    catch (err) {
        console.error('❌ Error fetching session:', err.message);
        console.error('Stack:', err.stack);
        // Return a default response instead of 500 error
        res.json({
            id: 0,
            status: 'CLOSED',
            session_number: 0,
            started_at: new Date().toISOString(),
            ended_at: null,
            message: 'Error: ' + err.message
        });
    }
});
// GET /api/market/queue/:symbol - Lihat detail queue
router.get('/market/queue/:symbol', auth_1.auth, async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const price = req.query.price;
        if (!price)
            return res.status(400).json({ error: 'Parameter price wajib diisi' });
        const queue = await market_service_1.MarketService.getOrderQueue(symbol, parseFloat(price));
        res.json({ symbol, price: parseFloat(price), queue });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ===================== WATCHLIST ENDPOINTS =====================
// GET /portfolio/watchlist - Ambil semua saham favorit user
router.get('/portfolio/watchlist', auth_1.auth, async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) {
            res.status(401).json({ error: 'User ID missing' });
            return;
        }
        const watchlist = await watchlist_service_1.WatchlistService.getWatchlist(userId);
        res.json(watchlist);
    }
    catch (err) {
        console.error('❌ Error fetching watchlist:', err.message);
        res.status(500).json({ error: 'Gagal mengambil watchlist' });
    }
});
// POST /portfolio/watchlist - Tambah saham ke favorit
router.post('/portfolio/watchlist', auth_1.auth, async (req, res) => {
    try {
        const userId = req.userId;
        const { symbol } = req.body;
        if (!userId) {
            res.status(401).json({ error: 'User ID missing' });
            return;
        }
        if (!symbol) {
            res.status(400).json({ error: 'Symbol wajib diisi' });
            return;
        }
        const item = await watchlist_service_1.WatchlistService.addToWatchlist(userId, symbol);
        res.status(201).json({
            message: 'Saham berhasil ditambahkan ke watchlist',
            item
        });
    }
    catch (err) {
        console.error('❌ Error adding to watchlist:', err.message);
        if (err.message.includes('sudah ada') || err.message.includes('tidak ditemukan')) {
            res.status(400).json({ error: err.message });
        }
        else {
            res.status(500).json({ error: 'Gagal menambahkan ke watchlist' });
        }
    }
});
// DELETE /portfolio/watchlist/:symbol - Hapus saham dari favorit
router.delete('/portfolio/watchlist/:symbol', auth_1.auth, async (req, res) => {
    try {
        const userId = req.userId;
        const symbol = req.params.symbol;
        if (!userId) {
            res.status(401).json({ error: 'User ID missing' });
            return;
        }
        await watchlist_service_1.WatchlistService.removeFromWatchlist(userId, symbol);
        res.json({ message: 'Saham berhasil dihapus dari watchlist' });
    }
    catch (err) {
        console.error('❌ Error removing from watchlist:', err.message);
        if (err.message.includes('tidak ada') || err.message.includes('tidak ditemukan')) {
            res.status(400).json({ error: err.message });
        }
        else {
            res.status(500).json({ error: 'Gagal menghapus dari watchlist' });
        }
    }
});
exports.default = router;

"use strict";
// routes/market.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const market_service_1 = require("../services/market-service");
const redis_1 = __importDefault(require("../config/redis"));
const router = (0, express_1.Router)();
// Get candles dengan support timeframe (1m, 5m, 15m, 1h, 1d)
router.get('/candles/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const timeframe = req.query.timeframe || '1m';
        const limit = parseInt(req.query.limit) || 1000;
        const data = await market_service_1.MarketService.getCandles(symbol, timeframe, limit);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data candle' });
    }
});
// Get daily stock data (OHLC per session) - semua saham
router.get('/daily-data', async (req, res) => {
    try {
        const data = await market_service_1.MarketService.getDailyStockData();
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil daily stock data' });
    }
});
// Get daily stock data (OHLC per session) - per symbol tertentu
router.get('/daily-data/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const data = await market_service_1.MarketService.getDailyStockData(symbol);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil daily stock data' });
    }
});
// GET /api/market/stocks/:symbol/orderbook - Lihat orderbook (bid/ask) untuk saham tertentu
router.get('/stocks/:symbol/orderbook', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const limit = parseInt(req.query.limit) || 10;
        // Ambil dari Redis
        const buyOrders = await redis_1.default.zrevrange(`orderbook:${symbol}:buy`, 0, limit - 1, 'WITHSCORES');
        const sellOrders = await redis_1.default.zrange(`orderbook:${symbol}:sell`, 0, limit - 1, 'WITHSCORES');
        // Parse hasil Redis
        const parseOrders = (raw) => {
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
        const aggregateByPrice = (orders) => {
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
            asks // Sell orders (harga rendah ke tinggi)
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil orderbook' });
    }
});
// GET /api/market/queue/:symbol - Lihat detail antrean order pada harga tertentu
router.get('/queue/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const price = parseFloat(req.query.price);
        if (isNaN(price)) {
            res.status(400).json({ error: 'Parameter price wajib diisi dan harus berupa angka' });
            return;
        }
        const queue = await market_service_1.MarketService.getOrderQueue(symbol, price);
        res.json({
            symbol: symbol.toUpperCase(),
            price,
            queue // List order urut berdasarkan timestamp (FIFO)
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil antrean order' });
    }
});
exports.default = router;

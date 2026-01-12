// routes/market.ts

import { Router, Request, Response } from 'express';
import { MarketService } from '../services/market-service';
import redis from '../config/redis';
import { IEPEngine } from '../core/iep-engine';
import { SessionStatus } from '../config/market';
import pool from '../config/database';

const router = Router();

// Get candles dengan support timeframe (1m, 5m, 15m, 1h, 1d)
router.get('/candles/:symbol', async (req: Request, res: Response) => {
    try {
        const symbol = req.params.symbol;
        const timeframe = (req.query.timeframe as string) || '1m';
        const limit = parseInt(req.query.limit as string) || 1000;
        const data = await MarketService.getCandles(symbol, timeframe, limit);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data candle' });
    }
});

// Get daily stock data (OHLC per session) - semua saham
router.get('/daily-data', async (req: Request, res: Response) => {
    try {
        const data = await MarketService.getDailyStockData();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil daily stock data' });
    }
});

// Get daily stock data (OHLC per session) - per symbol tertentu
router.get('/daily-data/:symbol', async (req: Request, res: Response) => {
    try {
        const symbol = req.params.symbol;
        const data = await MarketService.getDailyStockData(symbol);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil daily stock data' });
    }
});

// GET /api/market/stocks/:symbol/orderbook - Lihat orderbook (bid/ask) untuk saham tertentu
router.get('/stocks/:symbol/orderbook', async (req: Request, res: Response) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const limit = parseInt(req.query.limit as string) || 10;

        // Ambil dari Redis
        const buyOrders = await redis.zrevrange(`orderbook:${symbol}:buy`, 0, limit - 1, 'WITHSCORES');
        const sellOrders = await redis.zrange(`orderbook:${symbol}:sell`, 0, limit - 1, 'WITHSCORES');

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

// GET /api/market/queue/:symbol - Lihat detail antrean order pada harga tertentu
router.get('/queue/:symbol', async (req: Request, res: Response) => {
    try {
        const symbol = req.params.symbol;
        const price = parseFloat(req.query.price as string);

        if (isNaN(price)) {
            res.status(400).json({ error: 'Parameter price wajib diisi dan harus berupa angka' });
            return;
        }

        const queue = await MarketService.getOrderQueue(symbol, price);

        res.json({
            symbol: symbol.toUpperCase(),
            price,
            queue // List order urut berdasarkan timestamp (FIFO)
        });
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil antrean order' });
    }
});

// GET /api/market/iep/:symbol - Get current IEP (Pre-Opening/Locked Only)
router.get('/iep/:symbol', async (req: Request, res: Response) => {
    try {
        const symbol = req.params.symbol.toUpperCase();

        // Cek Session Status
        const sessionRes = await pool.query(`
            SELECT status FROM trading_sessions
            ORDER BY id DESC LIMIT 1
        `);

        const status = sessionRes.rows[0]?.status;

        if (status === SessionStatus.PRE_OPEN || status === SessionStatus.LOCKED) {
            const iepData = await IEPEngine.calculateIEP(symbol);
            res.json({
                symbol,
                iep: iepData ? iepData.price : null,
                volume: iepData ? iepData.matchedVolume : 0,
                surplus: iepData ? iepData.surplus : 0,
                status
            });
        } else {
            // Outside of pre-open/locked, return null as requested
            res.json({
                symbol,
                iep: null,
                volume: 0,
                surplus: 0,
                status
            });
        }
    } catch (err: any) {
        res.status(500).json({ error: 'Gagal mengambil data IEP' });
    }
});

export default router;

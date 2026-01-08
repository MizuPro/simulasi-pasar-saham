import { Router, Request, Response } from 'express';
import { MarketService } from '../services/market-service';

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

export default router;
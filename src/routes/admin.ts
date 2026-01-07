import { Router, Request, Response } from 'express';
// Perhatikan titik duanya (..) untuk naik satu folder
import { calculateLimits, getTickSize } from '../core/market-logic';

const router = Router();

// Karena nanti di index.ts kita pasang di path '/api/admin',
// di sini cukup tulis '/init-session' saja
router.post('/init-session', async (req: Request, res: Response) => {
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

export default router;
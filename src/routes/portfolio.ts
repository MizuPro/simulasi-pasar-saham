//routes/portfolio.ts

import { Router, Response } from 'express';
import { auth, AuthRequest } from '../middlewares/auth';
import { PortfolioService } from '../services/portfolio-service';

const router = Router();

// Route ini sekarang dijagain sama auth
router.get('/me', auth, async (req: AuthRequest, res: Response) => {
    try {
        // req.userId didapet dari hasil verifikasi token di middleware
        const data = await PortfolioService.getPortfolio(req.userId!);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data portofolio' });
    }
});

export default router;
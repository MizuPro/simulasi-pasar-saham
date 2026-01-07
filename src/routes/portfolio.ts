import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middlewares/auth-middleware';
import { PortfolioService } from '../services/portfolio-service';

const router = Router();

// Route ini sekarang dijagain sama authMiddleware
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        // req.userId didapet dari hasil verifikasi token di middleware
        const data = await PortfolioService.getPortfolio(req.userId!);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data portofolio' });
    }
});

export default router;
// src/routes/ipo.ts

import { Router, Response } from 'express';
import { auth, AuthRequest } from '../middlewares/auth';
import { IPOService } from '../services/ipo-service';

const router = Router();

// GET /api/ipo - List all IPOs (Active/Upcoming)
router.get('/', auth, async (req: AuthRequest, res: Response) => {
    try {
        const ipos = await IPOService.getIPOs(); // Get all for user to see history too? Or filter?
        // User might want to see Active ones primarily.
        res.json(ipos);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/ipo/:id/subscribe - Subscribe to IPO
router.post('/:id/subscribe', auth, async (req: AuthRequest, res: Response) => {
    try {
        const { quantity } = req.body;
        if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Quantity wajib > 0' });

        const result = await IPOService.subscribeIPO(req.userId!, req.params.id as string, quantity);
        res.json(result);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

export default router;

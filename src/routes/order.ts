import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middlewares/auth-middleware';
import { OrderService } from '../services/order-service';

const router = Router();

router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
    const { symbol, type, price, quantity } = req.body;
    try {
        const result = await OrderService.placeOrder(req.userId!, symbol, type, price, quantity);
        res.json(result);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

export default router;
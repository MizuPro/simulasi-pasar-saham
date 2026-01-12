//routes/order.ts



import { Router, Response } from 'express';

import { auth, AuthRequest } from '../middlewares/auth';

import { OrderService } from '../services/order-service';



const router = Router();



// POST /api/orders - Pasang order baru (BUY/SELL)

router.post('/', auth, async (req: AuthRequest, res: Response) => {

    const { symbol, type, price, quantity } = req.body;

    try {

        const result = await OrderService.placeOrder(req.userId!, symbol, type, price, quantity);

        res.json(result);

    } catch (err: any) {

        res.status(400).json({ error: err.message });

    }

});



// DELETE /api/orders/:id - Batalkan order

router.delete('/:id', auth, async (req: AuthRequest, res: Response) => {

    try {

        const result = await OrderService.cancelOrder(req.userId!, req.params.id as string);

        res.json(result);

    } catch (err: any) {

        res.status(400).json({ error: err.message });

    }

});



// GET /api/orders/history - Riwayat semua order

router.get('/history', auth, async (req: AuthRequest, res: Response) => {

    try {

        const orders = await OrderService.getOrderHistory(req.userId!);

        res.json(orders);

    } catch (err: any) {

        res.status(500).json({ error: 'Gagal mengambil history order' });

    }

});



// GET /api/orders/active - Order yang masih aktif (PENDING/PARTIAL)

router.get('/active', auth, async (req: AuthRequest, res: Response) => {

    try {

        const orders = await OrderService.getActiveOrders(req.userId!);

        res.json(orders);

    } catch (err: any) {

        res.status(500).json({ error: 'Gagal mengambil order aktif' });

    }

});



export default router;
"use strict";
//routes/order.ts
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middlewares/auth");
const order_service_1 = require("../services/order-service");
const router = (0, express_1.Router)();
// POST /api/orders - Pasang order baru (BUY/SELL)
router.post('/', auth_1.auth, async (req, res) => {
    const { symbol, type, price, quantity } = req.body;
    try {
        const result = await order_service_1.OrderService.placeOrder(req.userId, symbol, type, price, quantity);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// DELETE /api/orders/:id - Batalkan order
router.delete('/:id', auth_1.auth, async (req, res) => {
    try {
        const result = await order_service_1.OrderService.cancelOrder(req.userId, req.params.id);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// GET /api/orders/history - Riwayat semua order
router.get('/history', auth_1.auth, async (req, res) => {
    try {
        const orders = await order_service_1.OrderService.getOrderHistory(req.userId);
        res.json(orders);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil history order' });
    }
});
// GET /api/orders/active - Order yang masih aktif (PENDING/PARTIAL)
router.get('/active', auth_1.auth, async (req, res) => {
    try {
        const orders = await order_service_1.OrderService.getActiveOrders(req.userId);
        res.json(orders);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil order aktif' });
    }
});
exports.default = router;

"use strict";
// src/routes/ipo.ts
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middlewares/auth");
const ipo_service_1 = require("../services/ipo-service");
const router = (0, express_1.Router)();
// GET /api/ipo - List all IPOs (Active/Upcoming)
router.get('/', auth_1.auth, async (req, res) => {
    try {
        const ipos = await ipo_service_1.IPOService.getIPOs(); // Get all for user to see history too? Or filter?
        // User might want to see Active ones primarily.
        res.json(ipos);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/ipo/:id/subscribe - Subscribe to IPO
router.post('/:id/subscribe', auth_1.auth, async (req, res) => {
    try {
        const { quantity } = req.body;
        if (!quantity || quantity <= 0)
            return res.status(400).json({ error: 'Quantity wajib > 0' });
        const result = await ipo_service_1.IPOService.subscribeIPO(req.userId, req.params.id, quantity);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
exports.default = router;

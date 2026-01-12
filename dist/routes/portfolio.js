"use strict";
//routes/portfolio.ts
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middlewares/auth");
const portfolio_service_1 = require("../services/portfolio-service");
const router = (0, express_1.Router)();
// Route ini sekarang dijagain sama auth
router.get('/me', auth_1.auth, async (req, res) => {
    try {
        // req.userId didapet dari hasil verifikasi token di middleware
        const data = await portfolio_service_1.PortfolioService.getPortfolio(req.userId);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data portofolio' });
    }
});
exports.default = router;

"use strict";
//routes/auth.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const auth_service_1 = require("../services/auth-service");
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
// POST /api/auth/register - Register user baru (role: USER)
router.post('/register', async (req, res) => {
    try {
        const { username, fullName, password } = req.body;
        if (!username || !fullName || !password) {
            return res.status(400).json({ error: 'Username, fullName, dan password wajib diisi' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password minimal 6 karakter' });
        }
        const user = await auth_service_1.AuthService.register(username, fullName, password);
        res.status(201).json({ message: 'User registered', user });
    }
    catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(400).json({ error: 'Username sudah digunakan' });
        }
        res.status(400).json({ error: 'Registrasi gagal: ' + err.message });
    }
});
// POST /api/auth/login - Login user
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username dan password wajib diisi' });
    }
    const user = await auth_service_1.AuthService.validateUser(username, password);
    if (!user) {
        return res.status(401).json({ error: 'Username atau password salah' });
    }
    // Include role in JWT token
    const token = jsonwebtoken_1.default.sign({
        userId: user.id,
        role: user.role
    }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({
        message: 'Login successful',
        token,
        user: {
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            balance_rdn: user.balance_rdn,
            role: user.role
        }
    });
});
// POST /api/auth/admin/create - Create admin user (admin only)
router.post('/admin/create', auth_1.adminAuth, async (req, res) => {
    try {
        const { username, fullName, password } = req.body;
        if (!username || !fullName || !password) {
            return res.status(400).json({ error: 'Username, fullName, dan password wajib diisi' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password admin minimal 8 karakter' });
        }
        const admin = await auth_service_1.AuthService.createAdmin(username, fullName, password);
        res.status(201).json({ message: 'Admin created', user: admin });
    }
    catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Username sudah digunakan' });
        }
        res.status(400).json({ error: 'Gagal membuat admin: ' + err.message });
    }
});
// GET /api/auth/admin/users - Get all users (admin only)
router.get('/admin/users', auth_1.adminAuth, async (req, res) => {
    try {
        const users = await auth_service_1.AuthService.getAllUsers();
        res.json(users);
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data users' });
    }
});
// PUT /api/auth/admin/role - Update user role (admin only)
router.put('/admin/role', auth_1.adminAuth, async (req, res) => {
    try {
        const { userId, role } = req.body;
        if (!userId || !role) {
            return res.status(400).json({ error: 'userId dan role wajib diisi' });
        }
        if (!['USER', 'ADMIN'].includes(role)) {
            return res.status(400).json({ error: 'Role harus USER atau ADMIN' });
        }
        // Prevent admin from removing their own admin role
        if (userId === req.userId && role === 'USER') {
            return res.status(400).json({ error: 'Anda tidak dapat menghapus role admin Anda sendiri' });
        }
        const user = await auth_service_1.AuthService.updateUserRole(userId, role);
        if (!user) {
            return res.status(404).json({ error: 'User tidak ditemukan' });
        }
        res.json({ message: 'Role updated', user });
    }
    catch (err) {
        res.status(500).json({ error: 'Gagal update role: ' + err.message });
    }
});
// PUT /api/auth/admin/users/:userId/balance - Adjust user balance (admin only)
router.put('/admin/users/:userId/balance', auth_1.adminAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, reason } = req.body;
        const parsedAmount = Number(amount);
        if (Number.isNaN(parsedAmount)) {
            return res.status(400).json({ error: 'Amount harus berupa angka' });
        }
        if (parsedAmount === 0) {
            return res.status(400).json({ error: 'Amount tidak boleh nol' });
        }
        if (reason !== undefined && typeof reason !== 'string') {
            return res.status(400).json({ error: 'Reason harus berupa teks' });
        }
        const user = await auth_service_1.AuthService.adjustUserBalance(userId, parsedAmount, reason?.trim());
        if (!user) {
            return res.status(404).json({ error: 'User tidak ditemukan' });
        }
        res.json({
            message: 'Balance pengguna berhasil diperbarui',
            change: parsedAmount,
            reason: reason?.trim() || null,
            user
        });
    }
    catch (err) {
        const message = err.message || 'Gagal mengubah balance';
        const status = message === 'Balance tidak boleh negatif' ? 400 : 500;
        res.status(status).json({ error: message });
    }
});
exports.default = router;

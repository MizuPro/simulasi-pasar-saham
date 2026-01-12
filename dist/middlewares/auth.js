"use strict";
//middlewares/auth.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalAdminCheck = exports.adminAuth = exports.auth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = __importDefault(require("../config/database"));
// Middleware untuk autentikasi user biasa
const auth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Akses ditolak, token hilang' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role || 'USER';
        next();
    }
    catch (err) {
        res.status(403).json({ error: 'Token tidak valid atau expired' });
    }
};
exports.auth = auth;
// Middleware untuk autentikasi admin
const adminAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Akses ditolak, token hilang' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        // Verify user is admin from database
        const userRes = await database_1.default.query('SELECT role FROM users WHERE id = $1', [decoded.userId]);
        if (userRes.rowCount === 0) {
            return res.status(401).json({ error: 'User tidak ditemukan' });
        }
        const userRole = userRes.rows[0].role;
        req.userRole = userRole;
        if (userRole !== 'ADMIN') {
            return res.status(403).json({ error: 'Akses ditolak. Hanya admin yang dapat mengakses endpoint ini.' });
        }
        next();
    }
    catch (err) {
        res.status(403).json({ error: 'Token tidak valid atau expired' });
    }
};
exports.adminAuth = adminAuth;
// Optional: Check if user is admin (doesn't block, just sets flag)
const optionalAdminCheck = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
            req.userId = decoded.userId;
            const userRes = await database_1.default.query('SELECT role FROM users WHERE id = $1', [decoded.userId]);
            if ((userRes.rowCount ?? 0) > 0) {
                req.userRole = userRes.rows[0].role;
            }
        }
        catch {
            // Token invalid, continue without auth
        }
    }
    next();
};
exports.optionalAdminCheck = optionalAdminCheck;

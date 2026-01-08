//middlewares/auth.ts

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/database';

// Extend interface Request untuk menyimpan userId dan role
export interface AuthRequest extends Request {
    userId?: string;
    userRole?: 'USER' | 'ADMIN';
}

// Middleware untuk autentikasi user biasa
export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Akses ditolak, token hilang' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; role?: string };
        req.userId = decoded.userId;
        req.userRole = (decoded.role as 'USER' | 'ADMIN') || 'USER';
        next();
    } catch (err) {
        res.status(403).json({ error: 'Token tidak valid atau expired' });
    }
};

// Middleware untuk autentikasi admin
export const adminAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Akses ditolak, token hilang' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
        req.userId = decoded.userId;

        // Verify user is admin from database
        const userRes = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (userRes.rowCount === 0) {
            return res.status(401).json({ error: 'User tidak ditemukan' });
        }

        const userRole = userRes.rows[0].role;
        req.userRole = userRole;

        if (userRole !== 'ADMIN') {
            return res.status(403).json({ error: 'Akses ditolak. Hanya admin yang dapat mengakses endpoint ini.' });
        }

        next();
    } catch (err) {
        res.status(403).json({ error: 'Token tidak valid atau expired' });
    }
};

// Optional: Check if user is admin (doesn't block, just sets flag)
export const optionalAdminCheck = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
            req.userId = decoded.userId;

            const userRes = await pool.query(
                'SELECT role FROM users WHERE id = $1',
                [decoded.userId]
            );

            if ((userRes.rowCount ?? 0) > 0) {
                req.userRole = userRes.rows[0].role;
            }
        } catch {
            // Token invalid, continue without auth
        }
    }
    next();
};


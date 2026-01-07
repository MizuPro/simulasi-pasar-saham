import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Kita extend interface Request biar bisa nyimpen userId
export interface AuthRequest extends Request {
    userId?: string;
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Ambil token dari "Bearer <token>"

    if (!token) {
        return res.status(401).json({ error: 'Akses ditolak, token hilang' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
        req.userId = decoded.userId; // Simpan userId biar bisa dipake di route selanjutnya
        next(); // Lanjut ke proses berikutnya
    } catch (err) {
        res.status(403).json({ error: 'Token tidak valid atau expired' });
    }
};
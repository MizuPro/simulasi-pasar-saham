//services/auth-service.ts

import bcrypt from 'bcrypt';
import pool from '../config/database';
import { IUser } from '../types';

export class AuthService {
    // Fungsi Register: Hash password & simpan ke DB
    static async register(username: string, fullName: string, password: string, role: 'USER' | 'ADMIN' = 'USER'): Promise<IUser> {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, full_name, password_hash, balance_rdn, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, full_name, balance_rdn, role, created_at',
            [username, fullName, hashedPassword, 0, role]
        );
        return result.rows[0];
    }

    // Fungsi Login: Cek username & password
    static async validateUser(username: string, password: string) {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (user && await bcrypt.compare(password, user.password_hash)) {
            const { password_hash, ...userWithoutPassword } = user;
            return {
                ...userWithoutPassword,
                role: user.role || 'USER' // Default to USER jika role tidak ada
            };
        }
        return null;
    }

    // Fungsi untuk membuat admin baru (hanya bisa dipanggil oleh admin)
    static async createAdmin(username: string, fullName: string, password: string): Promise<IUser> {
        return this.register(username, fullName, password, 'ADMIN');
    }

    // Fungsi untuk update role user
    static async updateUserRole(userId: string, newRole: 'USER' | 'ADMIN'): Promise<IUser | null> {
        const result = await pool.query(
            'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, full_name, balance_rdn, role, created_at',
            [newRole, userId]
        );
        return result.rows[0] || null;
    }

    // Fungsi untuk mendapatkan semua users (untuk admin)
    static async getAllUsers(role?: string): Promise<IUser[]> {
        let query = 'SELECT id, username, full_name, balance_rdn, role, created_at FROM users';
        const params: any[] = [];

        if (role) {
            query += ' WHERE role = $1';
            params.push(role);
        }

        query += ' ORDER BY created_at DESC';

        const result = await pool.query(query, params);
        return result.rows;
    }

    static async adjustUserBalance(userId: string, amount: number, reason?: string): Promise<IUser | null> {
        if (amount === 0) {
            throw new Error('Amount tidak boleh nol');
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const userRes = await client.query(
                /* sql */ 'SELECT balance_rdn FROM users WHERE id = $1 FOR UPDATE',
                [userId]
            );

            if (userRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return null;
            }

            const currentBalance = parseFloat(userRes.rows[0].balance_rdn || '0');
            const updatedBalance = currentBalance + amount;

            if (updatedBalance < 0) {
                throw new Error('Balance tidak boleh negatif');
            }

            if (reason) {
                console.info('Admin balance adjustment reason:', reason);
            }

            const result = await client.query(
                'UPDATE users SET balance_rdn = $1 WHERE id = $2 RETURNING id, username, full_name, balance_rdn, role, created_at',
                [updatedBalance, userId]
            );

            await client.query('COMMIT');
            return result.rows[0];
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
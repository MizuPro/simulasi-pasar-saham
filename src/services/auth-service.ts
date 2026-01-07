import bcrypt from 'bcrypt';
import pool from '../config/database';
import { IUser } from '../types';

export class AuthService {
    // Fungsi Register: Hash password & simpan ke DB
    static async register(username: string, fullName: string, password: string): Promise<IUser> {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, full_name, password_hash, balance_rdn) VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, balance_rdn, created_at',
            [username, fullName, hashedPassword, 100000000] // Kasih saldo awal 100jt buat simulasi
        );
        return result.rows[0];
    }

    // Fungsi Login: Cek username & password
    static async validateUser(username: string, password: string) {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (user && await bcrypt.compare(password, user.password_hash)) {
            const { password_hash, ...userWithoutPassword } = user;
            return userWithoutPassword;
        }
        return null;
    }
}
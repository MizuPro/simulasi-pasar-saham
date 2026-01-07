import pool from '../config/database';
import redis from '../config/redis';
import { isValidTickSize } from '../core/market-logic';
import { MatchingEngine } from '../core/matching-engine';

export class OrderService {
    static async placeOrder(userId: string, symbol: string, type: 'BUY' | 'SELL', price: number, quantity: number) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Ambil data saham & harga ARA/ARB sesi ini
            const stockRes = await client.query(`
        SELECT s.id, d.ara_limit, d.arb_limit, d.session_id 
        FROM stocks s
        JOIN daily_stock_data d ON s.id = d.stock_id
        WHERE s.symbol = $1 AND d.session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
      `, [symbol]);

            if (stockRes.rowCount === 0) throw new Error('Saham tidak ditemukan atau bursa sedang tutup');
            const stock = stockRes.rows[0];

            // 2. Validasi Harga (Tick Size & ARA/ARB)
            if (!isValidTickSize(price)) throw new Error('Harga tidak sesuai fraksi (Tick Size)');
            if (price > stock.ara_limit || price < stock.arb_limit) throw new Error('Harga melampaui batas ARA/ARB');

            const totalCost = price * (quantity * 100); // Quantity dalam Lot (1 Lot = 100 lembar)

            if (type === 'BUY') {
                // 3. Cek & Potong Saldo RDN (Lock Balance)
                const userRes = await client.query('SELECT balance_rdn FROM users WHERE id = $1 FOR UPDATE', [userId]);
                if (parseFloat(userRes.rows[0].balance_rdn) < totalCost) throw new Error('Saldo RDN tidak cukup');

                await client.query('UPDATE users SET balance_rdn = balance_rdn - $1 WHERE id = $2', [totalCost, userId]);
            }

            // 4. Simpan Order ke Database
            const orderRes = await client.query(`
        INSERT INTO orders (user_id, stock_id, session_id, type, price, quantity, remaining_quantity, status)
        VALUES ($1, $2, $3, $4, $5, $6, $6, 'PENDING')
        RETURNING id
      `, [userId, stock.id, stock.session_id, type, price, quantity]);

            const orderId = orderRes.rows[0].id;

            await client.query('COMMIT');

            // 5. Lempar ke Redis buat diolah Matching Engine nanti
            const redisKey = `orderbook:${symbol}:${type.toLowerCase()}`;
            await redis.zadd(redisKey, price, JSON.stringify({ orderId, userId, price, quantity }));

            MatchingEngine.match(symbol);

            return { orderId, status: 'PENDING', message: 'Order berhasil dipasang' };
        } catch (err: any) {
            await client.query('ROLLBACK');
            throw new Error(err.message);
        } finally {
            client.release();
        }
    }
}
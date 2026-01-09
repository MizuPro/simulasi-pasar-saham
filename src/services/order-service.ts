//services/order-service.ts

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
                /* dialect: postgres */
                SELECT s.id, d.ara_limit, d.arb_limit, d.session_id
                FROM stocks s
                JOIN daily_stock_data d ON s.id = d.stock_id
                WHERE s.symbol = $1 AND d.session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
            `, [symbol]);

            if ((stockRes.rowCount ?? 0) === 0) throw new Error('Saham tidak ditemukan atau bursa sedang tutup');
            const stock = stockRes.rows[0];

            // 2. Validasi Harga (Tick Size & ARA/ARB)
            if (!isValidTickSize(price)) throw new Error('Harga tidak sesuai fraksi (Tick Size)');
            if (price > stock.ara_limit || price < stock.arb_limit) throw new Error('Harga melampaui batas ARA/ARB');

            const totalCost = price * (quantity * 100); // Quantity dalam Lot (1 Lot = 100 lembar)

            if (type === 'BUY') {
                // 3a. BUY: Cek & Potong Saldo RDN (Lock Balance)
                const userRes = await client.query(
                    /* sql */ 'SELECT balance_rdn FROM users WHERE id = $1 FOR UPDATE',
                    [userId]
                );
                if (parseFloat(userRes.rows[0].balance_rdn) < totalCost) {
                    throw new Error('Saldo RDN tidak cukup');
                }

                await client.query(
                    'UPDATE users SET balance_rdn = balance_rdn - $1 WHERE id = $2',
                    [totalCost, userId]
                );
            } else if (type === 'SELL') {
                // 3b. SELL: Cek kepemilikan saham & Lock saham
                const portfolioRes = await client.query(`
                    /* dialect: postgres */
                    SELECT quantity_owned FROM portfolios
                    WHERE user_id = $1 AND stock_id = $2
                    FOR UPDATE
                `, [userId, stock.id]);

                if ((portfolioRes.rowCount ?? 0) === 0) {
                    throw new Error('Anda tidak memiliki saham ini');
                }

                const ownedQty = parseInt(portfolioRes.rows[0].quantity_owned);
                if (ownedQty < quantity) {
                    throw new Error(`Jumlah saham tidak cukup. Anda hanya punya ${ownedQty} lot`);
                }

                // Kurangi (lock) saham dari portfolio
                await client.query(`
                    /* dialect: postgres */
                    UPDATE portfolios SET quantity_owned = quantity_owned - $1
                    WHERE user_id = $2 AND stock_id = $3
                `, [quantity, userId, stock.id]);
            }

            // 4. Simpan Order ke Database (Status PENDING)
            const orderRes = await client.query(`
                /* dialect: postgres */
                INSERT INTO orders (user_id, stock_id, session_id, type, price, quantity, remaining_quantity, status)
                VALUES ($1, $2, $3, $4, $5, $6, $6, 'PENDING')
                RETURNING id
            `, [userId, stock.id, stock.session_id, type, price, quantity]);

            const orderId = orderRes.rows[0].id;

            await client.query('COMMIT');

            // 5. Lempar ke Redis buat diolah Matching Engine
            const timestamp = Date.now();
            const redisPayload = JSON.stringify({
                orderId,
                userId,
                price,
                quantity,
                timestamp,
                remaining_quantity: quantity
            });

            const redisKey = `orderbook:${symbol}:${type.toLowerCase()}`;
            await redis.zadd(redisKey, price, redisPayload);

            // Panggil Engine tanpa await (Background Process)
            MatchingEngine.match(symbol);

            return { orderId, status: 'PENDING', message: 'Order berhasil dipasang' };
        } catch (err: any) {
            await client.query('ROLLBACK');
            throw new Error(err.message);
        } finally {
            client.release();
        }
    }

    // Cancel Order yang masih PENDING
    static async cancelOrder(userId: string, orderId: string) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Ambil data order
            const orderRes = await client.query(`
                /* dialect: postgres */
                SELECT o.*, s.symbol FROM orders o
                JOIN stocks s ON o.stock_id = s.id
                WHERE o.id = $1 AND o.user_id = $2
                FOR UPDATE
            `, [orderId, userId]);

            if ((orderRes.rowCount ?? 0) === 0) {
                throw new Error('Order tidak ditemukan');
            }

            const order = orderRes.rows[0];

            if (order.status !== 'PENDING' && order.status !== 'PARTIAL') {
                throw new Error(`Order tidak bisa dibatalkan (status: ${order.status})`);
            }

            const remainingQty = parseInt(order.remaining_quantity);

            // 2. Refund berdasarkan tipe order
            if (order.type === 'BUY') {
                // Kembalikan saldo RDN
                const refundAmount = order.price * (remainingQty * 100);
                await client.query(
                    'UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2',
                    [refundAmount, userId]
                );
            } else if (order.type === 'SELL') {
                // Kembalikan saham ke portfolio
                await client.query(`
                    /* dialect: postgres */
                    UPDATE portfolios SET quantity_owned = quantity_owned + $1
                    WHERE user_id = $2 AND stock_id = $3
                `, [remainingQty, userId, order.stock_id]);
            }

            // 3. Update status order jadi CANCELED
            await client.query(
                "UPDATE orders SET status = 'CANCELED' WHERE id = $1",
                [orderId]
            );

            // 4. Hapus dari Redis
            const redisKey = `orderbook:${order.symbol}:${order.type.toLowerCase()}`;
            // Cari dan hapus entry yang cocok
            const allOrders = await redis.zrange(redisKey, 0, -1);
            for (const orderData of allOrders) {
                const parsed = JSON.parse(orderData);
                if (parsed.orderId === orderId || parsed.orderId === parseInt(orderId)) {
                    await redis.zrem(redisKey, orderData);
                    break;
                }
            }

            await client.query('COMMIT');

            return { message: 'Order berhasil dibatalkan' };
        } catch (err: any) {
            await client.query('ROLLBACK');
            throw new Error(err.message);
        } finally {
            client.release();
        }
    }

    // Ambil history order user
    static async getOrderHistory(userId: string) {
        const result = await pool.query(`
            /* dialect: postgres */
            SELECT 
                o.id, 
                s.symbol, 
                o.type, 
                o.price as target_price, 
                COALESCE(AVG(t.price), o.price) as execution_price,
                o.quantity, 
                o.remaining_quantity,
                o.status, 
                o.created_at, 
                o.session_id
            FROM orders o
            JOIN stocks s ON o.stock_id = s.id
            LEFT JOIN trades t ON (t.buy_order_id = o.id OR t.sell_order_id = o.id)
            WHERE o.user_id = $1
            GROUP BY o.id, s.symbol
            ORDER BY o.created_at DESC
            LIMIT 100
        `, [userId]);

        return result.rows.map(row => ({
            ...row,
            price: parseFloat(row.execution_price),
            target_price: parseFloat(row.target_price)
        }));
    }

    // Ambil order aktif (PENDING/PARTIAL) user
    static async getActiveOrders(userId: string) {
        const result = await pool.query(`
            /* dialect: postgres */
            SELECT 
                o.id, 
                s.symbol, 
                o.type, 
                o.price as target_price,
                COALESCE(AVG(t.price), o.price) as execution_price,
                o.quantity, 
                o.remaining_quantity,
                o.status, 
                o.created_at, 
                o.session_id
            FROM orders o
            JOIN stocks s ON o.stock_id = s.id
            LEFT JOIN trades t ON (t.buy_order_id = o.id OR t.sell_order_id = o.id)
            WHERE o.user_id = $1 AND o.status IN ('PENDING', 'PARTIAL')
            GROUP BY o.id, s.symbol
            ORDER BY o.created_at DESC
        `, [userId]);

        return result.rows.map(row => ({
            ...row,
            price: parseFloat(row.execution_price),
            target_price: parseFloat(row.target_price)
        }));
    }
}
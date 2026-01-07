import pool from '../config/database';
import redis from '../config/redis';

export class MatchingEngine {
    static async match(symbol: string) {
        // 1. Ambil harga beli tertinggi (Highest Bid) dan harga jual terendah (Lowest Ask) dari Redis
        const buyQueue = await redis.zrevrange(`orderbook:${symbol}:buy`, 0, 0, 'WITHSCORES');
        const sellQueue = await redis.zrange(`orderbook:${symbol}:sell`, 0, 0, 'WITHSCORES');

        if (buyQueue.length === 0 || sellQueue.length === 0) return;

        const topBuy = JSON.parse(buyQueue[0]);
        const buyPrice = parseFloat(buyQueue[1]);
        const topSell = JSON.parse(sellQueue[0]);
        const sellPrice = parseFloat(sellQueue[1]);

        // 2. Cek apakah harga "jodoh"
        if (buyPrice >= sellPrice) {
            await this.executeTrade(topBuy, topSell, sellPrice, symbol);
        }
    }

    private static async executeTrade(buyOrder: any, sellOrder: any, matchPrice: number, symbol: string) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const matchQty = Math.min(buyOrder.quantity, sellOrder.quantity);

            // 3. Catat di tabel trades
            await client.query(
                'INSERT INTO trades (buy_order_id, sell_order_id, price, quantity) VALUES ($1, $2, $3, $4)',
                [buyOrder.orderId, sellOrder.orderId, matchPrice, matchQty]
            );

            // 4. Update status order di DB
            // Note: Di sini lu bisa tambahin logic buat 'PARTIAL' kalau qty gak habis semua
            await client.query("UPDATE orders SET status = 'MATCHED', remaining_quantity = 0 WHERE id IN ($1, $2)",
                [buyOrder.orderId, sellOrder.orderId]);

            // 5. Update Portfolio Pembeli (Tambah saham)
            await client.query(`
        INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
        VALUES ($1, (SELECT id FROM stocks WHERE symbol = $3), $2, $4)
        ON CONFLICT (user_id, stock_id) DO UPDATE SET 
        quantity_owned = portfolios.quantity_owned + $2
      `, [buyOrder.userId, matchQty, symbol, matchPrice]);

            // 6. Update Saldo Penjual (Tambah duit)
            const totalGain = matchPrice * (matchQty * 100);
            await client.query('UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2',
                [totalGain, sellOrder.userId]);

            await client.query('COMMIT');

            // 7. Hapus dari Redis karena sudah Match
            await redis.zrem(`orderbook:${symbol}:buy`, JSON.stringify(buyOrder));
            await redis.zrem(`orderbook:${symbol}:sell`, JSON.stringify(sellOrder));

            console.log(`✅ MATCH! ${symbol} at ${matchPrice} for ${matchQty} lots`);

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('❌ Matching Error:', err);
        } finally {
            client.release();
        }
    }
}
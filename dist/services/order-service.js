"use strict";
//services/order-service.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderService = void 0;
const database_1 = __importDefault(require("../config/database"));
const redis_1 = __importDefault(require("../config/redis"));
const market_logic_1 = require("../core/market-logic");
const matching_engine_1 = require("../core/matching-engine");
class OrderService {
    static async placeOrder(userId, symbol, type, price, quantity) {
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            // 1. Ambil data saham & harga ARA/ARB sesi ini
            let stockRes = await client.query(`
/* dialect: postgres */
SELECT s.id, d.ara_limit, d.arb_limit, d.session_id, 'OPEN' as session_status
FROM stocks s
JOIN daily_stock_data d ON s.id = d.stock_id
WHERE s.symbol = $1 AND d.session_id = (SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1)
`, [symbol]);
            // Jika pasar TUTUP, ambil data dari sesi TERAKHIR yang sudah close
            let isMarketOpen = true;
            if ((stockRes.rowCount ?? 0) === 0) {
                stockRes = await client.query(`
                    /* dialect: postgres */
                    SELECT s.id, d.ara_limit, d.arb_limit, d.session_id, 'CLOSED' as session_status
                    FROM stocks s
                    JOIN daily_stock_data d ON s.id = d.stock_id
                    WHERE s.symbol = $1
                    ORDER BY d.session_id DESC LIMIT 1
                `, [symbol]);
                if ((stockRes.rowCount ?? 0) === 0)
                    throw new Error('Saham tidak ditemukan');
                isMarketOpen = false;
            }
            const stock = stockRes.rows[0];
            // 2. Validasi Harga (Tick Size & ARA/ARB)
            if (!(0, market_logic_1.isValidTickSize)(price))
                throw new Error('Harga tidak sesuai fraksi (Tick Size)');
            if (price > stock.ara_limit || price < stock.arb_limit)
                throw new Error('Harga melampaui batas ARA/ARB');
            const totalCost = price * (quantity * 100); // Quantity dalam Lot (1 Lot = 100 lembar)
            let avgPriceAtOrder = null;
            if (type === 'BUY') {
                // 3a. BUY: Cek & Potong Saldo RDN (Lock Balance)
                const userRes = await client.query(
                /* sql */ 'SELECT balance_rdn FROM users WHERE id = $1 FOR UPDATE', [userId]);
                if (parseFloat(userRes.rows[0].balance_rdn) < totalCost) {
                    throw new Error('Saldo RDN tidak cukup');
                }
                await client.query('UPDATE users SET balance_rdn = balance_rdn - $1 WHERE id = $2', [totalCost, userId]);
            }
            else if (type === 'SELL') {
                // 3b. SELL: Cek kepemilikan saham
                const portfolioRes = await client.query(`
/* dialect: postgres */
SELECT quantity_owned, avg_buy_price FROM portfolios
WHERE user_id = $1 AND stock_id = $2
FOR UPDATE
`, [userId, stock.id]);
                if ((portfolioRes.rowCount ?? 0) === 0) {
                    throw new Error('Anda tidak memiliki saham ini');
                }
                const ownedQty = parseInt(portfolioRes.rows[0].quantity_owned);
                avgPriceAtOrder = portfolioRes.rows[0].avg_buy_price;
                // Hitung total lot yang sudah masuk antrean jual (Pending/Partial)
                const lockedRes = await client.query(`
/* dialect: postgres */
SELECT SUM(remaining_quantity) as locked_qty
FROM orders
WHERE user_id = $1 AND stock_id = $2 AND type = 'SELL' AND status IN ('PENDING', 'PARTIAL')
`, [userId, stock.id]);
                const lockedQty = parseInt(lockedRes.rows[0].locked_qty || '0');
                if (ownedQty - lockedQty < quantity) {
                    throw new Error(`Jumlah saham tidak cukup. Anda punya ${ownedQty} lot, tapi ${lockedQty} lot sudah ada di antrean jual.`);
                }
                // JANGAN kurangi saham dari portfolio di sini.
            }
            // 4. Simpan Order ke Database (Status PENDING)
            // Jika market closed, tetap simpan tapi jangan masuk Redis dulu.
            // Session ID tetap menggunakan session terakhir (walaupun closed), nanti di-update saat OPEN session baru.
            const orderRes = await client.query(`
/* dialect: postgres */
INSERT INTO orders (user_id, stock_id, session_id, type, price, quantity, remaining_quantity, status, avg_price_at_order)
VALUES ($1, $2, $3, $4, $5, $6, $6, 'PENDING', $7)
RETURNING id
`, [userId, stock.id, stock.session_id, type, price, quantity, avgPriceAtOrder]);
            const orderId = orderRes.rows[0].id;
            await client.query('COMMIT');
            // 5. Jika Market OPEN: Lempar ke Redis buat diolah Matching Engine
            if (isMarketOpen) {
                const timestamp = Date.now();
                const redisPayload = JSON.stringify({
                    orderId,
                    userId,
                    stockId: stock.id,
                    price,
                    quantity,
                    timestamp,
                    remaining_quantity: quantity,
                    avg_price_at_order: avgPriceAtOrder ? parseFloat(avgPriceAtOrder) : undefined
                });
                const redisKey = `orderbook:${symbol}:${type.toLowerCase()}`;
                await redis_1.default.zadd(redisKey, price, redisPayload);
                console.log(`📝 Order placed: ${type} ${symbol} @ ${price} x ${quantity} lots (ID: ${orderId})`);
                // Panggil Engine tanpa await (Background Process)
                matching_engine_1.MatchingEngine.match(symbol);
                console.log(`🚀 Matching Engine triggered for ${symbol}`);
            }
            else {
                console.log(`📝 Offline Order placed: ${type} ${symbol} @ ${price} x ${quantity} lots (ID: ${orderId}) - Waiting for session open`);
            }
            return { orderId, status: 'PENDING', message: 'Order berhasil dipasang' };
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw new Error(err.message);
        }
        finally {
            client.release();
        }
    }
    // Cancel Order yang masih PENDING
    static async cancelOrder(userId, orderId) {
        const client = await database_1.default.connect();
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
                await client.query('UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2', [refundAmount, userId]);
            }
            else if (order.type === 'SELL') {
                // Tidak perlu kembalikan saham ke portfolio karena belum dikurangi saat pasang order
            }
            // 3. Update status order jadi CANCELED
            await client.query("UPDATE orders SET status = 'CANCELED', updated_at = NOW() WHERE id = $1", [orderId]);
            // 4. Hapus dari Redis
            const redisKey = `orderbook:${order.symbol}:${order.type.toLowerCase()}`;
            // Cari dan hapus entry yang cocok
            const allOrders = await redis_1.default.zrange(redisKey, 0, -1);
            for (const orderData of allOrders) {
                const parsed = JSON.parse(orderData);
                if (parsed.orderId === orderId || parsed.orderId === parseInt(orderId)) {
                    await redis_1.default.zrem(redisKey, orderData);
                    break;
                }
            }
            await client.query('COMMIT');
            return { message: 'Order berhasil dibatalkan' };
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw new Error(err.message);
        }
        finally {
            client.release();
        }
    }
    // Ambil history order user (Orders + Dividends)
    static async getOrderHistory(userId) {
        const query = `
            /* dialect: postgres */
            SELECT
                o.id::text,
                s.symbol,
                o.type,
                o.price as target_price,
                COALESCE(AVG(t.price), o.price) as execution_price,
                o.quantity,
                o.remaining_quantity,
                (o.quantity - o.remaining_quantity) as matched_quantity,
                o.status,
                o.created_at,
                o.session_id,
                o.avg_price_at_order,
                0 as dividend_amount
            FROM orders o
            JOIN stocks s ON o.stock_id = s.id
            LEFT JOIN trades t ON (t.buy_order_id = o.id OR t.sell_order_id = o.id)
            WHERE o.user_id = $1
            GROUP BY o.id, s.symbol

            UNION ALL

            SELECT
                da.id::text,
                s.symbol,
                'DIVIDEN' as type,
                0 as target_price,
                0 as execution_price,
                0 as quantity,
                0 as remaining_quantity,
                0 as matched_quantity,
                'MATCHED' as status,
                da.created_at,
                d.session_id,
                0 as avg_price_at_order,
                da.amount as dividend_amount
            FROM dividend_allocations da
            JOIN dividends d ON da.dividend_id = d.id
            JOIN stocks s ON d.stock_id = s.id
            WHERE da.user_id = $1

            ORDER BY created_at DESC
            LIMIT 100
        `;
        const result = await database_1.default.query(query, [userId]);
        return result.rows.map(row => {
            if (row.type === 'DIVIDEN') {
                return {
                    id: row.id,
                    symbol: row.symbol,
                    type: row.type,
                    price: '-',
                    lot: '-',
                    profit_loss: parseFloat(row.dividend_amount),
                    status: row.status,
                    created_at: row.created_at,
                    execution_price: 0 // Frontend might need this or '-'
                };
            }
            const executionPrice = parseFloat(row.execution_price);
            const matchedQuantity = parseInt(row.matched_quantity);
            let profitLoss = null;
            if (row.type === 'SELL' && row.avg_price_at_order && matchedQuantity > 0) {
                const avgBuyPrice = parseFloat(row.avg_price_at_order);
                profitLoss = (executionPrice - avgBuyPrice) * matchedQuantity * 100;
            }
            return {
                ...row,
                price: executionPrice,
                target_price: parseFloat(row.target_price),
                matched_quantity: matchedQuantity,
                profit_loss: profitLoss
            };
        });
    }
    // Ambil order aktif (PENDING/PARTIAL) user
    static async getActiveOrders(userId) {
        const result = await database_1.default.query(`
/* dialect: postgres */
SELECT
o.id,
s.symbol,
o.type,
o.price as target_price,
COALESCE(AVG(t.price), o.price) as execution_price,
o.quantity,
o.remaining_quantity,
(o.quantity - o.remaining_quantity) as matched_quantity,
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
            target_price: parseFloat(row.target_price),
            matched_quantity: parseInt(row.matched_quantity)
        }));
    }
}
exports.OrderService = OrderService;

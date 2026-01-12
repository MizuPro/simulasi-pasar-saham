"use strict";
// src/services/dividend-service.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DividendService = void 0;
const database_1 = __importDefault(require("../config/database"));
class DividendService {
    static async distributeDividend(data) {
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            const { stockId, amountPerShare, sessionId } = data;
            // 1. Get Stock Info
            const stockRes = await client.query('SELECT * FROM stocks WHERE id = $1', [stockId]);
            if (stockRes.rows.length === 0)
                throw new Error('Stock not found');
            const stock = stockRes.rows[0];
            // 2. Identify Shareholders (Cum Date = NOW/Snapshot)
            // We select everyone who has shares > 0 in portfolios
            const shareholders = await client.query('SELECT user_id, quantity_owned FROM portfolios WHERE stock_id = $1 AND quantity_owned > 0', [stockId]);
            if (shareholders.rows.length === 0) {
                throw new Error('Tidak ada pemegang saham untuk didistribusikan dividen');
            }
            let totalPayout = 0;
            const allocations = [];
            // 3. Insert Dividend Record
            const dividendRes = await client.query(`
                INSERT INTO dividends (stock_id, session_id, dividend_per_share, total_payout)
                VALUES ($1, $2, $3, 0)
                RETURNING id
            `, [stockId, sessionId || null, amountPerShare]);
            const dividendId = dividendRes.rows[0].id;
            // 4. Distribute
            for (const holder of shareholders.rows) {
                const qtyLots = parseInt(holder.quantity_owned);
                const qtyShares = qtyLots * 100; // 1 Lot = 100 lembar
                const payout = qtyShares * amountPerShare;
                if (payout > 0) {
                    // Update User Balance
                    await client.query('UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2', [payout, holder.user_id]);
                    // Record Allocation
                    await client.query(`
                        INSERT INTO dividend_allocations (dividend_id, user_id, quantity_owned, amount)
                        VALUES ($1, $2, $3, $4)
                    `, [dividendId, holder.user_id, qtyLots, payout]);
                    totalPayout += payout;
                    allocations.push({ userId: holder.user_id, amount: payout });
                }
            }
            // Update Total Payout
            await client.query('UPDATE dividends SET total_payout = $1 WHERE id = $2', [totalPayout, dividendId]);
            await client.query('COMMIT');
            return {
                stock: stock.symbol,
                dividendPerShare: amountPerShare,
                totalPayout,
                recipients: allocations.length,
                dividendId
            };
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
}
exports.DividendService = DividendService;

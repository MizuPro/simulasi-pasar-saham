"use strict";
// src/services/ipo-service.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPOService = void 0;
const database_1 = __importDefault(require("../config/database"));
class IPOService {
    static async createIPO(data) {
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(`
                INSERT INTO ipos (
                    stock_id, total_shares, offering_price,
                    listing_session_id, start_offering_session_id, end_offering_session_id,
                    status
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
                RETURNING *
            `, [
                data.stockId,
                data.totalShares,
                data.offeringPrice,
                data.listingSessionId || null,
                data.startOfferingSessionId || null,
                data.endOfferingSessionId || null
            ]);
            await client.query('COMMIT');
            return res.rows[0];
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    static async subscribeIPO(userId, ipoId, quantity) {
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            // 1. Get IPO & Validate Session
            const ipoRes = await client.query('SELECT * FROM ipos WHERE id = $1 FOR UPDATE', [ipoId]);
            if (ipoRes.rows.length === 0)
                throw new Error('IPO not found');
            const ipo = ipoRes.rows[0];
            if (ipo.status !== 'ACTIVE' && ipo.status !== 'PENDING') {
                // Or we check sessions dynamically
                // "Sistem IPO nya ... pendaftaran akan ada di session berapa"
                // So we should check current session
            }
            // Get Current Session
            const sessionRes = await client.query('SELECT id, session_number FROM trading_sessions WHERE status IN (\'OPEN\', \'PRE_OPEN\') ORDER BY id DESC LIMIT 1');
            let currentSessionId = 0;
            if (sessionRes.rows.length > 0) {
                currentSessionId = sessionRes.rows[0].id;
            }
            else {
                // Check last closed session? Or just assume 0 if no session is running?
                // Logic: "start_offering_session_id <= current <= end_offering_session_id"
                // Ideally IPO subscription is open even if market is closed IF the "session number" is within range?
                // But usually session ID refers to the specific daily session row.
                // Session IDs are auto-incrementing integers.
                // Let's assume we use the Session ID from DB.
                // If market is closed, we might be "between" sessions or in a closed session state.
                // Let's check the latest session.
                const lastSession = await client.query('SELECT id FROM trading_sessions ORDER BY id DESC LIMIT 1');
                if (lastSession.rows.length > 0)
                    currentSessionId = lastSession.rows[0].id;
            }
            // Check range
            if (ipo.start_offering_session_id && currentSessionId < ipo.start_offering_session_id) {
                throw new Error(`IPO belum dibuka (Start Session ID: ${ipo.start_offering_session_id})`);
            }
            if (ipo.end_offering_session_id && currentSessionId > ipo.end_offering_session_id) {
                throw new Error(`IPO sudah ditutup (End Session ID: ${ipo.end_offering_session_id})`);
            }
            // 2. Check User Balance & Deduct
            const totalCost = parseFloat(ipo.offering_price) * (quantity * 100);
            const userRes = await client.query('SELECT balance_rdn FROM users WHERE id = $1 FOR UPDATE', [userId]);
            if (parseFloat(userRes.rows[0].balance_rdn) < totalCost) {
                throw new Error('Saldo RDN tidak mencukupi untuk memesan IPO ini');
            }
            await client.query('UPDATE users SET balance_rdn = balance_rdn - $1 WHERE id = $2', [totalCost, userId]);
            // 3. Insert Subscription
            // Handle existing subscription? (Add up or overwrite?) -> Usually add up.
            // Using UPSERT
            const subRes = await client.query(`
                INSERT INTO ipo_subscriptions (ipo_id, user_id, quantity, status)
                VALUES ($1, $2, $3, 'PENDING')
                ON CONFLICT (ipo_id, user_id)
                DO UPDATE SET quantity = ipo_subscriptions.quantity + EXCLUDED.quantity
                RETURNING *
            `, [ipoId, userId, quantity]);
            await client.query('COMMIT');
            return subRes.rows[0];
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    static async finalizeIPO(ipoId) {
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            const ipoRes = await client.query('SELECT * FROM ipos WHERE id = $1 FOR UPDATE', [ipoId]);
            const ipo = ipoRes.rows[0];
            if (ipo.status === 'FINALIZED' || ipo.status === 'LISTED') {
                throw new Error('IPO sudah difinalisasi');
            }
            // 1. Calculate Total Subscribed
            const subRes = await client.query('SELECT SUM(quantity) as total_req FROM ipo_subscriptions WHERE ipo_id = $1', [ipoId]);
            const totalRequested = parseInt(subRes.rows[0].total_req || '0');
            const totalAvailable = parseInt(ipo.total_shares);
            const ratio = totalRequested === 0 ? 0 : Math.min(1, totalAvailable / totalRequested);
            // 2. Allocate
            const subscriptions = await client.query('SELECT * FROM ipo_subscriptions WHERE ipo_id = $1', [ipoId]);
            for (const sub of subscriptions.rows) {
                const requested = parseInt(sub.quantity);
                const allocated = Math.floor(requested * ratio);
                const refundQty = requested - allocated;
                const refundAmount = refundQty * parseFloat(ipo.offering_price) * 100;
                // Update Subscription
                await client.query(`
                    UPDATE ipo_subscriptions
                    SET status = 'ALLOCATED', quantity = $1
                    WHERE id = $2
                `, [allocated, sub.id]);
                // Give Shares
                if (allocated > 0) {
                    await client.query(`
                        INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (user_id, stock_id)
                        DO UPDATE SET quantity_owned = portfolios.quantity_owned + EXCLUDED.quantity_owned,
                        avg_buy_price = (portfolios.avg_buy_price * portfolios.quantity_owned + EXCLUDED.avg_buy_price * EXCLUDED.quantity_owned) / (portfolios.quantity_owned + EXCLUDED.quantity_owned)
                    `, [sub.user_id, ipo.stock_id, allocated, ipo.offering_price]);
                }
                // Refund Money
                if (refundAmount > 0) {
                    await client.query('UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2', [refundAmount, sub.user_id]);
                }
            }
            // Update IPO Status
            await client.query("UPDATE ipos SET status = 'FINALIZED' WHERE id = $1", [ipoId]);
            // Also Update Stock Max Shares / Circulating if needed?
            // The `stocks` table has `max_shares` and `total_shares_sold`.
            // IPO shares are technically "Sold" / Issued now.
            // We should assume `stocks.max_shares` was set correctly before IPO.
            await client.query('COMMIT');
            return {
                message: 'IPO Finalized',
                totalRequested,
                totalAvailable,
                ratio,
                subscribers: subscriptions.rowCount
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
    static async getIPOs(status) {
        let query = `
            SELECT i.*, s.symbol, s.name as stock_name
            FROM ipos i
            JOIN stocks s ON i.stock_id = s.id
        `;
        const params = [];
        if (status) {
            query += ` WHERE i.status = $1`;
            params.push(status);
        }
        query += ` ORDER BY i.created_at DESC`;
        const res = await database_1.default.query(query, params);
        return res.rows;
    }
}
exports.IPOService = IPOService;

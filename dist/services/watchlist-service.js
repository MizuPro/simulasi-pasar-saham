"use strict";
//services/watchlist-service.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WatchlistService = void 0;
const database_1 = __importDefault(require("../config/database"));
class WatchlistService {
    // Ambil semua watchlist user
    static async getWatchlist(userId) {
        const result = await database_1.default.query(`
            /* dialect: postgres */
            SELECT
                w.id,
                w.stock_id,
                s.symbol,
                s.name,
                w.created_at
            FROM watchlists w
            JOIN stocks s ON w.stock_id = s.id
            WHERE w.user_id = $1
            ORDER BY w.created_at DESC
        `, [userId]);
        return result.rows;
    }
    // Tambah saham ke watchlist
    static async addToWatchlist(userId, symbol) {
        // Cari stock_id berdasarkan symbol
        const stockRes = await database_1.default.query('SELECT id, symbol, name FROM stocks WHERE symbol = $1 AND is_active = true', [symbol.toUpperCase()]);
        if ((stockRes.rowCount ?? 0) === 0) {
            throw new Error('Saham tidak ditemukan atau tidak aktif');
        }
        const stock = stockRes.rows[0];
        // Insert ke watchlist
        const result = await database_1.default.query(`
            /* dialect: postgres */
            INSERT INTO watchlists (user_id, stock_id)
            VALUES ($1, $2)
            ON CONFLICT (user_id, stock_id) DO NOTHING
            RETURNING id, stock_id, created_at
        `, [userId, stock.id]);
        if ((result.rowCount ?? 0) === 0) {
            throw new Error('Saham sudah ada di watchlist');
        }
        return {
            id: result.rows[0].id,
            stock_id: stock.id,
            symbol: stock.symbol,
            name: stock.name,
            created_at: result.rows[0].created_at
        };
    }
    // Hapus saham dari watchlist
    static async removeFromWatchlist(userId, symbol) {
        // Cari stock_id berdasarkan symbol
        const stockRes = await database_1.default.query('SELECT id FROM stocks WHERE symbol = $1', [symbol.toUpperCase()]);
        if ((stockRes.rowCount ?? 0) === 0) {
            throw new Error('Saham tidak ditemukan');
        }
        const result = await database_1.default.query(`
            /* dialect: postgres */
            DELETE FROM watchlists
            WHERE user_id = $1 AND stock_id = $2
            RETURNING id
        `, [userId, stockRes.rows[0].id]);
        if ((result.rowCount ?? 0) === 0) {
            throw new Error('Saham tidak ada di watchlist');
        }
        return true;
    }
    // Cek apakah saham ada di watchlist user
    static async isInWatchlist(userId, symbol) {
        const stockRes = await database_1.default.query('SELECT id FROM stocks WHERE symbol = $1', [symbol.toUpperCase()]);
        if ((stockRes.rowCount ?? 0) === 0) {
            return false;
        }
        const result = await database_1.default.query(`
            /* dialect: postgres */
            SELECT 1 FROM watchlists
            WHERE user_id = $1 AND stock_id = $2
        `, [userId, stockRes.rows[0].id]);
        return (result.rowCount ?? 0) > 0;
    }
}
exports.WatchlistService = WatchlistService;

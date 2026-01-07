import pool from '../config/database';

export class PortfolioService {
    static async getPortfolio(userId: string) {
        // 1. Ambil Saldo RDN
        const userRes = await pool.query('SELECT balance_rdn, full_name FROM users WHERE id = $1', [userId]);
        const userData = userRes.rows[0];

        // 2. Ambil Daftar Saham (Join ke tabel stocks buat dapet simbolnya)
        const portfolioRes = await pool.query(`
      SELECT p.stock_id, s.symbol, s.name, p.quantity_owned, p.avg_buy_price 
      FROM portfolios p
      JOIN stocks s ON p.stock_id = s.id
      WHERE p.user_id = $1
    `, [userId]);

        return {
            full_name: userData.full_name,
            balance_rdn: parseFloat(userData.balance_rdn),
            stocks: portfolioRes.rows
        };
    }
}
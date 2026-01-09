//servies/market-service.ts

import pool from '../config/database';

export class MarketService {
    static async generateOneMinuteCandles() {
        const client = await pool.connect();
        try {
            console.log('⏳ Generating 1-minute candles...');

            // 1. Ambil semua saham aktif
            const stocks = await client.query('SELECT id, symbol FROM stocks WHERE is_active = true');

            for (const stock of stocks.rows) {
                try {
                    // 2. Ambil trades dalam 1 menit terakhir (Misal sekarang 10:05, ambil data 10:04:00 - 10:04:59)
                    const tradesRes = await client.query(`
                        /* dialect: postgres */
                        SELECT price, quantity, created_at 
                        FROM trades 
                        WHERE sell_order_id IN (SELECT id FROM orders WHERE stock_id = $1)
                        AND created_at >= date_trunc('minute', NOW()) - INTERVAL '1 minute'
                        AND created_at < date_trunc('minute', NOW())
                        ORDER BY created_at ASC
                    `, [stock.id]);

                    const trades = tradesRes.rows;
                    let open, high, low, close, volume;
                    const startTime = new Date();
                    startTime.setMinutes(startTime.getMinutes() - 1);
                    startTime.setSeconds(0);
                    startTime.setMilliseconds(0);

                    if (trades.length > 0) {
                        // KASUS A: Ada Transaksi
                        open = parseFloat(trades[0].price);
                        close = parseFloat(trades[trades.length - 1].price);

                        // Cari High & Low pakai Math.max/min
                        const prices = trades.map((t: any) => parseFloat(t.price));
                        high = Math.max(...prices);
                        low = Math.min(...prices);

                        // Hitung total volume
                        volume = trades.reduce((sum: number, t: any) => sum + t.quantity, 0);
                    } else {
                        // KASUS B: Tidak Ada Transaksi (Gunakan Close candle sebelumnya)
                        const lastCandle = await client.query(`
                            /* dialect: postgres */
                            SELECT close_price FROM stock_candles 
                            WHERE stock_id = $1 
                            ORDER BY start_time DESC LIMIT 1
                        `, [stock.id]);

                        // Null-safe guard: ensure lastCandle is not null/undefined before accessing rowCount
                        if ((lastCandle?.rowCount ?? 0) > 0) {
                            const lastPrice = parseFloat(lastCandle.rows[0].close_price);
                            open = lastPrice;
                            high = lastPrice;
                            low = lastPrice;
                            close = lastPrice;
                            volume = 0;
                        } else {
                            continue; // Belum ada data sama sekali, skip
                        }
                    }

                    // 3. Simpan ke stock_candles (untuk 1-minute raw data)
                    await client.query(`
                        /* dialect: postgres */
                        INSERT INTO stock_candles (stock_id, resolution, open_price, high_price, low_price, close_price, volume, start_time)
                        VALUES ($1, '1M', $2, $3, $4, $5, $6, $7)
                    `, [stock.id, open, high, low, close, volume, startTime]);

                    // 4. Juga simpan ke candles table untuk multi-timeframe support (jika table ada)
                    try {
                        await client.query(`
                            /* dialect: postgres */
                            INSERT INTO candles (stock_id, timeframe, open_price, high_price, low_price, close_price, volume, timestamp)
                            VALUES ($1, '1m', $2, $3, $4, $5, $6, $7)
                            ON CONFLICT (stock_id, timeframe, timestamp) DO UPDATE
                            SET open_price = EXCLUDED.open_price,
                                high_price = EXCLUDED.high_price,
                                low_price = EXCLUDED.low_price,
                                close_price = EXCLUDED.close_price,
                                volume = EXCLUDED.volume
                        `, [stock.id, open, high, low, close, volume, startTime]);
                    } catch (err: any) {
                        // Skip jika table candles belum ada
                        if (err.code !== '42P01') throw err;
                    }

                    console.log(`🕯️ Candle generated for ${stock.symbol}: O:${open} H:${high} L:${low} C:${close} V:${volume}`);
                } catch (stockErr) {
                    console.error(`❌ Error processing stock ${stock.symbol}:`, stockErr);
                    // Continue to next stock
                }
            }

            // 5. Generate candles untuk timeframe lain (5m, 15m, 1h, 1d)
            await this.aggregateCandles(client);
        } catch (err) {
            console.error('❌ Error generating candles:', err);
        } finally {
            // CRITICAL: Always release the client
            client.release();
        }
    }

    // Aggregate candles dari 1m ke timeframe yang lebih besar
    private static async aggregateCandles(client: any) {
        try {
            const timeframes = [
                { name: '5m', minutes: 5 },
                { name: '15m', minutes: 15 },
                { name: '1h', minutes: 60 },
                { name: '1d', minutes: 1440 }
            ];

            const stocks = await client.query('SELECT id FROM stocks WHERE is_active = true');

            for (const stock of stocks.rows) {
                for (const tf of timeframes) {
                    // Ambil candles 1m dalam range waktu tertentu
                    const now = new Date();
                    const interval = tf.minutes;
                    const startOfPeriod = new Date(now);
                    startOfPeriod.setMinutes(Math.floor(now.getMinutes() / interval) * interval - interval, 0, 0);
                    const endOfPeriod = new Date(startOfPeriod);
                    endOfPeriod.setMinutes(startOfPeriod.getMinutes() + interval);

                    const candlesRes = await client.query(`
                        /* dialect: postgres */
                        SELECT 
                            (array_agg(open_price ORDER BY timestamp ASC))[1] as open,
                            MAX(high_price) as high,
                            MIN(low_price) as low,
                            (array_agg(close_price ORDER BY timestamp DESC))[1] as close,
                            SUM(volume) as volume
                        FROM candles
                        WHERE stock_id = $1 
                        AND timeframe = '1m'
                        AND timestamp >= $2 
                        AND timestamp < $3
                    `, [stock.id, startOfPeriod, endOfPeriod]);

                    const candle = candlesRes.rows[0];
                    if (candle && candle.open) {
                        await client.query(`
                            /* dialect: postgres */
                            INSERT INTO candles (stock_id, timeframe, open_price, high_price, low_price, close_price, volume, timestamp)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            ON CONFLICT (stock_id, timeframe, timestamp) DO UPDATE
                            SET open_price = EXCLUDED.open_price,
                                high_price = EXCLUDED.high_price,
                                low_price = EXCLUDED.low_price,
                                close_price = EXCLUDED.close_price,
                                volume = EXCLUDED.volume
                        `, [stock.id, tf.name, candle.open, candle.high, candle.low, candle.close, candle.volume || 0, startOfPeriod]);
                    }
                }
            }
        } catch (err: any) {
            // Skip jika table candles belum ada
            if (err.code !== '42P01') {
                console.error('Error aggregating candles:', err.message);
            }
        }
    }

    // Fungsi buat API ambil data grafik dari stock_candles (backward compatible)
    static async getCandles(symbol: string, timeframe: string = '1m', limit: number = 1000) {
        try {
            // Coba query dari table candles (multi-timeframe support)
            const result = await pool.query(`
                /* dialect: postgres */
                SELECT 
                    extract(epoch from timestamp) * 1000 as time,
                    open_price as open, 
                    high_price as high, 
                    low_price as low, 
                    close_price as close,
                    volume
                FROM candles c
                JOIN stocks s ON c.stock_id = s.id
                WHERE s.symbol = $1
                AND c.timeframe = $2
                ORDER BY timestamp ASC
                LIMIT $3
            `, [symbol, timeframe, limit]);

            return result.rows;
        } catch (err: any) {
            // Fallback ke stock_candles jika table candles belum ada
            if (err.code === '42P01') { // Table doesn't exist
                console.warn('⚠️ Table candles tidak ditemukan, fallback ke stock_candles');
                const result = await pool.query(`
                    /* dialect: postgres */
                    SELECT 
                        extract(epoch from start_time) * 1000 as time,
                        open_price as open, 
                        high_price as high, 
                        low_price as low, 
                        close_price as close,
                        volume
                    FROM stock_candles sc
                    JOIN stocks s ON sc.stock_id = s.id
                    WHERE s.symbol = $1
                    ORDER BY start_time ASC
                    LIMIT $2
                `, [symbol, limit]);

                return result.rows;
            }
            throw err;
        }
    }

    // Fungsi untuk mengambil daily stock data (OHLC per session)
    static async getDailyStockData(symbol?: string) {
        let query = `
            /* dialect: postgres */
            SELECT 
                s.symbol,
                s.name,
                ts.session_number,
                ts.status as session_status,
                ts.started_at,
                ts.ended_at,
                d.prev_close,
                d.open_price,
                d.high_price,
                d.low_price,
                d.close_price,
                d.ara_limit,
                d.arb_limit,
                d.volume
            FROM daily_stock_data d
            JOIN stocks s ON d.stock_id = s.id
            JOIN trading_sessions ts ON d.session_id = ts.id
        `;

        const params: any[] = [];
        if (symbol) {
            query += ' WHERE s.symbol = $1';
            params.push(symbol);
        }

        query += ' ORDER BY ts.session_number DESC, s.symbol ASC LIMIT 100';

        const result = await pool.query(query, params);
        return result.rows;
    }
}
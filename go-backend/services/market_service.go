package services

import (
	"context"
	"log"
	"time"

	"mbit-backend-go/config"

	"github.com/jackc/pgx/v5"
)

type MarketService struct{}

func (s *MarketService) GenerateOneMinuteCandles() error {
	ctx := context.Background()

	// Get active session
	var sessionId int
	err := config.DB.QueryRow(ctx, "SELECT id FROM trading_sessions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1").Scan(&sessionId)
	if err == pgx.ErrNoRows {
		// No open session, skip
		return nil
	} else if err != nil {
		return err
	}

	// Logic from src/services/market-service.ts
	// Aggregate trades from the last minute (or specific time window)
	// Node implementation usually truncates time to minute.

	now := time.Now()
	// Format to start of current minute (or previous minute?)
	// Cron runs at minute start. Usually we generate for the *previous* minute.
	// e.g. at 10:01:00 we generate for 10:00:00 - 10:00:59.

	prevMinute := now.Add(-1 * time.Minute).Truncate(time.Minute)

	log.Printf("🕯️ Generating candles for %s...", prevMinute)

	// 1. Get stocks with trades in that minute
	// We can do this in one big SQL query.

	// Note: Schema `stock_candles` index might be unique on (stock_id, resolution, start_time) ??
	// Check schema: `create unique index candles_stock_id_timeframe_timestamp_key on candles ...`
	// Wait, table is `candles` or `stock_candles`?
	// Schema has `candles` AND `stock_candles`.
	// Node `MarketService` uses which one?
	// `tes-canle.http` implies `candles`.
	// `db/ALL_schema_database.sql` has both.
	// `candles` table has `timeframe` column. `stock_candles` has `resolution`.
	// Node cron says `MarketService.generateOneMinuteCandles()`.
	// I'll check `db/migration_add_candles_watchlist.sql` or similar if I could.
	// But `candles` seems to be the one with `timeframe` varchar(10).
	// Let's assume `candles` table is the modern one.

	// Re-writing query for `candles` table
	queryCandles := `
		INSERT INTO candles (stock_id, session_id, timeframe, timestamp, open_price, high_price, low_price, close_price, volume)
		SELECT
			t.stock_id,
			$1,
			'1M',
			$2,
			(SELECT price FROM trades t2 WHERE t2.stock_id = t.stock_id AND t2.executed_at >= $2 AND t2.executed_at < $2 + interval '1 minute' ORDER BY t2.executed_at ASC LIMIT 1),
			MAX(t.price),
			MIN(t.price),
			(SELECT price FROM trades t3 WHERE t3.stock_id = t.stock_id AND t3.executed_at >= $2 AND t3.executed_at < $2 + interval '1 minute' ORDER BY t3.executed_at DESC LIMIT 1),
			SUM(t.quantity)
		FROM trades t
		WHERE t.executed_at >= $2 AND t.executed_at < $2 + interval '1 minute'
		GROUP BY t.stock_id
		ON CONFLICT (stock_id, timeframe, timestamp) DO NOTHING
	`

	tag, err := config.DB.Exec(ctx, queryCandles, sessionId, prevMinute)
	if err != nil {
		log.Printf("❌ Candle generation failed: %v", err)
		return err
	}

	log.Printf("✅ Generated %d candles", tag.RowsAffected())
	return nil
}

var GlobalMarketService = &MarketService{}

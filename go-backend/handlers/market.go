package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"mbit-backend-go/config"
	"mbit-backend-go/core/engine"
	"mbit-backend-go/models"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
)

// GetStocks returns list of all stocks
func GetStocks(c *fiber.Ctx) error {
	// Need to join with daily_stock_data to get prices.
	// Assume latest session or just latest data.
	query := `
		SELECT
			s.id, s.symbol, s.name, s.max_shares, s.is_active,
			(SELECT COALESCE(SUM(quantity_owned), 0) FROM portfolios WHERE stock_id = s.id) as total_shares,
			COALESCE(d.close_price, d.prev_close, 1000) as current_price,
			COALESCE(d.prev_close, 1000) as prev_close,
			COALESCE(d.ara_limit, 0) as ara,
			COALESCE(d.arb_limit, 0) as arb,
			COALESCE(d.volume, 0) as volume
		FROM stocks s
		LEFT JOIN daily_stock_data d ON s.id = d.stock_id
		AND d.session_id = (SELECT id FROM trading_sessions ORDER BY id DESC LIMIT 1)
		WHERE s.is_active = true
		ORDER BY s.symbol ASC
	`
	rows, err := config.DB.Query(context.Background(), query)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Gagal mengambil data saham"})
	}
	defer rows.Close()

	type StockResponse struct {
		ID            int     `json:"id"`
		Symbol        string  `json:"symbol"`
		Name          string  `json:"name"`
		IsActive      bool    `json:"is_active"`
		MaxShares     int64   `json:"max_shares"`
		TotalShares   int64   `json:"total_shares"`
		LastPrice     float64 `json:"lastPrice"`
		PrevClose     float64 `json:"prevClose"`
		Change        float64 `json:"change"`
		ChangePercent float64 `json:"changePercent"`
		ARA           float64 `json:"ara"`
		ARB           float64 `json:"arb"`
		Volume        int64   `json:"volume"`
	}

	var stocks []StockResponse
	for rows.Next() {
		var s StockResponse
		if err := rows.Scan(
			&s.ID, &s.Symbol, &s.Name, &s.MaxShares, &s.IsActive,
			&s.TotalShares,
			&s.LastPrice, &s.PrevClose,
			&s.ARA, &s.ARB, &s.Volume,
		); err != nil {
			continue
		}

		s.Change = s.LastPrice - s.PrevClose
		if s.PrevClose > 0 {
			s.ChangePercent = (s.Change / s.PrevClose) * 100
		}

		stocks = append(stocks, s)
	}

	return c.JSON(stocks)
}

// GetMarketTicker returns market ticker (price changes)
func GetMarketTicker(c *fiber.Ctx) error {
	query := `
		SELECT
			s.symbol,
			s.name,
			COALESCE(d.close_price, d.prev_close, 0) as current_price,
			COALESCE(d.prev_close, 0) as initial_price
		FROM stocks s
		LEFT JOIN daily_stock_data d ON s.id = d.stock_id
		AND d.session_id = (SELECT id FROM trading_sessions ORDER BY id DESC LIMIT 1)
		WHERE s.is_active = true
		ORDER BY s.symbol ASC
	`
	rows, err := config.DB.Query(context.Background(), query)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Gagal mengambil ticker market"})
	}
	defer rows.Close()

	type TickerItem struct {
		Symbol           string  `json:"symbol"`
		CompanyName      string  `json:"company_name"`
		Price            float64 `json:"price"`
		ChangePercentage float64 `json:"change_percentage"`
		ChangePoint      float64 `json:"change_point"`
		Trend            string  `json:"trend"`
	}

	var ticker []TickerItem
	for rows.Next() {
		var t TickerItem
		var initPrice float64
		if err := rows.Scan(&t.Symbol, &t.CompanyName, &t.Price, &initPrice); err != nil {
			continue
		}

		t.ChangePoint = t.Price - initPrice
		if initPrice > 0 {
			t.ChangePercentage = (t.ChangePoint / initPrice) * 100
		}

		if t.ChangePoint > 0 {
			t.Trend = "up"
		} else if t.ChangePoint < 0 {
			t.Trend = "down"
		} else {
			t.Trend = "neutral"
		}

		ticker = append(ticker, t)
	}

	return c.JSON(ticker)
}

// GetOrderBook (Depth)
func GetOrderBook(c *fiber.Ctx) error {
	symbol := c.Params("symbol")
	if symbol == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Symbol harus diisi"})
	}

	getDepth := func(side string) ([]map[string]interface{}, error) {
		key := fmt.Sprintf("orderbook:%s:%s", symbol, side)
		var results []redis.Z
		var err error

		if side == "buy" {
			results, err = config.RedisMain.ZRevRangeWithScores(context.Background(), key, 0, 19).Result()
		} else {
			results, err = config.RedisMain.ZRangeWithScores(context.Background(), key, 0, 19).Result()
		}

		if err != nil {
			return nil, err
		}

		// Aggregate by price to hide individual orders (Security & Frontend Req)
		type AggregatedLevel struct {
			Price    float64 `json:"price"`
			TotalQty int64   `json:"totalQty"`
			Count    int     `json:"count"`
		}

		// Actually, let's just loop and aggregate sequentially since Redis result is sorted.
		var finalDepth []map[string]interface{}
		if len(results) > 0 {
			var current *AggregatedLevel

			for _, z := range results {
				var data models.RedisOrderData
				str, ok := z.Member.(string)
				if !ok { continue }
				if err := json.Unmarshal([]byte(str), &data); err != nil || data.RemainingQuantity <= 0 { continue }

				if current == nil || current.Price != z.Score {
					if current != nil {
						finalDepth = append(finalDepth, map[string]interface{}{"price": current.Price, "totalQty": current.TotalQty, "count": current.Count})
					}
					current = &AggregatedLevel{Price: z.Score, TotalQty: 0, Count: 0}
				}
				current.TotalQty += data.RemainingQuantity
				current.Count++
			}
			if current != nil {
				finalDepth = append(finalDepth, map[string]interface{}{"price": current.Price, "totalQty": current.TotalQty, "count": current.Count})
			}
		}

		return finalDepth, nil
	}

	buyDepth, _ := getDepth("buy")
	sellDepth, _ := getDepth("sell")

	return c.JSON(fiber.Map{
		"symbol": symbol,
		"bids":   buyDepth,
		"asks":   sellDepth,
	})
}

// GetCandles returns OHLC data
func GetCandles(c *fiber.Ctx) error {
	symbol := c.Params("symbol")
	timeframe := c.Query("timeframe", "1m")
	limit := c.QueryInt("limit", 1000)

	var stockId int
	err := config.DB.QueryRow(context.Background(), "SELECT id FROM stocks WHERE symbol = $1", symbol).Scan(&stockId)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "Saham tidak ditemukan"})
	}

	rows, err := config.DB.Query(context.Background(), `
		SELECT
			EXTRACT(EPOCH FROM timestamp) * 1000,
			open_price, high_price, low_price, close_price, volume, session_id
		FROM candles
		WHERE stock_id = $1 AND timeframe = $2
		ORDER BY timestamp DESC
		LIMIT $3
	`, stockId, timeframe, limit)

	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type Candle struct {
		Time      float64 `json:"time"`
		Open      float64 `json:"open"`
		High      float64 `json:"high"`
		Low       float64 `json:"low"`
		Close     float64 `json:"close"`
		Volume    int64   `json:"volume"`
		SessionID *int    `json:"session_id"`
	}

	var candles []Candle
	for rows.Next() {
		var c Candle
		if err := rows.Scan(&c.Time, &c.Open, &c.High, &c.Low, &c.Close, &c.Volume, &c.SessionID); err == nil {
			candles = append(candles, c)
		}
	}

	// Reverse to ASC for frontend
	for i, j := 0, len(candles)-1; i < j; i, j = i+1, j-1 {
		candles[i], candles[j] = candles[j], candles[i]
	}

	return c.JSON(candles)
}

// GetDailyData returns historical session data for all stocks
func GetDailyData(c *fiber.Ctx) error {
	query := `
		SELECT
			s.symbol, s.name,
			ts.session_number, ts.status, ts.started_at, ts.ended_at,
			d.prev_close, d.open_price, d.high_price, d.low_price, d.close_price,
			d.ara_limit, d.arb_limit, d.volume
		FROM daily_stock_data d
		JOIN stocks s ON d.stock_id = s.id
		JOIN trading_sessions ts ON d.session_id = ts.id
		ORDER BY ts.session_number DESC, s.symbol ASC
	`
	rows, err := config.DB.Query(context.Background(), query)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type DailyData struct {
		Symbol        string  `json:"symbol"`
		Name          string  `json:"name"`
		SessionNumber int     `json:"session_number"`
		SessionStatus string  `json:"session_status"`
		StartedAt     string  `json:"started_at"`
		EndedAt       *string `json:"ended_at"`
		PrevClose     float64 `json:"prev_close"`
		OpenPrice     float64 `json:"open_price"`
		HighPrice     *float64 `json:"high_price,omitempty"`
		LowPrice      *float64 `json:"low_price,omitempty"`
		ClosePrice    float64 `json:"close_price"`
		AraLimit      float64 `json:"ara_limit"`
		ArbLimit      float64 `json:"arb_limit"`
		Volume        int64   `json:"volume"`
	}

	var results []DailyData
	for rows.Next() {
		var d DailyData
		if err := rows.Scan(
			&d.Symbol, &d.Name,
			&d.SessionNumber, &d.SessionStatus, &d.StartedAt, &d.EndedAt,
			&d.PrevClose, &d.OpenPrice, &d.HighPrice, &d.LowPrice, &d.ClosePrice,
			&d.AraLimit, &d.ArbLimit, &d.Volume,
		); err == nil {
			results = append(results, d)
		}
	}
	return c.JSON(results)
}

// GetDailyDataBySymbol returns historical data for a specific stock
func GetDailyDataBySymbol(c *fiber.Ctx) error {
	symbol := c.Params("symbol")
	query := `
		SELECT
			s.symbol, s.name,
			ts.session_number, ts.status, ts.started_at, ts.ended_at,
			d.prev_close, d.open_price, d.high_price, d.low_price, d.close_price,
			d.ara_limit, d.arb_limit, d.volume
		FROM daily_stock_data d
		JOIN stocks s ON d.stock_id = s.id
		JOIN trading_sessions ts ON d.session_id = ts.id
		WHERE s.symbol = $1
		ORDER BY ts.session_number DESC
	`
	rows, err := config.DB.Query(context.Background(), query, symbol)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	// Same struct as above
	type DailyData struct {
		Symbol        string  `json:"symbol"`
		Name          string  `json:"name"`
		SessionNumber int     `json:"session_number"`
		SessionStatus string  `json:"session_status"`
		StartedAt     string  `json:"started_at"`
		EndedAt       *string `json:"ended_at"`
		PrevClose     float64 `json:"prev_close"`
		OpenPrice     float64 `json:"open_price"`
		HighPrice     *float64 `json:"high_price,omitempty"`
		LowPrice      *float64 `json:"low_price,omitempty"`
		ClosePrice    float64 `json:"close_price"`
		AraLimit      float64 `json:"ara_limit"`
		ArbLimit      float64 `json:"arb_limit"`
		Volume        int64   `json:"volume"`
	}

	var results []DailyData
	for rows.Next() {
		var d DailyData
		if err := rows.Scan(
			&d.Symbol, &d.Name,
			&d.SessionNumber, &d.SessionStatus, &d.StartedAt, &d.EndedAt,
			&d.PrevClose, &d.OpenPrice, &d.HighPrice, &d.LowPrice, &d.ClosePrice,
			&d.AraLimit, &d.ArbLimit, &d.Volume,
		); err == nil {
			results = append(results, d)
		}
	}
	return c.JSON(results)
}

// GetOrderQueue returns specific queue details (FIFO)
func GetOrderQueue(c *fiber.Ctx) error {
	symbol := c.Params("symbol")
	price := c.QueryFloat("price", 0)
	if price == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "Price parameter required"})
	}

	ctx := context.Background()

	// Check Buy
	buyRes, _ := config.RedisMain.ZRangeByScore(ctx, "orderbook:"+symbol+":buy", &redis.ZRangeBy{
		Min: fmt.Sprintf("%f", price),
		Max: fmt.Sprintf("%f", price),
	}).Result()

	// Check Sell
	sellRes, _ := config.RedisMain.ZRangeByScore(ctx, "orderbook:"+symbol+":sell", &redis.ZRangeBy{
		Min: fmt.Sprintf("%f", price),
		Max: fmt.Sprintf("%f", price),
	}).Result()

	var queue []map[string]interface{}

	parse := func(strs []string, side string) {
		for _, s := range strs {
			var data models.RedisOrderData
			if err := json.Unmarshal([]byte(s), &data); err == nil && data.RemainingQuantity > 0 {
				queue = append(queue, map[string]interface{}{
					"orderId": data.OrderId,
					"userId": data.UserId,
					"quantity": data.Quantity,
					"remaining_quantity": data.RemainingQuantity,
					"timestamp": data.Timestamp,
					"side": side,
				})
			}
		}
	}

	parse(buyRes, "BUY")
	parse(sellRes, "SELL")

	// Sort by timestamp ASC
	sort.Slice(queue, func(i, j int) bool {
		return queue[i]["timestamp"].(int64) < queue[j]["timestamp"].(int64)
	})

	return c.JSON(fiber.Map{
		"symbol": symbol,
		"price": price,
		"queue": queue,
	})
}

// GetIEP returns Indicative Equilibrium Price
func GetIEP(c *fiber.Ctx) error {
	symbol := c.Params("symbol")

	// Check session status
	if engine.Engine.SessionStatus == engine.StatusOpen || engine.Engine.SessionStatus == engine.StatusClosed {
		 return c.JSON(fiber.Map{
			 "symbol": symbol,
			 "iep": nil,
			 "volume": 0,
			 "surplus": 0,
			 "status": engine.Engine.SessionStatus,
		 })
	}

	iep, err := engine.GlobalIEPEngine.CalculateIEP(symbol)
	if err != nil {
		// Log error but return null iep
		return c.JSON(fiber.Map{
			"symbol": symbol,
			"iep": nil,
			"volume": 0,
			"surplus": 0,
			"status": engine.Engine.SessionStatus,
		})
	}

	res := fiber.Map{
		"symbol": symbol,
		"status": engine.Engine.SessionStatus,
	}
	if iep != nil {
		res["iep"] = iep.Price
		res["volume"] = iep.MatchedVolume
		res["surplus"] = iep.Surplus
	} else {
		res["iep"] = nil
		res["volume"] = 0
		res["surplus"] = 0
	}

	return c.JSON(res)
}

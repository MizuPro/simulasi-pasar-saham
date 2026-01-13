package handlers

import (
	"context"
	"fmt"

	"mbit-backend-go/config"
	"mbit-backend-go/models"

	"encoding/json"

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
			COALESCE(d.close_price, 0) as current_price,
			COALESCE(d.prev_close, 0) as initial_price
		FROM stocks s
		LEFT JOIN daily_stock_data d ON s.id = d.stock_id
		AND d.session_id = (SELECT id FROM trading_sessions ORDER BY id DESC LIMIT 1)
		ORDER BY s.symbol ASC
	`
	rows, err := config.DB.Query(context.Background(), query)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Gagal mengambil data saham"})
	}
	defer rows.Close()

	var stocks []models.Stock
	for rows.Next() {
		var s models.Stock
		var isActive bool
		if err := rows.Scan(&s.ID, &s.Symbol, &s.CompanyName, &s.TotalShares, &isActive, &s.CurrentPrice, &s.InitialPrice); err != nil {
			continue
		}
		if isActive {
			s.Status = "ACTIVE"
		} else {
			s.Status = "SUSPENDED"
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

		priceMap := make(map[float64]*AggregatedLevel)

		for _, z := range results {
			var data models.RedisOrderData
			str, ok := z.Member.(string)
			if !ok { continue }

			if err := json.Unmarshal([]byte(str), &data); err == nil {
				qty := data.RemainingQuantity
				if qty <= 0 { continue }

				if _, exists := priceMap[z.Score]; !exists {
					priceMap[z.Score] = &AggregatedLevel{Price: z.Score, TotalQty: 0, Count: 0}
				}
				priceMap[z.Score].TotalQty += qty
				priceMap[z.Score].Count++
			}
		}

		// Convert map to slice
		var depth []map[string]interface{}
		for _, level := range priceMap {
			depth = append(depth, map[string]interface{}{
				"price":    level.Price,
				"totalQty": level.TotalQty,
				"count":    level.Count,
			})
		}

		// Sort
		// Note: Map iteration is random, but frontend/Redis usually expects sorted.
		// However, API consumers usually sort themselves or expect sorted.
		// Since we used ZRange/ZRevRange, Redis returned sorted. But Map destroyed it.
		// We should re-sort or use a slice + checking last element.
		// Simple approach: Use slice directly.

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

package handlers

import (
	"context"

	"mbit-backend-go/config"
	"mbit-backend-go/models"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
)

// GetPortfolio returns user portfolio
func GetPortfolio(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)

	// Fetch User Balance & Name
	var fullName string
	var balanceRdn float64
	err := config.DB.QueryRow(context.Background(), "SELECT full_name, balance_rdn FROM users WHERE id = $1", userId).Scan(&fullName, &balanceRdn)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "User not found"})
	}

	query := `
		SELECT
			p.user_id,
			p.stock_id,
			s.symbol,
			p.quantity_owned,
			p.avg_buy_price,
			COALESCE(d.close_price, d.prev_close, 1000) as current_price
		FROM portfolios p
		JOIN stocks s ON p.stock_id = s.id
		LEFT JOIN daily_stock_data d ON s.id = d.stock_id AND d.session_id = (SELECT id FROM trading_sessions WHERE status IN ('OPEN', 'LOCKED', 'PRE_OPEN') ORDER BY id DESC LIMIT 1)
		WHERE p.user_id = $1 AND p.quantity_owned > 0
	`

	rows, err := config.DB.Query(context.Background(), query, userId)
	if err != nil && err != pgx.ErrNoRows {
		return c.Status(500).JSON(fiber.Map{"error": "Gagal mengambil portfolio"})
	}
	defer rows.Close()

	var portfolio []models.PortfolioItem
	for rows.Next() {
		var item models.PortfolioItem

		if err := rows.Scan(
			&item.UserID,
			&item.StockID,
			&item.Symbol,
			&item.Quantity,
			&item.AveragePrice,
			&item.CurrentPrice,
		); err != nil {
			continue
		}

		// Calculate Unrealized P/L: (Current Price - Avg Buy Price) * Lots * 100 (shares per lot)
		item.UnrealizedPL = (item.CurrentPrice - item.AveragePrice) * float64(item.Quantity) * 100

		portfolio = append(portfolio, item)
	}

	if portfolio == nil {
		portfolio = []models.PortfolioItem{}
	}

	return c.JSON(fiber.Map{
		"full_name":   fullName,
		"balance_rdn": balanceRdn,
		"stocks":      portfolio,
	})
}

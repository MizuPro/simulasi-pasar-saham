package handlers

import (
	"context"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/services"

	"github.com/gofiber/fiber/v2"
)

type PlaceOrderRequest struct {
	Symbol   string  `json:"symbol"`
	Type     string  `json:"type"`
	Price    float64 `json:"price"`
	Quantity int64   `json:"quantity"`
}

func PlaceOrder(c *fiber.Ctx) error {
	var req PlaceOrderRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	userId := c.Locals("userId").(string)

	order, err := services.GlobalOrderService.PlaceOrder(userId, req.Symbol, req.Type, req.Price, req.Quantity)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{
		"message": "Order " + req.Type + " berhasil ditempatkan", // Match Node response
		"orderId": order.ID,
	})
}

func CancelOrder(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)
	orderId := c.Params("id")

	if err := services.GlobalOrderService.CancelOrder(userId, orderId); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{"message": "Order berhasil dibatalkan"})
}

// GetOrderHistory returns all matched/canceled/rejected orders
func GetOrderHistory(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)

	query := `
		SELECT
			o.id,
			s.symbol,
			o.session_id,
			o.type,
			o.price as target_price,
			o.price as execution_price, -- Approximated if not stored separately per trade aggregation
			o.quantity,
			o.remaining_quantity,
			o.status,
			o.created_at,
			o.avg_price_at_order
		FROM orders o
		JOIN stocks s ON o.stock_id = s.id
		WHERE o.user_id = $1
		ORDER BY o.created_at DESC
	`
	rows, err := config.DB.Query(context.Background(), query, userId)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type OrderHistoryItem struct {
		ID               string    `json:"id"`
		Symbol           string    `json:"symbol"`
		SessionID        *int      `json:"session_id"`
		Type             string    `json:"type"`
		TargetPrice      float64   `json:"target_price"`
		ExecutionPrice   float64   `json:"execution_price"`
		Price            float64   `json:"price"` // alias for execution_price
		Quantity         int64     `json:"quantity"`
		RemainingQty     int64     `json:"remaining_quantity"`
		MatchedQty       int64     `json:"matched_quantity"`
		Status           string    `json:"status"`
		CreatedAt        time.Time `json:"created_at"`
		ProfitLoss       *float64  `json:"profit_loss,omitempty"`
	}

	var history []OrderHistoryItem
	for rows.Next() {
		var o OrderHistoryItem
		var avgPrice *float64
		if err := rows.Scan(
			&o.ID, &o.Symbol, &o.SessionID, &o.Type, &o.TargetPrice, &o.ExecutionPrice,
			&o.Quantity, &o.RemainingQty, &o.Status, &o.CreatedAt, &avgPrice,
		); err == nil {
			o.Price = o.ExecutionPrice
			o.MatchedQty = o.Quantity - o.RemainingQty

			// Calculate PnL for SELL orders
			if o.Type == "SELL" && avgPrice != nil && o.MatchedQty > 0 {
				pl := (o.ExecutionPrice - *avgPrice) * float64(o.MatchedQty) * 100 // 100 shares/lot
				o.ProfitLoss = &pl
			}
			history = append(history, o)
		}
	}

	return c.JSON(history)
}

// GetActiveOrders returns PENDING and PARTIAL orders
func GetActiveOrders(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)

	query := `
		SELECT
			o.id,
			s.symbol,
			o.session_id,
			o.type,
			o.price as target_price,
			o.price,
			o.quantity,
			o.remaining_quantity,
			o.status,
			o.created_at
		FROM orders o
		JOIN stocks s ON o.stock_id = s.id
		WHERE o.user_id = $1 AND o.status IN ('PENDING', 'PARTIAL')
		ORDER BY o.created_at DESC
	`
	rows, err := config.DB.Query(context.Background(), query, userId)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type ActiveOrderItem struct {
		ID               string    `json:"id"`
		Symbol           string    `json:"symbol"`
		SessionID        *int      `json:"session_id"`
		Type             string    `json:"type"`
		TargetPrice      float64   `json:"target_price"`
		Price            float64   `json:"price"`
		Quantity         int64     `json:"quantity"`
		RemainingQty     int64     `json:"remaining_quantity"`
		MatchedQty       int64     `json:"matched_quantity"`
		Status           string    `json:"status"`
		CreatedAt        time.Time `json:"created_at"`
		ExecutionPrice   float64   `json:"execution_price"` // For compatibility
	}

	var active []ActiveOrderItem
	for rows.Next() {
		var o ActiveOrderItem
		if err := rows.Scan(
			&o.ID, &o.Symbol, &o.SessionID, &o.Type, &o.TargetPrice, &o.Price,
			&o.Quantity, &o.RemainingQty, &o.Status, &o.CreatedAt,
		); err == nil {
			o.ExecutionPrice = o.Price
			o.MatchedQty = o.Quantity - o.RemainingQty
			active = append(active, o)
		}
	}

	return c.JSON(active)
}

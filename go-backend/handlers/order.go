package handlers

import (
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
		"orderId": order.ID,
		"status":  order.Status,
		"message": "Order berhasil dipasang",
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

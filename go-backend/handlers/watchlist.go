package handlers

import (
	"mbit-backend-go/services"

	"github.com/gofiber/fiber/v2"
)

func GetWatchlist(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)

	items, err := services.GlobalWatchlistService.GetWatchlist(userId)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Gagal mengambil watchlist"})
	}

	return c.JSON(items)
}

func AddToWatchlist(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)
	var req struct {
		Symbol string `json:"symbol"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	if req.Symbol == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Symbol wajib diisi"})
	}

	item, err := services.GlobalWatchlistService.AddToWatchlist(userId, req.Symbol)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(201).JSON(fiber.Map{
		"message": "Saham berhasil ditambahkan ke watchlist",
		"item":    item,
	})
}

func RemoveFromWatchlist(c *fiber.Ctx) error {
	userId := c.Locals("userId").(string)
	symbol := c.Params("symbol")

	if symbol == "" {
		return c.Status(400).JSON(fiber.Map{"error": "Symbol wajib diisi"})
	}

	err := services.GlobalWatchlistService.RemoveFromWatchlist(userId, symbol)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{"message": "Saham berhasil dihapus dari watchlist"})
}

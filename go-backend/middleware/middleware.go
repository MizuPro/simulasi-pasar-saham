package middleware

import (
	"strings"
	"time"

	"mbit-backend-go/config"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/golang-jwt/jwt/v5"
)

// AuthMiddleware validates the JWT token
func AuthMiddleware(c *fiber.Ctx) error {
	authHeader := c.Get("Authorization")
	if authHeader == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Missing Authorization Header"})
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid Authorization Header Format"})
	}

	tokenStr := parts[1]
	secret := config.GetEnv("JWT_SECRET", "rahasiakitabersama123") // Default fallback if not in env

	token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fiber.NewError(fiber.StatusUnauthorized, "Unexpected signing method")
		}
		return []byte(secret), nil
	})

	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid or Expired Token"})
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Invalid Token Claims"})
	}

	// Set userId and role in locals
	c.Locals("userId", claims["userId"])
	c.Locals("role", claims["role"])

	return c.Next()
}

// AdminAuthMiddleware ensures the user has ADMIN role
func AdminAuthMiddleware(c *fiber.Ctx) error {
	role := c.Locals("role")
	if role != "ADMIN" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Admin access required"})
	}
	return c.Next()
}

// Rate Limiters

// AuthLimiter: 200 req/min
func NewAuthLimiter() fiber.Handler {
	return limiter.New(limiter.Config{
		Max:        200,
		Expiration: 1 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": "Terlalu banyak request login/register, coba lagi nanti"})
		},
	})
}

// DataLimiter: 5000 req/min
func NewDataLimiter() fiber.Handler {
	return limiter.New(limiter.Config{
		Max:        5000,
		Expiration: 1 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": "Terlalu banyak request data, slow down bot!"})
		},
	})
}

// TradingLimiter: 10000 req/min
func NewTradingLimiter() fiber.Handler {
	return limiter.New(limiter.Config{
		Max:        10000,
		Expiration: 1 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			// If authenticated, limit by UserID to allow different bots on same IP?
			// But for now, IP based is safer for DoS protection.
			// Node version used default IP based.
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{"error": "Bot trading Anda terlalu cepat (max 10000/menit)"})
		},
	})
}

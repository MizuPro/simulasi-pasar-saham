package main

import (
	"log"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/core/engine"
	"mbit-backend-go/handlers"
	"mbit-backend-go/middleware"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/adaptor/v2"
	socketio "github.com/zishang520/socket.io/v2/socket"
	"github.com/robfig/cron/v3"
	"mbit-backend-go/services"
)

func main() {
	// 1. Config & DB
	config.LoadEnv()
	config.ConnectDB()
	config.ConnectRedis()
	defer config.CloseDB()
	defer config.CloseRedis()

	// 2. Socket.IO Setup
	io := socketio.NewServer(nil, nil)

	// Events
	io.On("connection", func(clients ...any) {
		socket := clients[0].(*socketio.Socket)
		log.Printf("🔌 Client connected: %s", socket.Id())

		socket.On("join_stock", func(data ...any) {
			if len(data) > 0 {
				symbol := data[0].(string)
				socket.Join(socketio.Room(symbol))
				log.Printf("📈 User joined stock room: %s", symbol)
			}
		})

		socket.On("leave_stock", func(data ...any) {
			if len(data) > 0 {
				symbol := data[0].(string)
				socket.Leave(socketio.Room(symbol))
			}
		})

		socket.On("join_user", func(data ...any) {
			if len(data) > 0 {
				userId := data[0].(string)
				socket.Join(socketio.Room("user:"+userId))
			}
		})

		socket.On("disconnect", func(args ...any) {
			log.Printf("🔌 Client disconnected: %s", socket.Id())
		})
	})

	// Initialize Matching Engine with IO
	engine.InitEngine(io)

	// Start Cron
	c := cron.New()
	c.AddFunc("*/1 * * * *", func() {
		services.GlobalMarketService.GenerateOneMinuteCandles()
	})
	c.Start()
	log.Println("⏰ Market Data Scheduler Started (every 1 minute)")

	// 3. Fiber App
	app := fiber.New(fiber.Config{
		BodyLimit: 1 * 1024 * 1024, // 1MB
	})

	// Middleware
	app.Use(logger.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowHeaders: "Origin, Content-Type, Accept, Authorization",
		AllowMethods: "GET, POST, HEAD, PUT, DELETE, PATCH, OPTIONS",
	}))

	// Rate Limiters
	authLimiter := middleware.NewAuthLimiter()
	dataLimiter := middleware.NewDataLimiter()
	// tradingLimiter := middleware.NewTradingLimiter()

	// 4. Routes

	// Root
	app.Get("/", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":        "Online 🟢",
			"message":       "M-bit Trading Engine Ready (Go Version)",
			"time":          time.Now(),
			"socket_status": "Active",
		})
	})

	// Socket.IO Handler (Adapter for Fiber)
	// zishang520/socket.io provides a handler compatible with http.Handler usually.
	// Fiber uses fasthttp. We need fiber adapter or use fasthttp adaptor.
	// `io.ServeHandler(nil)` returns an http.Handler.
	// Use fiber's adaptor.
	// Note: Socket.IO often needs sticky sessions or specific path handling.
	// Path is usually /socket.io/

	// Native Fiber handling for Socket.IO is complex due to Hijack support needed.
	// It's often easier to run Socket.IO on a separate port or use `github.com/gofiber/contrib/socketio` (which wraps standard socket.io?)
	// But `zishang520` claims fasthttp support?
	// The library `zishang520/socket.io` has `engine.NewServer`.
	// Let's assume standard http handler via adaptor.

	// For now, let's skip direct Socket mounting in this plan step if complex,
	// OR use a standard net/http server for the whole thing if Fiber proves difficult with Socket.IO.
	// However, user asked for Fiber.
	// Best practice: Run Socket.IO on the same port but intercepted by a specific path handler.
	// Or use `gofiber/adaptor`.

	app.All("/socket.io/*", adaptor.HTTPHandler(io.ServeHandler(nil)))

	// Auth Routes
	auth := app.Group("/api/auth", authLimiter)
	auth.Post("/register", handlers.Register)
	auth.Post("/login", handlers.Login)

	// Market Data Routes
	market := app.Group("/api", dataLimiter) // Includes /market, /stocks, /portfolio
	market.Get("/stocks", handlers.GetStocks)
	market.Get("/market/ticker", handlers.GetMarketTicker)
	market.Get("/market/depth/:symbol", handlers.GetOrderBook)

	// Protected Routes
	protected := app.Group("/api", middleware.AuthMiddleware)
	protected.Get("/portfolio", handlers.GetPortfolio) // /api/portfolio

	// Order Routes
	orders := app.Group("/api/orders", middleware.AuthMiddleware) // Add Trading Rate Limiter here if needed
	orders.Post("/", handlers.PlaceOrder)
	orders.Delete("/:id", handlers.CancelOrder)

	// Admin Routes
	admin := app.Group("/api/admin", middleware.AuthMiddleware, middleware.AdminAuthMiddleware)
	admin.Post("/session/open", handlers.OpenSession)
	admin.Post("/session/close", handlers.CloseSession)
	// Add other admin routes...

	// 5. Start
	port := config.GetEnv("PORT", "3000") // 3000 matches current
	log.Fatal(app.Listen(":" + port))
}

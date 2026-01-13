package handlers

import (
	"context"
	"mbit-backend-go/config"
	"mbit-backend-go/models"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

// CreateAdmin creates a new admin user
func CreateAdmin(c *fiber.Ctx) error {
	var req RegisterRequest // Reuse
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	if req.Username == "" || req.FullName == "" || req.Password == "" {
		return c.Status(400).JSON(fiber.Map{"error": "All fields required"})
	}
	if len(req.Password) < 8 {
		return c.Status(400).JSON(fiber.Map{"error": "Password admin min 8 chars"})
	}

	hashed, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)

	var user models.User
	err := config.DB.QueryRow(context.Background(), `
		INSERT INTO users (username, full_name, password_hash, role)
		VALUES ($1, $2, $3, 'ADMIN')
		RETURNING id, username, full_name, balance_rdn, role, created_at
	`, req.Username, req.FullName, string(hashed)).Scan(
		&user.ID, &user.Username, &user.FullName, &user.BalanceRDN, &user.Role, &user.CreatedAt,
	)

	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(201).JSON(fiber.Map{
		"message": "Admin created",
		"user": user,
	})
}

// GetAllUsers returns all users with equity
func GetAllUsers(c *fiber.Ctx) error {
	query := `
		WITH stock_values AS (
			SELECT
				p.user_id,
				SUM(p.quantity_owned * 100 * COALESCE(d.close_price, d.prev_close, 1000)) as stock_equity
			FROM portfolios p
			JOIN daily_stock_data d ON p.stock_id = d.stock_id
			WHERE d.session_id = (SELECT id FROM trading_sessions ORDER BY id DESC LIMIT 1)
			GROUP BY p.user_id
		)
		SELECT
			u.id, u.username, u.full_name, u.balance_rdn, u.role, u.created_at,
			(u.balance_rdn + COALESCE(sv.stock_equity, 0)) as equity
		FROM users u
		LEFT JOIN stock_values sv ON u.id = sv.user_id
		ORDER BY u.created_at DESC
	`
	rows, err := config.DB.Query(context.Background(), query)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type UserWithEquity struct {
		ID         string    `json:"id"`
		Username   string    `json:"username"`
		FullName   string    `json:"full_name"`
		BalanceRDN float64   `json:"balance_rdn"`
		Role       string    `json:"role"`
		CreatedAt  time.Time `json:"created_at"`
		Equity     float64   `json:"equity"`
	}

	var users []UserWithEquity
	for rows.Next() {
		var u UserWithEquity
		if err := rows.Scan(&u.ID, &u.Username, &u.FullName, &u.BalanceRDN, &u.Role, &u.CreatedAt, &u.Equity); err == nil {
			users = append(users, u)
		}
	}

	return c.JSON(users)
}

// UpdateUserRole
func UpdateUserRole(c *fiber.Ctx) error {
	var req struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	// Check self demotion
	adminId := c.Locals("userId").(string)
	if req.UserID == adminId && req.Role != "ADMIN" {
		return c.Status(403).JSON(fiber.Map{"error": "Anda tidak dapat menghapus role admin Anda sendiri"})
	}

	_, err := config.DB.Exec(context.Background(), "UPDATE users SET role = $1 WHERE id = $2", req.Role, req.UserID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Return updated user
	var user models.User
	config.DB.QueryRow(context.Background(), "SELECT id, username, full_name, balance_rdn, role, created_at FROM users WHERE id = $1", req.UserID).Scan(
		&user.ID, &user.Username, &user.FullName, &user.BalanceRDN, &user.Role, &user.CreatedAt,
	)

	return c.JSON(fiber.Map{
		"message": "Role updated",
		"user": user,
	})
}

// AdjustUserBalance
func AdjustUserBalance(c *fiber.Ctx) error {
	userId := c.Params("userId")
	var req struct {
		Amount float64 `json:"amount"`
		Reason string  `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	_, err := config.DB.Exec(context.Background(), "UPDATE users SET balance_rdn = balance_rdn + $1 WHERE id = $2", req.Amount, userId)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Could log transaction ledger if exists, but not in current minimal scope

	return c.JSON(fiber.Map{"message": "Balance updated"})
}

// AdjustUserPortfolio
func AdjustUserPortfolio(c *fiber.Ctx) error {
	userId := c.Params("userId")
	stockId := c.Params("stockId")

	var req struct {
		Amount int64  `json:"amount"`
		Reason string `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	ctx := context.Background()
	tx, err := config.DB.Begin(ctx)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }
	defer tx.Rollback(ctx)

	// Validate Max Shares if positive amount (issue/add)
	if req.Amount > 0 {
		var maxShares int64
		var currentIssued int64
		// fetch stockId as int, though params string
		// Postgres handles cast often, or we cast explicitly
		err = tx.QueryRow(ctx, "SELECT max_shares FROM stocks WHERE id = $1", stockId).Scan(&maxShares)
		if err != nil { return c.Status(404).JSON(fiber.Map{"error": "Saham tidak ditemukan"}) }

		err = tx.QueryRow(ctx, "SELECT COALESCE(SUM(quantity_owned), 0) FROM portfolios WHERE stock_id = $1", stockId).Scan(&currentIssued)
		if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

		if currentIssued + req.Amount > maxShares {
			return c.Status(400).JSON(fiber.Map{"error": "Melebihi max shares"})
		}
	} else if req.Amount < 0 {
		// Validate user has enough to remove
		var owned int64
		err = tx.QueryRow(ctx, "SELECT quantity_owned FROM portfolios WHERE user_id = $1 AND stock_id = $2", userId, stockId).Scan(&owned)
		if err == pgx.ErrNoRows { owned = 0 }
		if owned + req.Amount < 0 {
			return c.Status(400).JSON(fiber.Map{"error": "User tidak memiliki cukup saham"})
		}
	}

	// Update
	_, err = tx.Exec(ctx, `
		INSERT INTO portfolios (user_id, stock_id, quantity_owned, avg_buy_price)
		VALUES ($1, $2, $3, 0)
		ON CONFLICT (user_id, stock_id)
		DO UPDATE SET quantity_owned = portfolios.quantity_owned + $3
	`, userId, stockId, req.Amount)
	if err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	if err := tx.Commit(ctx); err != nil { return c.Status(500).JSON(fiber.Map{"error": err.Error()}) }

	// Fetch new quantity
	var newQty int64
	config.DB.QueryRow(ctx, "SELECT quantity_owned FROM portfolios WHERE user_id = $1 AND stock_id = $2", userId, stockId).Scan(&newQty)

	// Fetch symbol
	var symbol string
	config.DB.QueryRow(ctx, "SELECT symbol FROM stocks WHERE id = $1", stockId).Scan(&symbol)

	return c.JSON(fiber.Map{
		"message": "Portfolio pengguna berhasil diperbarui",
		"change": req.Amount,
		"symbol": symbol,
		"newQuantity": newQty,
		"reason": req.Reason,
	})
}

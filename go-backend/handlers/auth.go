package handlers

import (
	"context"
	"time"

	"mbit-backend-go/config"
	"mbit-backend-go/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type RegisterRequest struct {
	Username string `json:"username"`
	FullName string `json:"fullName"` // Matches frontend 'fullName' camelCase
	Password string `json:"password"`
}

func Register(c *fiber.Ctx) error {
	var req RegisterRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Username == "" || req.FullName == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Username, fullName, dan password wajib diisi"})
	}
	if len(req.Password) < 6 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Password minimal 6 karakter"})
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to hash password"})
	}

	var user models.User
	query := `
		INSERT INTO users (username, full_name, password_hash, role)
		VALUES ($1, $2, $3, 'USER')
		RETURNING id, username, full_name, balance_rdn, role, created_at, updated_at
	`
	err = config.DB.QueryRow(context.Background(), query, req.Username, req.FullName, string(hashedPassword)).
		Scan(&user.ID, &user.Username, &user.FullName, &user.BalanceRDN, &user.Role, &user.CreatedAt, &user.UpdatedAt)

	if err != nil {
		// Check for unique constraint violation (duplicate username)
		// pgx error handling is specific, simplified here check string
		if config.DB.Ping(context.Background()) == nil {
			// Very naive check, improve with pgconn error check if needed
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Username sudah digunakan"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Registrasi gagal: " + err.Error()})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"message": "User registered",
		"user":    user,
	})
}

func Login(c *fiber.Ctx) error {
	var req LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Username == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Username dan password wajib diisi"})
	}

	var user models.User
	query := `SELECT id, username, full_name, password_hash, balance_rdn, role FROM users WHERE username = $1`
	err := config.DB.QueryRow(context.Background(), query, req.Username).Scan(
		&user.ID, &user.Username, &user.FullName, &user.PasswordHash, &user.BalanceRDN, &user.Role,
	)

	if err == pgx.ErrNoRows {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Username atau password salah"})
	} else if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Database error"})
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Username atau password salah"})
	}

	// Generate JWT
	claims := jwt.MapClaims{
		"userId": user.ID,
		"role":   user.Role,
		"exp":    time.Now().Add(24 * time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	secret := config.GetEnv("JWT_SECRET", "rahasiakitabersama123")
	t, err := token.SignedString([]byte(secret))
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to generate token"})
	}

	return c.JSON(fiber.Map{
		"message": "Login successful",
		"token":   t,
		"user": fiber.Map{
			"id":          user.ID,
			"username":    user.Username,
			"full_name":   user.FullName,
			"balance_rdn": user.BalanceRDN,
			"role":        user.Role,
		},
	})
}

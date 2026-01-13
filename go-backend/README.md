# Go Backend Migration

This directory contains the full port of the Node.js backend to Go (Fiber + pgx + Redis).

## Setup & Run

1.  **Prerequisites**: Ensure PostgreSQL and Redis are running (via Docker or local).
2.  **Env**: Ensure `.env` is in the root directory (parent of `go-backend`).
3.  **Run**:
    ```bash
    cd go-backend
    go mod tidy
    go run main.go
    ```

## Architecture

*   **Framework**: Go Fiber v2
*   **Database**: `pgx/v5` (High-performance PostgreSQL driver)
*   **Redis**: `go-redis/v9`
*   **Socket.IO**: `zishang520/socket.io` (v4 compatible)
*   **Structure**:
    *   `config/`: Database/Redis connections.
    *   `handlers/`: API Route handlers.
    *   `core/engine/`: Matching Engine & IEP Logic.
    *   `services/`: Business logic (Orders, Cron).
    *   `models/`: DB Structs.
    *   `middleware/`: Auth & Rate Limits.

## Key Features Ported

*   **Matching Engine**: Continuous matching (Price-Time Priority) and IEP (Call Auction) logic.
*   **Trading Session**: Admin endpoints to Open/Close sessions (`/api/admin/session/open`).
*   **Order Management**: Place/Cancel orders with strict validations (Balance, Stock Ownership).
*   **Market Data**: Ticker, Orderbook (Depth), and Candle generation (Cron).
*   **Authentication**: JWT-based auth with Role management (USER/ADMIN).
*   **Rate Limiting**: Tiered limits for Auth, Data, and Trading endpoints.

## Compatibility

The API endpoints strictly follow the existing Node.js API format to ensure frontend and bot compatibility.
Socket.IO events (`orderbook_update`, `trade`, `price_update`) are preserved.

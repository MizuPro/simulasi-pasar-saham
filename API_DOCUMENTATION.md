# 📚 M-BIT Trading Platform - API Documentation

> **Base URL**: `http://localhost:3000/api`
> **Version**: 1.3.1
> **Last Updated**: January 10, 2026

---

## 🚀 Rate Limiting
- **Global API**: 100 requests per minute
- **Trading API (`/orders`)**: 10,000 requests per minute (~160 req/sec) to support high-frequency trading.

---

## 📋 Table of Contents
1. [Authentication](#authentication)
2. [User Roles & Permissions](#user-roles--permissions)
3. [Market Data](#market-data)
4. [Trading](#trading)
5. [Portfolio](#portfolio)
6. [Watchlist](#watchlist)
7. [Admin & Session Management](#admin--session-management)
8. [Stock Management (Admin Only)](#stock-management-admin-only)
9. [User Management (Admin Only)](#user-management-admin-only)
10. [Bot Management (Admin Only)](#-bot-management-admin-only)
11. [Order & Trade Management (Admin Only)](#-order--trade-management-admin-only)
12. [Matching Engine Management (Admin Only)](#-matching-engine-management-admin-only)
13. [WebSocket Events](#websocket-events)
14. [Error Codes](#error-codes)

---

## 🔐 Authentication

### Register User
**POST** `/auth/register`

> 📝 **Note**: New users are registered with role `USER` by default.

**Request Body:**
```json
{
  "username": "johndoe",
  "fullName": "John Doe",
  "password": "secretpassword123"
}
```

**Validation:**
- `username`: Required, unique
- `fullName`: Required
- `password`: Required, minimum 6 characters

**Response (201):**
```json
{
  "message": "User registered",
  "user": {
    "id": "uuid-here",
    "username": "johndoe",
    "full_name": "John Doe",
    "balance_rdn": 0,
    "role": "USER",
    "created_at": "2026-01-08T10:00:00Z"
  }
}
```

---

### Login
**POST** `/auth/login`

**Request Body:**
```json
{
  "username": "johndoe",
  "password": "secretpassword123"
}
```

**Response (200):**
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid-here",
    "username": "johndoe",
    "full_name": "John Doe",
    "balance_rdn": 0,
    "role": "USER"
  }
}
```

**Notes:**
- Token expires in 1 day
- Token includes `userId` and `role`
- Use token in `Authorization: Bearer {token}` header for protected routes

---

## 👤 User Roles & Permissions

### Role Types

| Role | Description | Permissions |
|------|-------------|-------------|
| `USER` | Regular trader | View market, place orders, manage portfolio |
| `ADMIN` | Administrator | All USER permissions + session management, user management |

### Endpoint Access

| Endpoint | USER | ADMIN |
|----------|------|-------|
| `/auth/register` | ✅ | ✅ |
| `/auth/login` | ✅ | ✅ |
| `/stocks` | ✅ | ✅ |
| `/session` | ✅ | ✅ |
| `/market/*` | ✅ | ✅ |
| `/market/stocks/:symbol/orderbook` | ✅ | ✅ |
| `/orders/*` | ✅ | ✅ |
| `/portfolio` | ✅ | ✅ |
| `/portfolio/watchlist` | ✅ | ✅ |
| `/admin/orderbook/:symbol` | ✅ | ✅ |
| `/admin/session/open` | ❌ | ✅ |
| `/admin/session/close` | ❌ | ✅ |
| `/admin/init-session` | ❌ | ✅ |
| `/auth/admin/*` | ❌ | ✅ |

---

## 📊 Market Data

### Get All Stocks
**GET** `/stocks`

**Response (200):**
```json
[
  {
    "id": 1,
    "symbol": "MICH",
    "name": "PT. Michael Kurniawan Asia Tbk",
    "is_active": true,
    "max_shares": 1000000,
    "total_shares": 500000,
    "lastPrice": 1250.00,
    "prevClose": 1200.00,
    "change": 50.00,
    "changePercent": 4.17,
    "ara": 1500.00,
    "arb": 900.00,
    "volume": 15000
  }
]
```

---

### Get Candles (Chart Data)
**GET** `/market/candles/:symbol`

**Query Parameters:**
- `timeframe` (optional): `1m`, `5m`, `15m`, `1h`, `1d` (default: `1m`)
- `limit` (optional): number of candles (default: `1000`)

**Example:**
```
GET /market/candles/MICH?timeframe=5m&limit=100
```

**Response (200):**
```json
[
  {
    "time": 1704672000000,
    "open": 1200.00,
    "high": 1250.00,
    "low": 1180.00,
    "close": 1230.00,
    "volume": 5000,
    "session_id": 5
  }
]
```

**Notes:**
- `time` is in milliseconds (JavaScript timestamp)
- `session_id`: ID of the trading session when the candle was generated (null if not available)
- Data sorted ascending by time

---

### Get Daily Stock Data (Historical Session Data)
**GET** `/market/daily-data` (all stocks)  
**GET** `/market/daily-data/:symbol` (specific stock)

**Response (200):**
```json
[
  {
    "symbol": "MICH",
    "name": "PT. Michael Pratama Tbk",
    "session_number": 5,
    "session_status": "CLOSED",
    "started_at": "2026-01-07T09:00:00Z",
    "ended_at": "2026-01-07T16:00:00Z",
    "prev_close": 1200.00,
    "open_price": 1210.00,
    "high_price": 1280.00,
    "low_price": 1190.00,
    "close_price": 1250.00,
    "ara_limit": 1500.00,
    "arb_limit": 900.00,
    "volume": 25000
  }
]
```

---

### Get Orderbook (Public)
**GET** `/market/stocks/:symbol/orderbook`

**Query Parameters:**
- `limit` (optional): Number of price levels to return (default: `10`)

**Example:**
```
GET /market/stocks/MICH/orderbook?limit=10
```

**Response (200):**
```json
{
  "symbol": "MICH",
  "bids": [
    { "price": 1250, "totalQty": 50, "count": 3 },
    { "price": 1248, "totalQty": 100, "count": 5 }
  ],
  "asks": [
    { "price": 1252, "totalQty": 75, "count": 4 },
    { "price": 1254, "totalQty": 120, "count": 6 }
  ]
}
```

**Notes:**
- `bids`: Buy orders (sorted descending by price - highest first)
- `asks`: Sell orders (sorted ascending by price - lowest first)
- `totalQty`: Total quantity at that price level (in lots)
- `count`: Number of orders at that price level

---

### Get Order Queue Detail (FIFO Inspection)
**GET** `/market/queue/:symbol`

> 📝 **Note**: Mengambil detail antrean order pada harga tertentu untuk melihat urutan prioritas (First-In-First-Out).

**Query Parameters:**
- `price` (required): Harga yang ingin dicek antreannya.

**Example:**
```
GET /market/queue/MICH?price=1250
```

**Response (200):**
```json
{
  "symbol": "MICH",
  "price": 1250,
  "queue": [
    {
      "orderId": "uuid-1",
      "userId": "uuid-user-a",
      "quantity": 10,
      "remaining_quantity": 10,
      "timestamp": 1704672000000,
      "side": "BUY"
    },
    {
      "orderId": "uuid-2",
      "userId": "uuid-user-b",
      "quantity": 25,
      "remaining_quantity": 25,
      "timestamp": 1704672005000,
      "side": "BUY"
    }
  ]
}
```

**Notes:**
- `queue`: List order diurutkan berdasarkan `timestamp` ASC (Order teratas adalah yang akan match duluan).
- `quantity`: Total lot awal yang dipesan.
- `remaining_quantity`: Sisa lot yang sedang mengantre.

---

### Get Indicative Equilibrium Price (IEP)
**GET** `/market/iep/:symbol`

> 📝 **Note**: Mengambil data IEP saat fase **PRE-OPEN** atau **LOCKED**. Di luar fase itu, nilainya `null`.

**Response (200) - During Pre-Open/Locked:**
```json
{
  "symbol": "MICH",
  "iep": 1250.00,
  "volume": 5000,
  "surplus": 100,
  "status": "PRE_OPEN"
}
```
*Note: `status` can be `PRE_OPEN` or `LOCKED`.*

**Response (200) - During Open/Closed:**
```json
{
  "symbol": "MICH",
  "iep": null,
  "volume": 0,
  "surplus": 0,
  "status": "OPEN"
}
```

---

### Get Orderbook (Admin Endpoint - Legacy)
**GET** `/admin/orderbook/:symbol`

**Response (200):**
```json
{
  "symbol": "MICH",
  "bids": [
    { "price": 1250, "totalQty": 50, "count": 3 },
    { "price": 1248, "totalQty": 100, "count": 5 }
  ],
  "asks": [
    { "price": 1252, "totalQty": 75, "count": 4 },
    { "price": 1254, "totalQty": 120, "count": 6 }
  ]
}
```

**Notes:**
- `bids`: Buy orders (sorted descending by price)
- `asks`: Sell orders (sorted ascending by price)
- `totalQty`: Total quantity at that price level (in lots)
- `count`: Number of orders at that price level

---

## 💼 Trading

### Place Order
**POST** `/orders`  
🔒 **Requires Authentication**

**Request Body:**
```json
{
  "symbol": "MICH",
  "type": "BUY",
  "price": 1250,
  "quantity": 10
}
```

**Fields:**
- `symbol`: Stock symbol
- `type`: `BUY` or `SELL`
- `price`: Order price (must comply with tick size)
- `quantity`: Quantity in lots (1 lot = 100 shares)

**Response (200):**
```json
{
  "message": "Order BUY berhasil ditempatkan",
  "orderId": "uuid-order-id"
}
```

**Validation:**
- Price must be within ARA/ARB limits
- Price must comply with tick size rules
- BUY: Sufficient RDN balance required
- SELL: Sufficient stock ownership required
- **Phase Restriction**: Cannot place orders during `LOCKED` phase. Allowed in `PRE_OPEN` (queued) and `OPEN`.

---

### Cancel Order
**DELETE** `/orders/:orderId`  
🔒 **Requires Authentication**

**Response (200):**
```json
{
  "message": "Order berhasil dibatalkan"
}
```

**Notes:**
- Refunds RDN for BUY orders
- For SELL orders, the stocks were never deducted from the portfolio (only locked in the orderbook), so cancellation simply releases the lock without needing a refund update to the portfolio table.
- Only cancels PENDING or PARTIAL orders
- Allowed in all active phases (`PRE_OPEN`, `LOCKED`, `OPEN`).

---

### Get Order History
**GET** `/orders/history`
🔒 **Requires Authentication**

**Response (200):**
```json
[
  {
    "id": "uuid",
    "symbol": "MICH",
    "session_id": 1,
    "type": "BUY",
    "target_price": 1250,
    "execution_price": 1248.50,
    "price": 1248.50,
    "quantity": 10,
    "remaining_quantity": 0,
    "matched_quantity": 10,
    "status": "MATCHED",
    "created_at": "2026-01-07T10:30:00Z"
  }
]
```

**Fields:**
- `target_price`: The price you set when placing the order.
- `execution_price` / `price`: The average price at which the order was actually executed.
- `quantity`: Total lots requested.
- `remaining_quantity`: Lots not yet filled.
- `matched_quantity`: Total lots successfully traded (Quantity - Remaining).

**Status Values:**
- `PENDING`: Order waiting to be matched
- `PARTIAL`: Order partially filled
- `MATCHED`: Order fully filled
- `CANCELED`: Order canceled by user or system
- `REJECTED`: Order rejected (validation failed)

**New Field:**
- `profit_loss` (Numeric): Only available for `SELL` orders. Shows the realized Profit/Loss based on the difference between `execution_price` and the `average_buy_price` at the time of the order. `(Execution Price - Avg Buy Price) * Matched Quantity * 100`.

---

### Get Active Orders
**GET** `/orders/active`
🔒 **Requires Authentication**

**Response (200):**
```json
[
  {
    "id": "uuid",
    "symbol": "MICH",
    "session_id": 1,
    "type": "SELL",
    "target_price": 1260,
    "execution_price": 1260,
    "price": 1260,
    "quantity": 5,
    "remaining_quantity": 2,
    "matched_quantity": 3,
    "status": "PARTIAL",
    "created_at": "2026-01-07T11:00:00Z"
  }
]
```

---

## 💰 Portfolio

### Get Portfolio
**GET** `/portfolio`
🔒 **Requires Authentication**

**Response (200):**
```json
{
  "full_name": "John Doe",
  "balance_rdn": 9500000.0000,
  "stocks": [
    {
      "stock_id": 1,
      "symbol": "MICH",
      "name": "PT. Michael Pratama Tbk",
      "quantity_owned": 25,
      "avg_buy_price": 1200.00
    }
  ]
}
```

---

## 👁️ Watchlist

### Get Watchlist
**GET** `/portfolio/watchlist`
🔒 **Requires Authentication**

**Response (200):**
```json
[
  {
    "id": 1,
    "stock_id": 1,
    "symbol": "MICH",
    "name": "PT. Michael Pratama Tbk",
    "created_at": "2026-01-07T10:00:00Z"
  },
  {
    "id": 2,
    "stock_id": 2,
    "symbol": "BBCA",
    "name": "PT. Bank Central Asia Tbk",
    "created_at": "2026-01-07T11:00:00Z"
  }
]
```

---

### Add to Watchlist
**POST** `/portfolio/watchlist`
🔒 **Requires Authentication**

**Request Body:**
```json
{
  "symbol": "MICH"
}
```

**Response (201):**
```json
{
  "message": "Saham berhasil ditambahkan ke watchlist",
  "item": {
    "id": 1,
    "stock_id": 1,
    "symbol": "MICH",
    "name": "PT. Michael Pratama Tbk",
    "created_at": "2026-01-08T10:00:00Z"
  }
}
```

**Error Responses:**
- `400`: "Saham tidak ditemukan atau tidak aktif"
- `400`: "Saham sudah ada di watchlist"

---

### Remove from Watchlist
**DELETE** `/portfolio/watchlist/:symbol`
🔒 **Requires Authentication**

**Example:**
```
DELETE /portfolio/watchlist/MICH
```

**Response (200):**
```json
{
  "message": "Saham berhasil dihapus dari watchlist"
}
```

**Error Responses:**
- `400`: "Saham tidak ditemukan"
- `400`: "Saham tidak ada di watchlist"

---

## ⚙️ Admin & Session Management

### Get Session Status
**GET** `/session`

**Response (200):**
```json
{
  "id": 5,
  "status": "PRE_OPEN",
  "session_number": 5,
  "started_at": "2026-01-07T09:00:00Z",
  "ended_at": null
}
```

**Status Values:**
- `PRE_OPEN`: Pre-opening phase (IEP calculation active).
- `LOCKED`: Locked phase (No new orders, IEP finalized).
- `OPEN`: Trading session active
- `CLOSED`: Trading session closed

---

### Open Trading Session
**POST** `/admin/session/open`  
🔒 **Requires Admin Authentication**

**Response (200):**
```json
{
  "message": "Sesi trading berhasil dibuka (Pre-Opening)",
  "session": {
    "id": 6,
    "session_number": 6,
    "status": "PRE_OPEN",
    "started_at": "2026-01-07T09:00:00Z"
  },
  "timeline": {
    "preOpen": 15000,
    "locked": 5000,
    "totalPreOpen": 20000
  }
}
```

**Notes:**
- Initiates the **Pre-Opening** sequence:
  1.  **PRE-OPEN** (15s default): Users can input orders, IEP changes in real-time.
  2.  **LOCKED** (5s default): Order input blocked, IEP static.
  3.  **OPEN**: Call Auction execution (IEP Match) -> Continuous Trading.
- Automatically calculates ARA/ARB limits for all active stocks
- Uses last candle close price or default 1000
- Automatically injects pending orders from offline/closed state.
- Cannot open if session already OPEN

---

### Close Trading Session
**POST** `/admin/session/close`  
🔒 **Requires Admin Authentication**

**Response (200):**
```json
{
  "message": "Sesi trading berhasil ditutup",
  "canceledOrders": 15
}
```

**Notes:**
- Cancels all PENDING/PARTIAL orders
- Refunds locked balances (BUY orders)
- Returns locked stocks (SELL orders)
- Cleans up Redis orderbook

---

### Calculate ARA/ARB Limits
**POST** `/admin/init-session`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "symbol": "MICH",
  "prevClose": 1200
}
```

**Response (200):**
```json
{
  "symbol": "MICH",
  "prevClose": 1200,
  "araLimit": 1500,
  "arbLimit": 900,
  "tickSize": 2
}
```

---

## 🏗️ Stock Management (Admin Only)

### Create New Stock
**POST** `/admin/stocks`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "symbol": "NEWSTK",
  "name": "PT New Stock Tbk",
  "max_shares": 1000000
}
```

**Response (200):**
```json
{
  "message": "Saham berhasil ditambahkan",
  "stock": {
    "id": 10,
    "symbol": "NEWSTK",
    "name": "PT New Stock Tbk",
    "max_shares": "1000000",
    "total_shares": 0,
    "is_active": true
  }
}
```

---

### Update Stock Data
**PUT** `/admin/stocks/:id`
🔒 **Requires Admin Authentication**

**Request Body (Partial update supported):**
```json
{
  "name": "PT New Stock Updated Tbk",
  "max_shares": 1500000,
  "is_active": true
}
```

**Response (200):**
```json
{
  "message": "Saham berhasil diperbarui",
  "stock": {
    "id": 10,
    "symbol": "NEWSTK",
    "name": "PT New Stock Updated Tbk",
    "max_shares": "1500000",
    "total_shares": 1000,
    "is_active": true
  }
}
```

---

### Issue Shares to User
**POST** `/admin/stocks/:id/issue`
🔒 **Requires Admin Authentication**

> 📝 **Note**: This endpoint allows admin to issue shares (IPO/Private Placement) to a specific user. It checks against `max_shares` to prevent over-issuance.

**Request Body:**
```json
{
  "userId": "uuid-here",
  "quantity": 1000
}
```

**Response (200):**
```json
{
  "message": "Saham berhasil di-issue ke user",
  "portfolio": {
    "user_id": "uuid-here",
    "stock_id": 10,
    "quantity_owned": 1000
  },
  "total_shares": 1000,
  "max_shares": 1500000,
  "available_supply": 1499000
}
```

**Validation:**
- Fails if `currently_circulating + quantity > max_shares`.

---

## 👥 User Management (Admin Only)

> ⚠️ **All endpoints in this section require ADMIN role**

### Create Admin User
**POST** `/auth/admin/create`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "username": "newadmin",
  "fullName": "New Administrator",
  "password": "adminpassword123"
}
```

**Validation:**
- `password`: Minimum 8 characters for admin

**Response (201):**
```json
{
  "message": "Admin created",
  "user": {
    "id": "uuid-here",
    "username": "newadmin",
    "full_name": "New Administrator",
    "balance_rdn": 0,
    "role": "ADMIN",
    "created_at": "2026-01-08T10:00:00Z"
  }
}
```

---

### Get All Users
**GET** `/auth/admin/users`
🔒 **Requires Admin Authentication**

**Response (200):**
```json
[
  {
    "id": "uuid-1",
    "username": "admin",
    "full_name": "System Administrator",
    "balance_rdn": 0,
    "role": "ADMIN",
    "created_at": "2026-01-01T00:00:00Z",
    "equity": 0
  },
  {
    "id": "uuid-2",
    "username": "johndoe",
    "full_name": "John Doe",
    "balance_rdn": 0,
    "role": "USER",
    "created_at": "2026-01-07T10:00:00Z",
    "equity": 15000000
  }
]

**New Field:**
- `equity`: Total value of user assets (`balance_rdn + stock_value`). Stock value is calculated using the last available closing price.
```

---

### Update User Role
**PUT** `/auth/admin/role`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "userId": "uuid-of-user",
  "role": "ADMIN"
}
```

**Validation:**
- `role`: Must be `USER` or `ADMIN`
- Cannot remove your own admin role

**Response (200):**
```json
{
  "message": "Role updated",
  "user": {
    "id": "uuid-of-user",
    "username": "johndoe",
    "full_name": "John Doe",
    "balance_rdn": 95000000,
    "role": "ADMIN",
    "created_at": "2026-01-07T10:00:00Z"
  }
}
```

**Error Response (403):**
```json
{
  "error": "Anda tidak dapat menghapus role admin Anda sendiri"
}
```

---

### Adjust User Balance (Admin Only)
**PUT** `/admin/users/:userId/balance`
🔒 **Requires Admin Authentication**

> 📝 **Note**: Mengubah saldo RDN user secara manual.

**Request Body:**
```json
{
  "amount": 5000000,
  "reason": "Top up promo"
}
```

**Fields:**
- `amount`: Jumlah RDN yang akan ditambah (positif) atau dikurangi (negatif).
- `reason`: Alasan perubahan (opsional).

---

### Adjust User Portfolio (Admin Only)
**PUT** `/admin/users/:userId/portfolio/:stockId`
🔒 **Requires Admin Authentication**

> 📝 **Note**: Menambah atau mengurangi jumlah lot saham dalam portfolio user secara manual.

**Request Body:**
```json
{
  "amount": 10,
  "reason": "Kompensasi error sistem"
}
```

**Fields:**
- `amount`: Jumlah LOT yang akan ditambah (positif) atau dikurangi (negatif).
- `reason`: Alasan perubahan (opsional).

**Validation:**
- Jika `amount` positif, total saham beredar tidak boleh melebihi `max_shares` saham tersebut.
- Jika `amount` negatif, jumlah saham user tidak boleh menjadi kurang dari nol.

**Response (200):**
```json
{
  "message": "Portfolio pengguna berhasil diperbarui",
  "change": 10,
  "symbol": "MICH",
  "newQuantity": 15,
  "reason": "Kompensasi error sistem"
}
```

---

## 🤖 Bot Management (Admin Only)

> ⚠️ **All endpoints in this section require ADMIN role**
>
> **Purpose**: Bot Management API memungkinkan admin untuk mengisi orderbook dengan synthetic orders (bot orders) untuk menciptakan likuiditas pasar awal. Bot orders tidak terkait dengan akun user real dan tidak memengaruhi database users/portfolios.

### Key Features:
- **Synthetic Liquidity**: Mengisi orderbook dengan bid/ask tanpa memerlukan akun user asli.
- **Market-Making**: Menyebar orders di sekitar harga referensi dengan distribusi realistis.
- **Realtime Broadcast**: Bot orders langsung muncul di layar user secara realtime (WebSocket) tanpa perlu refresh.
- **Price Levels Distribution**: Mendukung parameter `priceLevels` untuk menentukan seberapa banyak tingkatan harga bid/offer yang dibuat.
- **Volume Control**: Mengatur jumlah LOT bot menggunakan parameter `minLot` dan `maxLot`.
- **Max Shares Awareness**: Bot secara otomatis berhenti melakukan SELL (Offer) jika jumlah saham beredar sudah mencapai `max_shares`, namun tetap bisa melakukan BUY (Bid).
- **Zero User Impact**: Bot orders hanya ada di Redis, tidak memengaruhi portfolio atau balance user.

### Bot Order Behavior:
- Bot orders dapat di-match dengan user orders.
- Ketika bot order match dengan user order:
  - User order diproses normal (portfolio & balance diupdate).
  - Bot order tidak mengubah database (hanya Redis).
  - Trade tetap tercatat untuk update harga pasar.
- Sistem secara otomatis men-trigger **Matching Engine** sesaat setelah bot ditambahkan untuk memastikan sinkronisasi data.

---

### Populate Orderbook for Single Stock
**POST** `/admin/bot/populate`
🔒 **Requires Admin Authentication**

> 📝 **Note**: Mengisi orderbook dengan bot orders untuk satu saham tertentu.

**Request Body:**
```json
{
  "symbol": "MICH",
  "priceLevels": 5,
  "minLot": 1,
  "maxLot": 50,
  "spreadPercent": 0.5
}
```

**Parameters:**
- `symbol` *(required)*: Symbol saham yang akan diisi bot orders.
- `priceLevels` *(optional, default: 5)*: Jumlah tingkatan harga bid & offer yang ingin dibuat.
- `minLot` *(optional, default: 1)*: Jumlah lot minimum per order.
- `maxLot` *(optional, default: 10)*: Jumlah lot maksimum per order.
- `spreadPercent` *(optional, default: 0.5)*: Selisih harga bid tertinggi dan offer terendah.

**Response (200):**
```json
{
  "success": true,
  "symbol": "MICH",
  "priceLevels": 5,
  "ordersCreated": 24,
  "referencePrice": 1250,
  "circulatingShares": 500000,
  "maxShares": 1000000,
  "sellSideActive": true
}
```

**Error Responses:**
```json
{
  "error": "Stock MICH tidak ditemukan"
}
```

**Example Usage:**
```bash
# Populate dengan 5 harga bid & 5 harga offer
curl -X POST http://localhost:3000/api/admin/bot/populate \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "MICH",
    "priceLevels": 5
  }'
```

---

### Populate Orderbook for All Active Stocks
**POST** `/admin/bot/populate-all`
🔒 **Requires Admin Authentication**

> 📝 **Note**: Mengisi orderbook untuk semua saham aktif sekaligus.

**Request Body (optional):**
```json
{
  "priceLevels": 5,
  "spreadPercent": 0.5
}
```

**Response (200):**
```json
{
  "success": true,
  "totalStocks": 10,
  "results": [...]
}
```

---

### Clear Bot Orders
**DELETE** `/admin/bot/clear`
🔒 **Requires Admin Authentication**

> 📝 **Note**: Menghapus semua bot orders. Aksi ini juga akan men-trigger update realtime ke client untuk membersihkan tampilan orderbook.

**Query Parameters:**
- `symbol` *(optional)*: Jika diisi, hanya clear bot orders untuk symbol tertentu.

**Example Usage:**
```bash
# Clear semua bot saham MICH dan broadcast ke user
curl -X DELETE "http://localhost:3000/api/admin/bot/clear?symbol=MICH" \
  -H "Authorization: Bearer {admin-token}"
```

---

### Get Orderbook Statistics
**GET** `/admin/bot/stats/:symbol`
🔒 **Requires Admin Authentication**

> 📝 **Note**: Melihat statistik perbandingan bot vs user orders.

**Response (200):**
```json
{
  "symbol": "MICH",
  "buy": { "total": 25, "bot": 15, "user": 10 },
  "sell": { "total": 20, "bot": 12, "user": 8 },
  "total": { "total": 45, "bot": 27, "user": 18 }
}
```

**Example Usage:**
```bash
curl -X GET http://localhost:3000/api/admin/bot/stats/MICH \
  -H "Authorization: Bearer {admin-token}"
```

---

### Bot Management Workflow

**Recommended workflow untuk memulai session baru:**

1. **Open Session**:
   ```bash
   POST /api/admin/session/open
   ```

2. **Populate Bot Orders untuk semua saham**:
   ```bash
   POST /api/admin/bot/populate-all
   # Body: { "minOrders": 10, "maxOrders": 20 }
   ```

3. **Cek Statistics** (optional):
   ```bash
   GET /api/admin/bot/stats/MICH
   ```

4. **User mulai trading**: User orders akan match dengan bot orders atau user orders lainnya

5. **Clear Bot Orders** (optional, jika ingin reset):
   ```bash
   DELETE /api/admin/bot/clear
   ```

6. **Refresh Bot Orders** (optional, untuk variasi):
   ```bash
   DELETE /api/admin/bot/clear
   POST /api/admin/bot/populate-all
   ```

---

### Bot Order Technical Details

**Bot Order Format di Redis:**
```json
{
  "orderId": "BOT-BUY-{uuid}",
  "userId": "SYSTEM_BOT",
  "stockId": 1,
  "sessionId": 5,
  "type": "BUY",
  "price": 1245,
  "quantity": 50,
  "remaining": 50,
  "timestamp": 1736380800000
}
```

**Matching Engine Behavior:**
- Bot orders participate in normal matching process
- When bot order matches with user order:
  - User gets normal portfolio/balance updates
  - Bot order disappears from orderbook (no DB updates needed)
  - Price update broadcasts to all connected clients
- When bot order matches with another bot order:
  - Both orders are removed from orderbook
  - Only price update is broadcasted (no portfolio changes)

**Tick Size Compliance:**
- Bot orders automatically comply with tick size rules:
  - Price < 200: tick size = 1
  - Price 200-500: tick size = 2
  - Price 500-2000: tick size = 5
  - Price 2000-5000: tick size = 10
  - Price > 5000: tick size = 25

**Volume Limits:**
- Bot orders are volume-aware
- Each order quantity is random between 1 and 5% of `max_shares` (dalam satuan LOT)
- 1 LOT = 100 shares
- Prevents unrealistic large orders that would distort market
- Example: If `max_shares` = 1,000,000, max bot order = 50,000 shares = 500 lots

---

## 🧾 Order & Trade Management (Admin Only)

### List All Orders
**GET** `/admin/orders`
🔒 **Requires Admin Authentication**

**Query Parameters:**
- `status` (optional): `PENDING`, `MATCHED`, `PARTIAL`, `CANCELED`, `REJECTED`
- `symbol` (optional): Stock symbol (e.g., `MICH`)
- `limit` (optional): Default `100`

**Response (200):**
```json
[
  {
    "id": "uuid",
    "user_id": "uuid",
    "username": "johndoe",
    "stock_id": 1,
    "symbol": "MICH",
    "type": "BUY",
    "price": "1250.00",
    "quantity": 10,
    "remaining_quantity": 5,
    "status": "PARTIAL",
    "created_at": "2026-01-09T10:00:00Z"
  }
]
```

---

### List All Trades
**GET** `/admin/trades`
🔒 **Requires Admin Authentication**

**Query Parameters:**
- `limit` (optional): Default `100`

**Response (200):**
```json
[
  {
    "id": "uuid",
    "buy_order_id": "uuid",
    "sell_order_id": "uuid",
    "buyer": "johndoe",
    "seller": "janedoe",
    "symbol": "MICH",
    "price": "1250.00",
    "quantity": 5,
    "executed_at": "2026-01-09T10:05:00Z"
  }
]
```

---

## ⚡ Matching Engine Management (Admin Only)

> ⚠️ **All endpoints in this section require ADMIN role**
>
> **Purpose**: Monitor and manage the Matching Engine performance, health, and circuit breaker states. Critical for troubleshooting high-frequency trading issues (100+ TPS).

### Key Features:
- **Real-time Monitoring**: Track transactions per second (TPS), match counts, error rates
- **Circuit Breaker Management**: Prevent cascading failures
- **Health Checks**: Redis connectivity and database pool statistics
- **Orderbook Validation**: Detect corrupt or stale orders
- **Performance Optimization**: Handle 100+ transactions per second

---

### Get Matching Engine Statistics
**GET** `/admin/engine/stats`
🔒 **Requires Admin Authentication**

**Response (200):**
```json
{
  "matchesProcessed": 1240,
  "tradesExecuted": 856,
  "errors": 3,
  "circuitBroken": 0,
  "lockTimeouts": 2,
  "retries": 15,
  "activeSymbols": ["MICH", "INDO"],
  "circuitBreakers": {
    "TLKM": "HALF_OPEN"
  }
}
```

---

### System Health Check
**GET** `/admin/health`
🔒 **Requires Admin Authentication**

**Response (200):**
```json
{
  "status": "healthy",
  "timestamp": 1736467200000,
  "stats": {
    "matchesProcessed": 1240,
    "tradesExecuted": 856,
    "errors": 3
  },
  "redisConnected": true,
  "dbPoolStats": {
    "total": 20,
    "idle": 15,
    "waiting": 0
  }
}
```

---

### Validate Orderbook Integrity
**GET** `/admin/orderbook/validate?symbol=MICH`
🔒 **Requires Admin Authentication**

**Response (200):**
```json
{
  "success": true,
  "symbol": "MICH",
  "healthy": true,
  "totalBuyOrders": 47,
  "totalSellOrders": 52,
  "validBuyOrders": 47,
  "validSellOrders": 52,
  "issues": {
    "buy": [],
    "sell": []
  }
}
```

---

### Reset Circuit Breaker
**POST** `/admin/engine/reset-circuit`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "symbol": "MICH"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Circuit breaker reset for MICH"
}
```

---

### Force Broadcast Orderbook Update
**POST** `/admin/engine/force-broadcast`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "symbol": "MICH"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Orderbook broadcast sent for MICH"
}
```

---

## 🔌 WebSocket Events

### Connection
```javascript
const socket = io('http://localhost:3000');
```

### Join Stock Room (Receive Price Updates)
**Emit:** `join_stock`
```javascript
socket.emit('join_stock', 'MICH');
```

**Listen:** `iep_update` (New!)
```javascript
socket.on('iep_update', (data) => {
  console.log(data);
  // {
  //   symbol: 'MICH',
  //   iep: 1250,      // or null
  //   volume: 5000,   // matched volume
  //   surplus: 100,
  //   status: 'PRE_OPEN' // or LOCKED, OPEN
  // }
});
```

**Listen:** `price_update`
```javascript
socket.on('price_update', (data) => {
  console.log(data);
  // {
  //   symbol: 'MICH',
  //   lastPrice: 1250,
  //   change: 50,
  //   changePercent: 4.17,
  //   volume: 15000
  // }
});
```

---

### Join User Room (Receive Personal Order Updates)
**Emit:** `join_user`
```javascript
socket.emit('join_user', userId);
```

**Listen:** `order_matched`
```javascript
socket.on('order_matched', (data) => {
  console.log(data);
  // {
  //   type: 'BUY',
  //   symbol: 'MICH',
  //   price: 1250,
  //   quantity: 10,
  //   message: 'Beli MICH: Full Match 10 Lot'
  // }
});
```

**Listen:** `order_status` (Standard Format)
```javascript
socket.on('order_status', (data) => {
  console.log(data);
  // {
  //   order_id: 'uuid-here',
  //   status: 'MATCHED',           // atau 'PARTIAL'
  //   price: 1250,                 // harga eksekusi
  //   matched_quantity: 10,        // jumlah yang berhasil match
  //   remaining_quantity: 0,       // sisa yang belum terpenuhi
  //   symbol: 'MICH',
  //   type: 'BUY',
  //   timestamp: 1704672000000
  // }
});
```

---

### Receive Orderbook Updates
**Listen:** `orderbook_update`
```javascript
socket.on('orderbook_update', (data) => {
  console.log(data);
  // {
  //   symbol: 'MICH',
  //   bids: [...],
  //   asks: [...]
  // }
});
```

---

### Leave Stock Room
**Emit:** `leave_stock`
```javascript
socket.emit('leave_stock', 'MICH');
```

---

## ❌ Error Codes

### HTTP Status Codes
- `200`: Success
- `201`: Created (e.g., user registration)
- `400`: Bad Request (validation error)
- `401`: Unauthorized (missing/invalid token)
- `404`: Not Found
- `500`: Internal Server Error

### Common Error Responses

**Invalid Credentials:**
```json
{
  "error": "Invalid credentials"
}
```

**Insufficient Balance:**
```json
{
  "error": "Saldo RDN tidak cukup"
}
```

**Price Out of Range:**
```json
{
  "error": "Harga melampaui batas ARA/ARB"
}
```

**Invalid Tick Size:**
```json
{
  "error": "Harga tidak sesuai fraksi (Tick Size)"
}
```

**Session Closed:**
```json
{
  "error": "Saham tidak ditemukan atau bursa sedang tutup"
}
```

---

## 🔧 Price Rules & Validation

### Tick Size Rules
| Price Range | Tick Size |
|-------------|-----------|
| < Rp 200    | Rp 1      |
| Rp 200 - Rp 500 | Rp 2 |
| Rp 500 - Rp 2,000 | Rp 5 |
| Rp 2,000 - Rp 5,000 | Rp 10 |
| ≥ Rp 5,000  | Rp 25     |

### ARA/ARB Calculation
| Prev Close Range | Percentage |
|------------------|------------|
| ≤ Rp 200         | ±35%       |
| Rp 200 - Rp 5,000 | ±25%      |
| > Rp 5,000       | ±20%       |

**Example:**
```
Prev Close: Rp 1,200
Percentage: 25%
ARA: 1,200 + (1,200 × 0.25) = 1,500
ARB: 1,200 - (1,200 × 0.25) = 900
```

---

## ⚙️ Matching Engine Logic

### Market Phases & IEP
The system now supports **Pre-Opening** mechanism similar to IDX:
1.  **Pre-Open Phase**: Orders are collected but not matched. IEP is calculated based on intersecting supply/demand curves to maximize volume.
2.  **Locked Phase**: No new orders allowed.
3.  **Call Auction (Open)**: All eligible orders are matched at a single IEP price.
4.  **Continuous Trading**: Normal Price-Time Priority matching.

### Price-Time Priority (FIFO)
The matching engine follows the **FIFO (First In, First Out)** principle:
1.  **Price Priority**: Higher buy prices and lower sell prices are matched first.
2.  **Time Priority**: For orders at the same price, the order that entered the system earlier (older timestamp) is matched first.

### Execution Price Determination
When a buy order price is greater than or equal to a sell order price, a trade occurs. The execution price is determined by the **Passive Order (Maker)**:
*   **Passive Order**: The order that was already sitting in the orderbook/queue.
*   **Aggressive Order**: The incoming order that triggers the match.

### Portfolio & Asset Locking
1.  **BUY Orders**: RDN balance is **immediately deducted** (locked) upon placing the order to ensure payment capability. If execution price is lower than bid price, the difference is refunded.
2.  **SELL Orders**: Stock quantity is **NOT deducted** from the portfolio upon placing the order. Instead, it is "Locked" by the system.
    *   Validation: `Total Owned - Total in Active Sell Orders >= Requested New Sell Quantity`.
    *   The portfolio view (`/portfolio`) will continue to show the total `quantity_owned` until a trade actually occurs.
    *   Stocks are only finally deducted from the seller's portfolio when a match (trade) is executed.

**Trade Scenarios:**

| Scenario | Passive Order (First In) | Aggressive Order (Incoming) | Execution Price | Result |
| :--- | :--- | :--- | :--- | :--- |
| **A** | Buy @ 420 | Sell @ 418 | **420** | Seller gets a better price (420) than requested (418). |
| **B** | Sell @ 418 | Buy @ 420 | **418** | Buyer gets a better price (418) than requested (420). |

**Note on Balance Refunds:**
For Scenario B, since the buyer bid 420 but only paid 418, the system automatically refunds the difference (Rp 2 x quantity x 100) back to the buyer's RDN balance.

---

## 🚀 Quick Start Examples

### JavaScript/Node.js
```javascript
const axios = require('axios');
const io = require('socket.io-client');

const API_URL = 'http://localhost:3000/api';
let token = '';

// Login
async function login() {
  const res = await axios.post(`${API_URL}/auth/login`, {
    username: 'johndoe',
    password: 'password123'
  });
  token = res.data.token;
  console.log('Logged in:', res.data.user);
}

// Get Stocks
async function getStocks() {
  const res = await axios.get(`${API_URL}/stocks`);
  console.log('Stocks:', res.data);
}

// Place Order
async function placeOrder() {
  const res = await axios.post(`${API_URL}/orders`, {
    symbol: 'MICH',
    type: 'BUY',
    price: 1250,
    quantity: 10
  }, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log('Order placed:', res.data);
}

// WebSocket
const socket = io('http://localhost:3000');
socket.emit('join_stock', 'MICH');
socket.on('price_update', (data) => {
  console.log('Price update:', data);
});
```

### Python
```python
import requests
from socketio import Client

API_URL = 'http://localhost:3000/api'
token = ''

# Login
def login():
    global token
    res = requests.post(f'{API_URL}/auth/login', json={
        'username': 'johndoe',
        'password': 'password123'
    })
    token = res.json()['token']
    print('Logged in:', res.json()['user'])

# Get Stocks
def get_stocks():
    res = requests.get(f'{API_URL}/stocks')
    print('Stocks:', res.json())

# Place Order
def place_order():
    res = requests.post(f'{API_URL}/orders', json={
        'symbol': 'MICH',
        'type': 'BUY',
        'price': 1250,
        'quantity': 10
    }, headers={'Authorization': f'Bearer {token}'})
    print('Order placed:', res.json())

# WebSocket
sio = Client()
sio.connect('http://localhost:3000')

@sio.on('price_update')
def on_price_update(data):
    print('Price update:', data)

sio.emit('join_stock', 'MICH')
```

---

## 📝 Notes
- All prices are in Indonesian Rupiah (IDR)
- Quantity is measured in lots (1 lot = 100 shares)
- RDN balance has 4 decimal precision
- Timestamps are in ISO 8601 format (UTC)
- Matching engine uses Price-Time Priority (FIFO)
- Candles are generated every minute via cron job
- User roles: `USER` (default) and `ADMIN`
- Admin endpoints require `ADMIN` role in JWT token

---

## 🔧 Initial Setup

### 1. Database Migration (Add Role Column)
```bash
psql -U michael -d mbit_trading -f mbit_platform/db/migration_add_user_role.sql
```

### 2. Create First Admin User
```sql
-- Option 1: Update existing user to admin
UPDATE users SET role = 'ADMIN' WHERE username = 'your_username';

-- Option 2: Insert new admin user (password: admin123)
INSERT INTO users (username, full_name, password_hash, balance_rdn, role)
VALUES (
    'admin',
    'System Administrator',
    '$2b$10$your_bcrypt_hash_here',  -- Generate at bcrypt-generator.com
    0,
    'ADMIN'
);
```

### 3. Login as Admin
```bash
POST /api/auth/login
{
  "username": "admin",
  "password": "admin123"
}
```

### 4. Create More Admins (Optional)
```bash
POST /api/auth/admin/create
Authorization: Bearer {admin_token}
{
  "username": "admin2",
  "fullName": "Another Admin",
  "password": "securepassword"
}
```

---

## 🔗 Related Files
- Schema: `db/ALL_schema_database.sql`
- Role Migration: `db/migration_add_user_role.sql`
- Candles & Watchlist Migration: `db/migration_add_candles_watchlist.sql`
- Session Rotation: `db/rotate_session.sql`
- Session Fix: `db/quick_fix_current_session.sql`
- Frontend API Client: `mbit_web/src/services/api.ts`
- Auth Middleware: `src/middlewares/auth.ts`

---

## 📊 Database Schema (Updated)

### Users Table
```sql
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(50) UNIQUE NOT NULL,
    full_name     VARCHAR(100) NOT NULL,
    password_hash TEXT NOT NULL,
    balance_rdn   NUMERIC(19,4) DEFAULT 0,
    role          VARCHAR(20) DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Stocks Table
```sql
CREATE TABLE stocks (
    id           SERIAL PRIMARY KEY,
    symbol       VARCHAR(10) UNIQUE NOT NULL,
    name         VARCHAR(100) NOT NULL,
    is_active    BOOLEAN DEFAULT true,
    max_shares   BIGINT DEFAULT 0
);
```

### Trades Table
```sql
CREATE TABLE trades (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buy_order_id  UUID REFERENCES orders,  -- Nullable for BOT orders
    sell_order_id UUID REFERENCES orders,  -- Nullable for BOT orders
    stock_id      INTEGER NOT NULL REFERENCES stocks,
    price         NUMERIC(19,4) NOT NULL,
    quantity      INTEGER NOT NULL,
    executed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Candles Table (Multi-Timeframe)
```sql
CREATE TABLE candles (
    id          SERIAL PRIMARY KEY,
    stock_id    INTEGER NOT NULL REFERENCES stocks ON DELETE CASCADE,
    timeframe   VARCHAR(5) NOT NULL DEFAULT '1m',  -- 1m, 5m, 15m, 1h, 1d
    open_price  NUMERIC(15, 2) NOT NULL,
    high_price  NUMERIC(15, 2) NOT NULL,
    low_price   NUMERIC(15, 2) NOT NULL,
    close_price NUMERIC(15, 2) NOT NULL,
    volume      INTEGER NOT NULL DEFAULT 0,
    timestamp   TIMESTAMP NOT NULL,
    session_id  INTEGER REFERENCES trading_sessions(id) ON DELETE SET NULL,
    created_at  TIMESTAMP DEFAULT now(),
    UNIQUE (stock_id, timeframe, timestamp)
);
```

### Watchlists Table
```sql
CREATE TABLE watchlists (
    id         SERIAL PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    stock_id   INTEGER NOT NULL REFERENCES stocks ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT now(),
    UNIQUE (user_id, stock_id)
);
```

---

**End of API Documentation**

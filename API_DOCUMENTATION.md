# 📚 M-BIT Trading Platform - API Documentation

> **Base URL**: `http://localhost:3000/api`
> **Version**: 1.4.0
> **Last Updated**: January 12, 2026

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
5. [IPO (New)](#ipo)
6. [Portfolio](#portfolio)
7. [Watchlist](#watchlist)
8. [Admin & Session Management](#admin--session-management)
9. [Stock Management (Admin Only)](#stock-management-admin-only)
10. [IPO Management (Admin Only)](#ipo-management-admin-only)
11. [Dividend Management (Admin Only)](#dividend-management-admin-only)
12. [User Management (Admin Only)](#user-management-admin-only)
13. [Bot Management (Admin Only)](#-bot-management-admin-only)
14. [Order & Trade Management (Admin Only)](#-order--trade-management-admin-only)
15. [Matching Engine Management (Admin Only)](#-matching-engine-management-admin-only)
16. [WebSocket Events](#websocket-events)
17. [Error Codes](#error-codes)

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
| `USER` | Regular trader | View market, place orders, manage portfolio, subscribe IPO |
| `ADMIN` | Administrator | All USER permissions + session management, user management, IPO/Dividend management |

### Endpoint Access

| Endpoint | USER | ADMIN |
|----------|------|-------|
| `/auth/register` | ✅ | ✅ |
| `/auth/login` | ✅ | ✅ |
| `/stocks` | ✅ | ✅ |
| `/session` | ✅ | ✅ |
| `/market/*` | ✅ | ✅ |
| `/orders/*` | ✅ | ✅ |
| `/ipo` | ✅ | ✅ |
| `/ipo/:id/subscribe` | ✅ | ✅ |
| `/portfolio` | ✅ | ✅ |
| `/admin/*` | ❌ | ✅ |

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
    "lastPrice": 1250.00,
    "change": 50.00
  }
]
```

---

### Get Orderbook (Public)
**GET** `/market/stocks/:symbol/orderbook`

**Response (200):**
```json
{
  "symbol": "MICH",
  "bids": [{ "price": 1250, "totalQty": 50, "count": 3 }],
  "asks": [{ "price": 1252, "totalQty": 75, "count": 4 }]
}
```

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

**Validation:**
- **Pre-Opening (IEP Phase)**: Orders are accepted but not matched immediately. Matching occurs at a single IEP price when session switches to OPEN.
- **Normal Open**: Orders matched immediately via continuous matching.

---

### Get Order History (Includes Dividends)
**GET** `/orders/history`  
🔒 **Requires Authentication**

**Response (200):**
```json
[
  {
    "id": "uuid",
    "symbol": "MICH",
    "type": "BUY",
    "price": 1248.50,
    "status": "MATCHED",
    "created_at": "2026-01-07T10:30:00Z"
  },
  {
    "id": "uuid-div",
    "symbol": "BBCA",
    "type": "DIVIDEN",
    "price": "-",
    "lot": "-",
    "profit_loss": 500000,
    "status": "MATCHED",
    "created_at": "2026-01-10T10:00:00Z"
  }
]
```

**Notes:**
- `DIVIDEN` entries appear in history with positive `profit_loss` equal to the dividend amount received.

---

## 🆕 IPO

### Get Active IPOs
**GET** `/api/ipo`
🔒 **Requires Authentication**

**Response (200):**
```json
[
  {
    "id": "uuid",
    "stock_name": "PT Tech Baru",
    "symbol": "GOTO",
    "offering_price": 200,
    "total_shares": 10000,
    "status": "ACTIVE"
  }
]
```

### Subscribe IPO
**POST** `/api/ipo/:id/subscribe`
🔒 **Requires Authentication**

**Request Body:**
```json
{
  "quantity": 100
}
```

**Notes:**
- Requires sufficient RDN balance.
- Funds are locked immediately.
- Refunded if allocation is partial or zero upon finalization.

---

## ⚙️ Admin & Session Management

### Open Trading Session (IEP Phase)
**POST** `/admin/session/open`  
🔒 **Requires Admin Authentication**

**Description:**
Opens a new trading session. Starts in `PRE_OPEN` status for a configurable duration (default 15s) to calculate Indicative Equilibrium Price (IEP) before switching to `OPEN`.

**Response (200):**
```json
{
  "message": "Sesi trading dibuka (PRE_OPEN phase for 15s)",
  "session": { ... }
}
```

---

## 🏗️ Stock Management (Admin Only)

(Standard CRUD endpoints remain same)

---

## 🚀 IPO Management (Admin Only)

### Create IPO
**POST** `/admin/ipo`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "stockId": 1,
  "totalShares": 100000,
  "offeringPrice": 250,
  "startOfferingSessionId": 5,
  "endOfferingSessionId": 10,
  "listingSessionId": 11
}
```

### Finalize IPO (Allocate)
**POST** `/admin/ipo/:id/finalize`
🔒 **Requires Admin Authentication**

**Description:**
Calculates allocation ratio based on demand vs supply, distributes shares, and refunds excess funds.

---

## 💰 Dividend Management (Admin Only)

### Distribute Dividend
**POST** `/admin/dividends`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "stockId": 1,
  "amountPerShare": 50,
  "sessionId": 12
}
```

**Description:**
Distributes cash dividends to all current shareholders of the specified stock. Adds record to history as `DIVIDEN`.

---

**End of API Documentation**

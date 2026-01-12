# 📚 M-BIT Trading Platform - API Documentation

> **Base URL**: `http://localhost:3000/api`
> **Version**: 1.4.0
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
(Same as before)

## 👤 User Roles & Permissions
(Same as before)

## 📊 Market Data

### Get All Stocks
**GET** `/stocks`
(Same as before)

### Get Candles (Chart Data)
**GET** `/market/candles/:symbol`
(Same as before)

### Get Daily Stock Data (Historical Session Data)
**GET** `/market/daily-data` (all stocks)  
**GET** `/market/daily-data/:symbol` (specific stock)
(Same as before)

### Get Orderbook (Public)
**GET** `/market/stocks/:symbol/orderbook`
(Same as before)

### Get Order Queue Detail (FIFO Inspection)
**GET** `/market/queue/:symbol`
(Same as before)

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
- Allowed in all active phases (`PRE_OPEN`, `LOCKED`, `OPEN`).
- Refunds RDN for BUY orders
- For SELL orders, the stocks were never deducted from the portfolio (only locked in the orderbook), so cancellation simply releases the lock.

---

## 💰 Portfolio
(Same as before)

## 👁️ Watchlist
(Same as before)

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
- `OPEN`: Continuous trading session active.
- `CLOSED`: Trading session closed.

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
- Automatically injects pending orders from offline/closed state.

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
(Same as before)

---

## 🏗️ Stock Management (Admin Only)
(Same as before)

## 👥 User Management (Admin Only)
(Same as before)

## 🤖 Bot Management (Admin Only)
(Same as before)

## 🧾 Order & Trade Management (Admin Only)
(Same as before)

## ⚡ Matching Engine Management (Admin Only)
(Same as before)

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
(Same as before)

**Listen:** `trade`
(Same as before)

### Join User Room (Receive Personal Order Updates)
**Emit:** `join_user`
(Same as before)

**Listen:** `order_matched`
(Same as before)

**Listen:** `order_status`
(Same as before)

### Receive Orderbook Updates
**Listen:** `orderbook_update`
(Same as before)

### Leave Stock Room
**Emit:** `leave_stock`
```javascript
socket.emit('leave_stock', 'MICH');
```

---

## ❌ Error Codes
(Same as before)

## 🔧 Price Rules & Validation
(Same as before)

## ⚙️ Matching Engine Logic

### Market Phases & IEP
The system now supports **Pre-Opening** mechanism similar to IDX:
1.  **Pre-Open Phase**: Orders are collected but not matched. IEP is calculated based on intersecting supply/demand curves to maximize volume.
2.  **Locked Phase**: No new orders allowed.
3.  **Call Auction (Open)**: All eligible orders are matched at a single IEP price.
4.  **Continuous Trading**: Normal Price-Time Priority matching.

### Price-Time Priority (FIFO)
(Same as before)

### Execution Price Determination
(Same as before)

### Portfolio & Asset Locking
(Same as before)

---
**End of API Documentation**

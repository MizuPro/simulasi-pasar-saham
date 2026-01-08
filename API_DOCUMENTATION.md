# 📚 M-BIT Trading Platform - API Documentation

> **Base URL**: `http://localhost:3000/api`
> **Version**: 1.1.0
> **Last Updated**: January 8, 2026

---

## 📋 Table of Contents
1. [Authentication](#authentication)
2. [User Roles & Permissions](#user-roles--permissions)
3. [Market Data](#market-data)
4. [Trading](#trading)
5. [Portfolio](#portfolio)
6. [Admin & Session Management](#admin--session-management)
7. [User Management (Admin Only)](#user-management-admin-only)
8. [WebSocket Events](#websocket-events)
9. [Error Codes](#error-codes)

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
    "balance_rdn": 100000000,
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
    "balance_rdn": 100000000,
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
| `/orders/*` | ✅ | ✅ |
| `/portfolio` | ✅ | ✅ |
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
    "name": "MICH",
    "is_active": true,
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
    "volume": 5000
  }
]
```

**Notes:**
- `time` is in milliseconds (JavaScript timestamp)
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
    "name": "MICH",
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

### Get Orderbook
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
- Returns stocks to portfolio for SELL orders
- Only cancels PENDING or PARTIAL orders

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
    "type": "BUY",
    "price": 1250,
    "quantity": 10,
    "remaining_quantity": 0,
    "status": "MATCHED",
    "created_at": "2026-01-07T10:30:00Z"
  }
]
```

**Status Values:**
- `PENDING`: Order waiting to be matched
- `PARTIAL`: Order partially filled
- `MATCHED`: Order fully filled
- `CANCELED`: Order canceled by user or system
- `REJECTED`: Order rejected (validation failed)

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
    "type": "SELL",
    "price": 1260,
    "quantity": 5,
    "remaining_quantity": 5,
    "status": "PENDING",
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
      "name": "MICH",
      "quantity_owned": 25,
      "avg_buy_price": 1200.00
    }
  ]
}
```

---

## ⚙️ Admin & Session Management

### Get Session Status
**GET** `/session`

**Response (200):**
```json
{
  "id": 5,
  "status": "OPEN",
  "session_number": 5,
  "started_at": "2026-01-07T09:00:00Z",
  "ended_at": null
}
```

**Status Values:**
- `OPEN`: Trading session active
- `CLOSED`: Trading session closed

---

### Open Trading Session
**POST** `/admin/session/open`  
🔒 **Requires Admin Authentication**

**Response (200):**
```json
{
  "message": "Sesi trading berhasil dibuka",
  "session": {
    "id": 6,
    "session_number": 6,
    "status": "OPEN",
    "started_at": "2026-01-07T09:00:00Z"
  }
}
```

**Notes:**
- Automatically calculates ARA/ARB limits for all active stocks
- Uses last candle close price or default 1000
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
    "balance_rdn": 100000000,
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
    "balance_rdn": 100000000,
    "role": "ADMIN",
    "created_at": "2026-01-01T00:00:00Z"
  },
  {
    "id": "uuid-2",
    "username": "johndoe",
    "full_name": "John Doe",
    "balance_rdn": 95000000,
    "role": "USER",
    "created_at": "2026-01-07T10:00:00Z"
  }
]
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
**PUT** `/auth/admin/users/:userId/balance`
🔒 **Requires Admin Authentication**

**Request Body:**
```json
{
  "amount": 5000000,
  "reason": "Top up promo"
}
```

**Fields:**
- `amount`: Number of RDN to add (positive) or deduct (negative); zero is rejected
- `reason`: Optional text for auditing/logging, trims leading/trailing whitespace

**Response (200):**
```json
{
  "message": "Balance pengguna berhasil diperbarui",
  "change": 5000000,
  "reason": "Top up promo",
  "user": {
    "id": "uuid-here",
    "username": "johndoe",
    "full_name": "John Doe",
    "balance_rdn": 105000000,
    "role": "USER",
    "created_at": "2026-01-07T10:00:00Z"
  }
}
```

**Validation & Notes:**
- `amount` must be a non-zero number; negative values deduct balance if the resulting balance stays ≥ 0
- Requests without `reason` still succeed and return `null` for the reason field
- Attempts that would make the balance negative return `400` with `Balance tidak boleh negatif`
- Attempts with `amount` equal to `0` return `400` with `Amount tidak boleh nol`
- Always include `Authorization: Bearer {token}` header from an admin session
- Use this endpoint when adjusting user RDN for promos, penalties, or corrections

**Example (curl):**
```bash
curl -X PUT \
  http://localhost:3000/api/auth/admin/users/9167fa5d-8c50-4459-aeef-a361866659d7/balance \
  -H "Authorization: Bearer {admin-token}" \
  -H "Content-Type: application/json" \
  -d '{"amount": 2500000, "reason": "Kompensasi error perdagangan"}'
```

**Error Responses (400):**
```json
{
  "error": "Amount tidak boleh nol"
}
```
```json
{
  "error": "Balance tidak boleh negatif"
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

**Listen:** `order_update`
```javascript
socket.on('order_update', (data) => {
  console.log(data);
  // {
  //   orderId: 'uuid',
  //   status: 'MATCHED',
  //   remaining_quantity: 0
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
    100000000,
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
- Schema: `schema.sql`
- Role Migration: `db/migration_add_user_role.sql`
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

---

**End of API Documentation**


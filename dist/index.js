"use strict";
// index.ts - REVISI FINAL
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const database_1 = __importStar(require("./config/database"));
const redis_1 = __importStar(require("./config/redis"));
const node_cron_1 = __importDefault(require("node-cron"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
// Import Routes
const auth_1 = __importDefault(require("./routes/auth"));
const order_1 = __importDefault(require("./routes/order")); // Pastikan nama file 'order' atau 'orders' (sesuaikan)
const market_1 = __importDefault(require("./routes/market"));
const info_1 = __importDefault(require("./routes/info")); // Route gabungan baru
const admin_1 = __importDefault(require("./routes/admin")); // Route admin lama (Login Admin dll)
// Import Core Logic
const matching_engine_1 = require("./core/matching-engine");
const market_service_1 = require("./services/market-service");
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
// 1. Setup WebSocket (Socket.IO)
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: "*", // Allow semua origin buat socket biar gak ribet
        methods: ["GET", "POST"]
    },
    // CRITICAL: Limit connections and buffer to prevent flooding
    maxHttpBufferSize: 1e6, // 1MB max message size
    pingTimeout: 60000, // 60s ping timeout
    pingInterval: 25000, // Ping every 25s
    connectTimeout: 45000, // 45s connection timeout
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    perMessageDeflate: false, // Disable compression to save CPU
    httpCompression: false,
});
// Masukin instance IO ke Engine biar bisa notif realtime
matching_engine_1.MatchingEngine.initialize(io);
// 2. Setup Middleware Global
app.use((0, cors_1.default)({
    origin: '*', // UBAH JADI '*' sementara biar Frontend (port berapapun) bisa masuk
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express_1.default.json());
// 2. Setup Middleware Global & Rate Limiting
const generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60000, // 1 minute
    max: 100,
    message: { error: 'Terlalu banyak request, coba lagi nanti' },
    standardHeaders: true,
    legacyHeaders: false,
});
const tradingLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60000, // 1 minute
    max: 300, // Lebih longgar untuk bot (rata-rata 5 req/detik)
    message: { error: 'Bot trading Anda terlalu cepat (max 300/menit)' },
    standardHeaders: true,
    legacyHeaders: false,
});
// Terapkan limiters secara spesifik sebelum mounting routes
app.use('/api/orders', tradingLimiter);
app.use('/api/auth', generalLimiter);
app.use('/api/market', generalLimiter);
app.use('/api/admin', generalLimiter);
// Endpoint lain yang mungkin diakses lewat /api (seperti portfolio)
app.use('/api/portfolio', generalLimiter);
app.use('/api/stocks', generalLimiter);
// 3. Cron Job (Jalan tiap 1 MENIT, bukan tiap detik!)
// PENTING: '*/1 * * * *' = every 1 minute (bukan setiap detik!)
node_cron_1.default.schedule('*/1 * * * *', async () => {
    try {
        await market_service_1.MarketService.generateOneMinuteCandles();
    }
    catch (error) {
        console.error('⚠️ Cron job error:', error);
    }
});
console.log('⏰ Market Data Scheduler Started (every 1 minute)');
// 4. WebSocket Event Handler
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    // Join Room Saham (untuk terima update harga saham tertentu)
    socket.on('join_stock', (symbol) => {
        socket.join(symbol);
        console.log(`📈 User joined stock room: ${symbol}`);
    });
    // Leave Room Saham
    socket.on('leave_stock', (symbol) => {
        socket.leave(symbol);
        console.log(`📉 User left stock room: ${symbol}`);
    });
    // Join Personal Room (untuk terima notifikasi order pribadi)
    socket.on('join_user', (userId) => {
        socket.join(`user:${userId}`);
        console.log(`👤 User ${userId} joined personal room`);
    });
    // Disconnect handler
    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});
// 5. DAFTAR ROUTES (Urutan Penting!)
app.use('/api/auth', auth_1.default);
app.use('/api/orders', order_1.default);
app.use('/api/market', market_1.default);
app.use('/api/admin', admin_1.default);
// Route Info & Portfolio (Ini yang nangkep /api/stocks dan /api/portfolio)
app.use('/api', info_1.default);
// Route Session Admin (Ini buat nangkep /api/admin/session)
app.use('/api/admin', info_1.default);
// 6. Endpoint Cek Status Server
app.get('/', async (req, res) => {
    try {
        const dbTest = await database_1.default.query('SELECT NOW()');
        res.json({
            status: 'Online 🟢',
            message: 'M-bit Trading Engine Ready',
            time: dbTest.rows[0].now,
            socket_status: 'Active'
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Database connection failed' });
    }
});
// 7. Start Server
const port = 3000;
httpServer.listen(port, () => {
    console.log(`🚀 Server Backend Running at http://localhost:${port}`);
});
// 8. Graceful Shutdown Handler
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM received, shutting down gracefully...');
    await gracefulShutdown();
});
process.on('SIGINT', async () => {
    console.log('⚠️ SIGINT received, shutting down gracefully...');
    await gracefulShutdown();
});
async function gracefulShutdown() {
    try {
        console.log('🔄 Starting graceful shutdown...');
        // Close HTTP server first
        httpServer.close(() => {
            console.log('✅ HTTP server closed');
        });
        // Close Socket.IO connections
        io.close(() => {
            console.log('✅ Socket.IO closed');
        });
        // Close database pool
        await (0, database_1.closePool)();
        console.log('✅ Database pool closed');
        // Close all Redis connections
        await redis_1.default.quit();
        console.log('✅ Redis main connection closed');
        await redis_1.redisLock.quit();
        console.log('✅ Redis lock connection closed');
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
    }
    catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
}

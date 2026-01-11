// index.ts - REVISI FINAL

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pool, { closePool } from './config/database';
import redis, { redisLock } from './config/redis';
import cron from 'node-cron';
import rateLimit from 'express-rate-limit';

// Import Routes
import authRoutes from './routes/auth';
import orderRoutes from './routes/order'; // Pastikan nama file 'order' atau 'orders' (sesuaikan)
import marketRoutes from './routes/market';
import infoRoutes from './routes/info'; // Route gabungan baru
import adminRoutes from './routes/admin'; // Route admin lama (Login Admin dll)

// Import Core Logic
import { MatchingEngine } from './core/matching-engine';
import { MarketService } from './services/market-service';

const app = express();
const httpServer = createServer(app);

// 1. Setup WebSocket (Socket.IO)
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allow semua origin buat socket biar gak ribet
        methods: ["GET", "POST"]
    },
    // CRITICAL: Limit connections and buffer to prevent flooding
    maxHttpBufferSize: 1e6,        // 1MB max message size
    pingTimeout: 60000,            // 60s ping timeout
    pingInterval: 25000,           // Ping every 25s
    connectTimeout: 45000,         // 45s connection timeout
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    perMessageDeflate: false,      // Disable compression to save CPU
    httpCompression: false,
});

// Masukin instance IO ke Engine biar bisa notif realtime
MatchingEngine.initialize(io);

// 2. Setup Middleware Global
app.use(cors({
    origin: '*', // UBAH JADI '*' sementara biar Frontend (port berapapun) bisa masuk
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 2. Setup Middleware Global & Rate Limiting

// Limit khusus Auth (Login/Register) - Cukup ketat untuk security
const authLimiter = rateLimit({
    windowMs: 60000, // 1 minute
    max: 200, // 200 requests per minute (approx 3 req/sec)
    message: { error: 'Terlalu banyak request login/register, coba lagi nanti' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Limit untuk Data (Market, Stocks, Portfolio) - Lebih longgar untuk BOT/Frontend
const dataLimiter = rateLimit({
    windowMs: 60000, // 1 minute
    max: 5000, // 5,000 requests per minute (approx 83 req/sec)
    message: { error: 'Terlalu banyak request data, slow down bot!' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Limit khusus Trading (Order) - Sangat longgar untuk High Frequency Trading
const tradingLimiter = rateLimit({
    windowMs: 60000, // 1 minute
    max: 10000, // 10,000 requests per minute (approx 160 req/sec) to support high throughput
    message: { error: 'Bot trading Anda terlalu cepat (max 10000/menit)' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Terapkan limiters secara spesifik sebelum mounting routes
app.use('/api/orders', tradingLimiter);

app.use('/api/auth', authLimiter);

// Gunakan dataLimiter untuk endpoint yang sering di-hit bot/dashboard
app.use('/api/market', dataLimiter);
app.use('/api/admin', dataLimiter); // Admin juga butuh load data banyak
app.use('/api/portfolio', dataLimiter);
app.use('/api/stocks', dataLimiter);

// 3. Cron Job (Jalan tiap 1 MENIT, bukan tiap detik!)
// PENTING: '*/1 * * * *' = every 1 minute (bukan setiap detik!)
cron.schedule('*/1 * * * *', async () => {
    try {
        await MarketService.generateOneMinuteCandles();
    } catch (error) {
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
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/admin', adminRoutes);

// Route Info & Portfolio (Ini yang nangkep /api/stocks dan /api/portfolio)
app.use('/api', infoRoutes);

// Route Session Admin (Ini buat nangkep /api/admin/session)
app.use('/api/admin', infoRoutes);

// 6. Endpoint Cek Status Server
app.get('/', async (req, res) => {
    try {
        const dbTest = await pool.query('SELECT NOW()');
        res.json({
            status: 'Online 🟢',
            message: 'M-bit Trading Engine Ready',
            time: dbTest.rows[0].now,
            socket_status: 'Active'
        });
    } catch (err) {
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
        await closePool();
        console.log('✅ Database pool closed');

        // Close all Redis connections
        await redis.quit();
        console.log('✅ Redis main connection closed');

        await redisLock.quit();
        console.log('✅ Redis lock connection closed');

        console.log('✅ Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
}


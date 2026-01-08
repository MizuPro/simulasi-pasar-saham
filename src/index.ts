// index.ts - REVISI FINAL

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pool from './config/database';
import cron from 'node-cron';

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
    }
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

// 3. Cron Job (Jalan tiap menit detik ke-0)
cron.schedule('0 * * * * *', () => {
    MarketService.generateOneMinuteCandles();
});
console.log('⏰ Market Data Scheduler Started');

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
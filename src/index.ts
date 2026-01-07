import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pool from './config/database';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import portfolioRoutes from './routes/portfolio';
import orderRoutes from './routes/order';
import { MatchingEngine } from './core/matching-engine'; // Pastiin ini ke-import
import redis from './config/redis';

const app = express();
const httpServer = createServer(app); // Bungkus app Express
const io = new Server(httpServer, {
    cors: { origin: "*" } // Biar Frontend aman dari CORS
});

// >>> BAGIAN PENTING (REVISI) <<<
// Kita masukin instance 'io' ke dalam Matching Engine
// Biar dia bisa kirim notifikasi pas ada match
MatchingEngine.initialize(io);

app.use(express.json());

// Kita simpan instance 'io' biar bisa dipake di file lain (opsional, tapi bagus buat backup)
app.set('socketio', io);

// Event Handler WebSocket
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // User bisa "Join Room" berdasarkan kode saham, misal 'MICH'
    socket.on('join_stock', (symbol) => {
        socket.join(symbol);
        console.log(`📈 User joined room: ${symbol}`);
    });
});

// Daftar Route API
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/orders', orderRoutes);

const port = 3000;

// Endpoint Root buat Cek Status
app.get('/', async (req, res) => {
    try {
        const dbTest = await pool.query('SELECT NOW()');
        res.json({
            message: 'M-bit API is Running!',
            database: 'Connected',
            db_time: dbTest.rows[0].now,
            redis: 'Connected'
        });
    } catch (err) {
        res.status(500).json({ error: 'Database connection failed' });
    }
});

// Jalankan Server (Pakai httpServer, BUKAN app.listen)
httpServer.listen(port, () => {
    console.log(`🚀 M-bit API & WebSocket running at http://localhost:${port}`);
});
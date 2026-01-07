import express from 'express';
import pool from './config/database';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import portfolioRoutes from './routes/portfolio';
import orderRoutes from './routes/order';
import redis from './config/redis';

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/orders', orderRoutes);

const port = 3000;

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

app.listen(port, () => {
    console.log(`🚀 M-bit API running at http://localhost:${port}`);
});
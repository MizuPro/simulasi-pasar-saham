// config/database.ts

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5433'),

    // CRITICAL: Limit connections to prevent exhaustion
    max: 20,                    // Maximum 20 connections
    min: 2,                     // Minimum 2 idle connections
    idleTimeoutMillis: 30000,   // Close idle connections after 30s
    connectionTimeoutMillis: 10000, // Wait max 10s for connection
    allowExitOnIdle: false,

    // Query timeout to prevent hanging queries
    statement_timeout: 30000,   // Kill query after 30s
});

// Cek koneksi saat startup
pool.on('connect', () => {
    console.log('✅ PostgreSQL connected successfully');
});

pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    // Don't exit immediately - just log the error
});

// Log pool status periodically (untuk monitoring)
setInterval(() => {
    console.log(`📊 DB Pool: Total=${pool.totalCount}, Idle=${pool.idleCount}, Waiting=${pool.waitingCount}`);
}, 60000); // Every 60 seconds

export default pool;
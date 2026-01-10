// config/database.ts

import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const poolConfig: PoolConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5433'),

    // HIGH-THROUGHPUT CONFIG for 100+ TPS
    max: 60,                        // Increase max connections for high load
    min: 10,                        // Higher minimum idle connections ready
    idleTimeoutMillis: 120000,      // Keep idle connections longer (2 min)
    connectionTimeoutMillis: 10000, // 10s connection timeout
    allowExitOnIdle: false,

    // Query timeout to prevent hanging queries
    statement_timeout: 10000,       // Kill query after 10s (was 15s)

    // Application name for monitoring
    application_name: 'mbit_matching_engine',
};

const pool = new Pool(poolConfig);

// Connection event handlers
pool.on('connect', (client) => {
    // Set per-connection optimizations
    client.query('SET statement_timeout = 10000');
    client.query('SET idle_in_transaction_session_timeout = 30000'); // 30s idle in transaction
});

pool.on('error', (err, client) => {
    console.error('❌ Unexpected error on idle client', err.message);
    // Try to remove dead connection from pool
    try {
        client?.release(true); // force release with error
    } catch (e) {
        // Ignore
    }
});

pool.on('acquire', () => {
    // Track connection acquisition (optional debugging)
});

pool.on('remove', () => {
    // Connection removed from pool
});

// Warmup pool: Pre-create minimum connections
async function warmupPool() {
    const warmupConnections = [];
    const targetConnections = poolConfig.min || 10;

    for (let i = 0; i < targetConnections; i++) {
        try {
            warmupConnections.push(pool.connect());
        } catch (e) {
            // Ignore warmup errors
        }
    }

    const clients = await Promise.allSettled(warmupConnections);
    const successCount = clients.filter(r => r.status === 'fulfilled').length;

    clients.forEach(result => {
        if (result.status === 'fulfilled') {
            result.value.release();
        }
    });

    console.log(`✅ PostgreSQL pool warmed up: ${successCount}/${targetConnections} connections ready`);
}

warmupPool().catch(console.error);

// Log pool status periodically (untuk monitoring)
setInterval(() => {
    const waiting = pool.waitingCount;
    const utilization = ((pool.totalCount - pool.idleCount) / pool.totalCount * 100).toFixed(1);

    // Only warn if high utilization
    if (waiting > 0 || parseFloat(utilization) > 80) {
        console.warn(`⚠️ DB Pool: Total=${pool.totalCount}, Active=${pool.totalCount - pool.idleCount}, Idle=${pool.idleCount}, Waiting=${waiting} (${utilization}% utilized)`);
    } else {
        console.log(`📊 DB Pool: Total=${pool.totalCount}, Active=${pool.totalCount - pool.idleCount}, Idle=${pool.idleCount}, Waiting=${waiting} (${utilization}% utilized)`);
    }
}, 60000);

// Health check function
export async function checkDbHealth(): Promise<{ healthy: boolean; latency: number; stats: any }> {
    const start = Date.now();
    try {
        await pool.query('SELECT 1');
        return {
            healthy: true,
            latency: Date.now() - start,
            stats: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount
            }
        };
    } catch (err) {
        return {
            healthy: false,
            latency: Date.now() - start,
            stats: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount
            }
        };
    }
}

// Graceful shutdown helper
export async function closePool(): Promise<void> {
    console.log('🔄 Closing database pool...');
    await pool.end();
    console.log('✅ Database pool closed');
}

export default pool;
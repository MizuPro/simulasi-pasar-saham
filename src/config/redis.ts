// config/redis.ts

import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),

    // CRITICAL: Prevent connection flooding
    maxRetriesPerRequest: 3,        // Max 3 retries per request
    connectTimeout: 10000,          // Connect timeout 10s
    commandTimeout: 5000,           // Command timeout 5s
    enableOfflineQueue: true,       // Queue commands when offline
    retryStrategy(times) {
        if (times > 3) {
            console.error('❌ Redis connection failed after 3 retries');
            return null; // Stop retrying
        }
        return Math.min(times * 200, 2000); // Exponential backoff
    },
    reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNREFUSED'];
        if (targetErrors.some(targetError => err.message.includes(targetError))) {
            return true; // Reconnect on specific errors
        }
        return false;
    },
    lazyConnect: false,             // Connect immediately
    keepAlive: 30000,               // Keep connection alive
    enableReadyCheck: true,
});

redis.on('connect', () => {
    console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
    console.error('❌ Redis error:', err.message);
    // Don't crash the app - just log
});

redis.on('close', () => {
    console.warn('⚠️ Redis connection closed');
});

export default redis;
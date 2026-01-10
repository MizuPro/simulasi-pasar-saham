// config/redis.ts

import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
};

// Main Redis Instance - untuk operasi standard
const redis = new Redis({
    ...redisConfig,

    // HIGH-PERFORMANCE CONFIG for 100+ TPS
    maxRetriesPerRequest: 5,       // Increased retries
    connectTimeout: 10000,         // 10s connect timeout
    commandTimeout: 5000,          // 5s command timeout
    enableOfflineQueue: true,
    retryStrategy(times) {
        if (times > 10) {
            console.error('❌ Redis connection failed after 10 retries');
            return null;
        }
        const delay = Math.min(times * 50, 2000); // Exponential backoff, max 2s
        console.log(`⚠️ Redis retry attempt ${times}, waiting ${delay}ms`);
        return delay;
    },
    reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTCONN', 'ECONNRESET'];
        return targetErrors.some(targetError => err.message.includes(targetError));
    },
    lazyConnect: false,
    keepAlive: 5000,               // Aggressive keepalive
    enableReadyCheck: true,

    // CRITICAL: DISABLE auto-pipelining to prevent command reordering bugs
    // Auto-pipelining can cause race conditions in order book updates
    enableAutoPipelining: false,

    // Socket options for stability
    family: 4, // Force IPv4
    noDelay: true, // Disable Nagle's algorithm for lower latency
});

// Dedicated connection untuk pub/sub (tidak blocking main connection)
const redisSub = new Redis({
    ...redisConfig,
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: true,
});

// Dedicated connection untuk locks (isolated dari main traffic)
const redisLock = new Redis({
    ...redisConfig,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    commandTimeout: 2000,
    enableAutoPipelining: false, // Disable for lock operations
});

redis.on('connect', () => {
    console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
    console.error('❌ Redis error:', err.message);
});

redis.on('close', () => {
    console.warn('⚠️ Redis connection closed');
});

redis.on('reconnecting', (delay: number) => {
    console.log(`🔄 Redis reconnecting in ${delay}ms`);
});

redisLock.on('error', (err) => {
    console.error('❌ Redis Lock error:', err.message);
});

// Helper untuk batch operations dengan pipeline dan retry
export async function redisPipeline(commands: Array<[string, ...any[]]>, retries = 3): Promise<any[]> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const pipeline = redis.pipeline();
            for (const [cmd, ...args] of commands) {
                (pipeline as any)[cmd](...args);
            }
            const results = await pipeline.exec();
            if (!results) return [];

            // Check for errors in pipeline results
            const errors = results.filter(r => r[0] !== null);
            if (errors.length > 0) {
                console.warn(`⚠️ Pipeline had ${errors.length} errors:`, errors.map(e => e[0]));
            }

            return results.map(r => r[1]);
        } catch (err: any) {
            console.error(`❌ Redis pipeline attempt ${attempt} failed:`, err.message);
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, 50 * attempt)); // Backoff
        }
    }
    return [];
}

// Helper untuk atomic orderbook operations dengan retry
export async function atomicOrderbookUpdate(
    symbol: string,
    side: 'buy' | 'sell',
    action: 'add' | 'remove',
    price: number,
    payload: string,
    retries = 3
): Promise<boolean> {
    const key = `orderbook:${symbol}:${side}`;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            if (action === 'add') {
                await redis.zadd(key, price, payload);
            } else {
                await redis.zrem(key, payload);
            }
            return true;
        } catch (err: any) {
            console.error(`Redis atomic update attempt ${attempt} failed:`, err.message);
            if (attempt === retries) return false;
            await new Promise(resolve => setTimeout(resolve, 30 * attempt));
        }
    }
    return false;
}

// Distributed lock untuk symbol-level locking
export async function acquireLock(key: string, ttlMs: number = 5000): Promise<string | null> {
    const lockKey = `lock:${key}`;
    const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
        const result = await redisLock.set(lockKey, lockValue, 'PX', ttlMs, 'NX');
        return result === 'OK' ? lockValue : null;
    } catch (err) {
        console.error('❌ Failed to acquire lock:', err);
        return null;
    }
}

export async function releaseLock(key: string, lockValue: string): Promise<boolean> {
    const lockKey = `lock:${key}`;

    // Use Lua script for atomic check-and-delete
    const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `;

    try {
        const result = await redisLock.eval(script, 1, lockKey, lockValue);
        return result === 1;
    } catch (err) {
        console.error('❌ Failed to release lock:', err);
        return false;
    }
}

// Extend lock TTL if still holding it
export async function extendLock(key: string, lockValue: string, ttlMs: number = 5000): Promise<boolean> {
    const lockKey = `lock:${key}`;

    const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
        else
            return 0
        end
    `;

    try {
        const result = await redisLock.eval(script, 1, lockKey, lockValue, ttlMs.toString());
        return result === 1;
    } catch (err) {
        console.error('❌ Failed to extend lock:', err);
        return false;
    }
}

export { redisSub, redisLock };
export default redis;
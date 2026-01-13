package config

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	RedisMain *redis.Client
	RedisSub  *redis.Client
	RedisLock *redis.Client
	Ctx       = context.Background()
)

func ConnectRedis() {
	host := GetEnv("REDIS_HOST", "127.0.0.1")
	portStr := GetEnv("REDIS_PORT", "6379")
	port, _ := strconv.Atoi(portStr)

	addr := fmt.Sprintf("%s:%d", host, port)

	// Main Redis Client
	RedisMain = redis.NewClient(&redis.Options{
		Addr:            addr,
		MaxRetries:      5,
		DialTimeout:     10 * time.Second,
		ReadTimeout:     5 * time.Second,
		WriteTimeout:    5 * time.Second,
		PoolSize:        50, // Increase pool size for high concurrency
		MinIdleConns:    10,
		ConnMaxIdleTime: 5 * time.Minute,
	})

	// Sub Redis Client (Dedicated)
	RedisSub = redis.NewClient(&redis.Options{
		Addr:         addr,
		MaxRetries:   3,
		DialTimeout:  10 * time.Second,
		MinIdleConns: 1, // Only need one for pub/sub usually
	})

	// Lock Redis Client (Dedicated)
	RedisLock = redis.NewClient(&redis.Options{
		Addr:         addr,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	})

	// Check Connections
	if _, err := RedisMain.Ping(Ctx).Result(); err != nil {
		log.Fatalf("❌ Redis Main connection failed: %v", err)
	}
	if _, err := RedisLock.Ping(Ctx).Result(); err != nil {
		log.Fatalf("❌ Redis Lock connection failed: %v", err)
	}

	// We don't ping Sub aggressively as it might be blocking if we subscribed immediately,
	// but here it's just a client.
	if _, err := RedisSub.Ping(Ctx).Result(); err != nil {
		log.Fatalf("❌ Redis Sub connection failed: %v", err)
	}

	log.Println("✅ Redis connected successfully (Main, Sub, Lock)")
}

func CloseRedis() {
	if RedisMain != nil {
		RedisMain.Close()
	}
	if RedisSub != nil {
		RedisSub.Close()
	}
	if RedisLock != nil {
		RedisLock.Close()
	}
	log.Println("✅ Redis connections closed")
}

# MONITORING REDIS ORDERBOOK
# Script untuk memeriksa status order book dan mencari anomali

Write-Host "=== REDIS ORDERBOOK MONITOR ===" -ForegroundColor Cyan
Write-Host ""

# Get all orderbook keys
$keys = docker exec redis_mbit redis-cli KEYS "orderbook:*"

if ($keys) {
    foreach ($key in $keys) {
        Write-Host "Checking: $key" -ForegroundColor Yellow

        # Count orders
        $count = docker exec redis_mbit redis-cli ZCARD $key
        Write-Host "  Total Orders: $count"

        # Get sample orders
        $orders = docker exec redis_mbit redis-cli ZRANGE $key 0 4 WITHSCORES

        if ($orders) {
            Write-Host "  Sample Orders:" -ForegroundColor Green
            for ($i = 0; $i -lt $orders.Length; $i += 2) {
                $orderJson = $orders[$i]
                $price = $orders[$i + 1]

                try {
                    $order = $orderJson | ConvertFrom-Json
                    Write-Host "    Price: $price | Qty: $($order.remaining_quantity) | ID: $($order.orderId)"
                } catch {
                    Write-Host "    CORRUPT DATA: $orderJson" -ForegroundColor Red
                }
            }
        }
        Write-Host ""
    }
} else {
    Write-Host "No orderbook keys found!" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== REDIS INFO ===" -ForegroundColor Cyan
docker exec redis_mbit redis-cli INFO Stats | Select-String "total_commands_processed|instantaneous_ops_per_sec|rejected_connections"

Write-Host ""
Write-Host "=== REDIS MEMORY ===" -ForegroundColor Cyan
docker exec redis_mbit redis-cli INFO Memory | Select-String "used_memory_human|used_memory_peak_human|maxmemory_human"

Write-Host ""
Write-Host "=== CHECK LOCKS ===" -ForegroundColor Cyan
$locks = docker exec redis_mbit redis-cli KEYS "lock:*"
if ($locks) {
    Write-Host "Active Locks: $($locks.Length)" -ForegroundColor Yellow
    foreach ($lock in $locks) {
        $ttl = docker exec redis_mbit redis-cli PTTL $lock
        Write-Host "  $lock : TTL = $ttl ms"
    }
} else {
    Write-Host "No active locks" -ForegroundColor Green
}


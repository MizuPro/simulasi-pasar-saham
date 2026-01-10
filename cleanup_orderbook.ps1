# CLEANUP SCRIPT untuk Order Book yang Bug
# Gunakan jika order book mengalami corruption

Write-Host "=== ORDERBOOK CLEANUP UTILITY ===" -ForegroundColor Red
Write-Host ""

$confirm = Read-Host "This will clean invalid orders from Redis. Continue? (yes/no)"

if ($confirm -ne "yes") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit
}

Write-Host ""
Write-Host "Scanning for invalid orders..." -ForegroundColor Cyan

# Get all orderbook keys
$keys = docker exec redis_mbit redis-cli KEYS "orderbook:*"

$totalCleaned = 0

foreach ($key in $keys) {
    Write-Host "Processing: $key" -ForegroundColor Yellow

    # Get all orders
    $orders = docker exec redis_mbit redis-cli ZRANGE $key 0 -1

    $invalidCount = 0

    foreach ($orderJson in $orders) {
        try {
            $order = $orderJson | ConvertFrom-Json

            # Validate order
            $isInvalid = $false

            if (-not $order.orderId) { $isInvalid = $true }
            if (-not $order.userId) { $isInvalid = $true }
            if ($order.remaining_quantity -le 0) { $isInvalid = $true }
            if ($order.price -le 0) { $isInvalid = $true }

            if ($isInvalid) {
                # Remove invalid order
                docker exec redis_mbit redis-cli ZREM $key $orderJson | Out-Null
                $invalidCount++
                Write-Host "  Removed: $($order.orderId)" -ForegroundColor Red
            }

        } catch {
            # Corrupt JSON - remove it
            docker exec redis_mbit redis-cli ZREM $key $orderJson | Out-Null
            $invalidCount++
            Write-Host "  Removed CORRUPT entry" -ForegroundColor Red
        }
    }

    $totalCleaned += $invalidCount

    if ($invalidCount -eq 0) {
        Write-Host "  ✓ No invalid orders found" -ForegroundColor Green
    } else {
        Write-Host "  Cleaned $invalidCount invalid orders" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== CLEANUP COMPLETE ===" -ForegroundColor Green
Write-Host "Total invalid orders removed: $totalCleaned"

if ($totalCleaned -gt 0) {
    Write-Host ""
    Write-Host "Recommendation: Restart your backend server to ensure consistency." -ForegroundColor Cyan
}


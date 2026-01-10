# Troubleshooting Script - Check for common issues
Write-Host "🔍 M-BIT Platform Troubleshooting" -ForegroundColor Cyan
Write-Host "==================================`n" -ForegroundColor Cyan

$issues = @()

# 1. Check Docker
Write-Host "1. Checking Docker Desktop..." -ForegroundColor Yellow
$docker = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
if ($docker) {
    Write-Host "   ✅ Docker Desktop is running" -ForegroundColor Green
} else {
    Write-Host "   ❌ Docker Desktop is NOT running" -ForegroundColor Red
    $issues += "Docker Desktop not running"
}

# 2. Check Docker Containers
Write-Host "`n2. Checking Docker containers..." -ForegroundColor Yellow
$containers = docker-compose ps 2>&1
Write-Host $containers

# 3. Check PostgreSQL Connection
Write-Host "`n3. Testing PostgreSQL connection..." -ForegroundColor Yellow
try {
    $env:PGPASSWORD = "123"
    $pgTest = psql -U michael -h localhost -p 5433 -d mbit_db -c "SELECT 1;" 2>&1
    if ($pgTest -match "1 row") {
        Write-Host "   ✅ PostgreSQL connection OK" -ForegroundColor Green
    } else {
        Write-Host "   ❌ PostgreSQL connection failed" -ForegroundColor Red
        $issues += "PostgreSQL not accessible"
    }
} catch {
    Write-Host "   ⚠️  Could not test PostgreSQL (psql not installed or DB not running)" -ForegroundColor Yellow
}

# 4. Check Redis Connection
Write-Host "`n4. Testing Redis connection..." -ForegroundColor Yellow
$redisPing = redis-cli ping 2>&1
if ($redisPing -eq "PONG") {
    Write-Host "   ✅ Redis connection OK" -ForegroundColor Green

    # Check orderbook keys
    $orderbookKeys = redis-cli KEYS "orderbook:*"
    if ($orderbookKeys) {
        Write-Host "   📊 Orderbook keys in Redis:" -ForegroundColor Cyan
        Write-Host "   $orderbookKeys"
    } else {
        Write-Host "   ℹ️  No orderbook keys in Redis" -ForegroundColor Gray
    }
} else {
    Write-Host "   ❌ Redis connection failed" -ForegroundColor Red
    $issues += "Redis not accessible"
}

# 5. Check Port 3000
Write-Host "`n5. Checking port 3000..." -ForegroundColor Yellow
$port3000 = netstat -ano | findstr ":3000.*LISTENING"
if ($port3000) {
    Write-Host "   ⚠️  Port 3000 is IN USE:" -ForegroundColor Yellow
    $port3000 -split "`n" | ForEach-Object {
        if ($_ -match '\s+(\d+)\s*$') {
            $pid = $matches[1]
            $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($process) {
                Write-Host "      PID $pid : $($process.ProcessName)" -ForegroundColor Yellow
            }
        }
    }
    $issues += "Port 3000 in use"
} else {
    Write-Host "   ✅ Port 3000 is available" -ForegroundColor Green
}

# 6. Check if session is open
Write-Host "`n6. Checking trading session status..." -ForegroundColor Yellow
try {
    $env:PGPASSWORD = "123"
    $sessionCheck = psql -U michael -h localhost -p 5433 -d mbit_db -t -c "SELECT status FROM trading_sessions WHERE status='OPEN' LIMIT 1;" 2>&1
    if ($sessionCheck -match "OPEN") {
        Write-Host "   ✅ Trading session is OPEN" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  No OPEN trading session" -ForegroundColor Yellow
        Write-Host "      You need to open a session via /api/admin/session/open" -ForegroundColor Gray
        $issues += "No open trading session"
    }
} catch {
    Write-Host "   ⚠️  Could not check session status" -ForegroundColor Yellow
}

# 7. Check if there are pending orders
Write-Host "`n7. Checking for pending orders..." -ForegroundColor Yellow
try {
    $env:PGPASSWORD = "123"
    $pendingOrders = psql -U michael -h localhost -p 5433 -d mbit_db -t -c "SELECT COUNT(*) FROM orders WHERE status IN ('PENDING', 'PARTIAL');" 2>&1
    if ($pendingOrders -match "\d+") {
        $count = $pendingOrders.Trim()
        Write-Host "   📝 Pending/Partial orders: $count" -ForegroundColor Cyan

        if ([int]$count -gt 0) {
            Write-Host "`n   Recent pending orders:" -ForegroundColor Cyan
            $recentOrders = psql -U michael -h localhost -p 5433 -d mbit_db -c "SELECT o.id, o.type, s.symbol, o.price, o.quantity, o.remaining_quantity, o.status, o.created_at FROM orders o JOIN stocks s ON o.stock_id = s.id WHERE o.status IN ('PENDING', 'PARTIAL') ORDER BY o.created_at DESC LIMIT 5;" 2>&1
            Write-Host $recentOrders
        }
    }
} catch {
    Write-Host "   ⚠️  Could not check orders" -ForegroundColor Yellow
}

# Summary
Write-Host "`n================================" -ForegroundColor Cyan
Write-Host "📊 SUMMARY" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

if ($issues.Count -eq 0) {
    Write-Host "✅ No issues detected! System should be ready." -ForegroundColor Green
    Write-Host "`nYou can start the server with:" -ForegroundColor Yellow
    Write-Host "   npm run dev" -ForegroundColor White
} else {
    Write-Host "❌ Issues found:" -ForegroundColor Red
    foreach ($issue in $issues) {
        Write-Host "   - $issue" -ForegroundColor Yellow
    }
    Write-Host "`n🔧 Recommended actions:" -ForegroundColor Yellow
    Write-Host "   1. Start Docker Desktop if not running" -ForegroundColor White
    Write-Host "   2. Run: .\start-services.ps1" -ForegroundColor White
    Write-Host "   3. Open trading session via API if needed" -ForegroundColor White
    Write-Host "   4. Kill processes using port 3000 if needed" -ForegroundColor White
}

Write-Host "`n"


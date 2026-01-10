# Script untuk start semua services yang dibutuhkan
Write-Host "🚀 Starting M-BIT Platform Services..." -ForegroundColor Green

# 1. Check dan start Docker containers
Write-Host "`n📦 Checking Docker services..." -ForegroundColor Yellow
$dockerRunning = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue

if (-not $dockerRunning) {
    Write-Host "⚠️  Docker Desktop not running. Please start Docker Desktop first!" -ForegroundColor Red
    Write-Host "   After starting Docker Desktop, run this script again." -ForegroundColor Yellow
    pause
    exit 1
}

Write-Host "✅ Docker Desktop is running" -ForegroundColor Green

# 2. Start docker-compose services
Write-Host "`n🐳 Starting Docker containers..." -ForegroundColor Yellow
docker-compose up -d

Start-Sleep -Seconds 3

# 3. Check PostgreSQL
Write-Host "`n🗄️  Checking PostgreSQL..." -ForegroundColor Yellow
$pgResult = docker-compose ps db_mbit
if ($pgResult -match "Up") {
    Write-Host "✅ PostgreSQL is running on port 5433" -ForegroundColor Green
} else {
    Write-Host "❌ PostgreSQL failed to start" -ForegroundColor Red
}

# 4. Check Redis
Write-Host "`n💾 Checking Redis..." -ForegroundColor Yellow
$redisResult = docker-compose ps redis_mbit
if ($redisResult -match "Up") {
    Write-Host "✅ Redis is running on port 6379" -ForegroundColor Green

    # Test Redis connection
    $redisPing = redis-cli ping
    if ($redisPing -eq "PONG") {
        Write-Host "✅ Redis connection successful" -ForegroundColor Green
    }
} else {
    Write-Host "❌ Redis failed to start" -ForegroundColor Red
}

# 5. Check if port 3000 is free
Write-Host "`n🔌 Checking port 3000..." -ForegroundColor Yellow
$port3000 = netstat -ano | findstr ":3000.*LISTENING"
if ($port3000) {
    Write-Host "⚠️  Port 3000 is in use!" -ForegroundColor Red
    Write-Host "   Processes using port 3000:" -ForegroundColor Yellow
    Write-Host $port3000

    $killProcess = Read-Host "`nDo you want to kill these processes? (y/n)"
    if ($killProcess -eq 'y') {
        $port3000 -split "`n" | ForEach-Object {
            if ($_ -match '\s+(\d+)\s*$') {
                $pid = $matches[1]
                Write-Host "Killing process $pid..." -ForegroundColor Yellow
                taskkill /F /PID $pid 2>$null
            }
        }
        Write-Host "✅ Port 3000 is now free" -ForegroundColor Green
    }
} else {
    Write-Host "✅ Port 3000 is available" -ForegroundColor Green
}

# 6. Summary
Write-Host "`n📊 Service Status Summary:" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
docker-compose ps

Write-Host "`n✨ All services are ready!" -ForegroundColor Green
Write-Host "`nYou can now run:" -ForegroundColor Yellow
Write-Host "  npm run dev" -ForegroundColor White
Write-Host "`nOr use the quick start script:" -ForegroundColor Yellow
Write-Host "  .\quick-start.ps1" -ForegroundColor White


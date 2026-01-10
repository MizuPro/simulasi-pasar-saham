# Quick Start - Start services and run dev server
Write-Host "🚀 M-BIT Platform Quick Start" -ForegroundColor Green
Write-Host "================================`n" -ForegroundColor Green

# Run start-services script
.\start-services.ps1

if ($LASTEXITCODE -eq 1) {
    exit 1
}

# Start dev server
Write-Host "`n🔥 Starting development server..." -ForegroundColor Green
npm run dev


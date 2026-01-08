@echo off
echo ========================================
echo M-bit Platform - Database Setup
echo ========================================
echo.

echo Starting PostgreSQL and Redis containers...
docker-compose up -d

echo.
echo Waiting for PostgreSQL to be ready...
timeout /t 5 /nobreak > nul

echo.
echo Initializing database schema...
docker exec -i db_mbit psql -U michael -d mbit_db < schema.sql

echo.
echo ========================================
echo Database setup completed!
echo ========================================
echo.
echo You can now start the backend with: npm run dev
echo.
pause


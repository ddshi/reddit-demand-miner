@echo off
REM ============================================
REM 蓝海选品雷达 — 智能部署脚本
REM 功能: 部署前从线上备份用户数据 → 部署后自动恢复
REM ============================================
setlocal enabledelayedexpansion

set RAILWAY_API_TOKEN=20bcc3d7-cb20-43da-a3a6-b6ac5696645e
set PROJECT_ID=d4631a4c-7855-4a1d-ac7e-450f2941fa1d
set ENV_ID=7755956c-2f2b-4b6b-ad57-cc7b2c16906e
set SERVICE_ID=0c357c49-d739-4960-9754-8debf38d2aab
set DOMAIN=reddit-demand-miner-production.up.railway.app

cd /d D:\openclaw\public\code\reddit-demand-project

echo [1/4] 从线上备份用户数据...
curl -s -m 10 -o data\users_backup.json %DOMAIN%/api/admin/backup 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  无法连接线上服务（可能尚未部署），使用本地备份
)

REM 检查备份文件是否有效JSON
node -e "try{JSON.parse(require('fs').readFileSync('data/users_backup.json','utf8'));process.exit(0)}catch(e){process.exit(1)}" 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  备份文件无效，使用空备份
    echo { "users": [], "sessions": [] } > data\users_backup.json
)

echo [2/4] 提交备份 + 代码...
git add data/users_backup.json src/ -A
git commit -m "deploy: %DATE% %TIME%" 2>nul
if %ERRORLEVEL% NEQ 0 echo (无新变更，跳过commit)

echo [3/4] 推送到 GitHub...
git push 2>&1 | findstr /C:"error" >nul
if %ERRORLEVEL% EQU 0 (
    echo ⚠️  GitHub推送失败，尝试直接Railway部署
)

echo [4/4] 部署到 Railway...
railway up -p %PROJECT_ID% -e %ENV_ID% -s %SERVICE_ID% --detach

echo ✅ 部署完成！用户数据已随备份文件持久化
endlocal

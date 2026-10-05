@echo off
chcp 65001 >nul
setlocal

rem ===========================================================================
rem  知音漫卷 —— 一键启动（Windows）
rem  双击本文件即可：自动检查环境、装依赖、建库、起服务端与前端。
rem ===========================================================================

cd /d "%~dp0"

echo.
echo   ============================================
echo    知音漫卷  ——  正在启动
echo   ============================================
echo.

rem ---------- 1. 检查 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没找到 Node.js。
  echo          请先安装 Node.js 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo   [1/5] Node.js 版本：%NODEVER%

rem ---------- 2. 装依赖 ----------
if not exist "server\node_modules" (
  echo   [2/5] 首次运行，正在安装服务端依赖（要联网，约 1 分钟）...
  pushd server
  call npm install --no-audit --no-fund
  popd
) else (
  echo   [2/5] 服务端依赖已就绪
)

if not exist "client\node_modules" (
  echo         正在安装前端依赖...
  pushd client
  call npm install --no-audit --no-fund
  popd
) else (
  echo         前端依赖已就绪
)

rem ---------- 3. 建库与种子数据 ----------
if not exist "server\data\zhiyin.db" (
  echo   [3/5] 首次运行，正在建库并写入演示数据...
  pushd server
  call npm run seed
  popd
) else (
  echo   [3/5] 数据库已存在（要重来请先删掉 server\data 目录）
)

rem ---------- 4. 起服务端 ----------
echo   [4/5] 启动服务端（端口 3000）...
start "知音漫卷-服务端" cmd /k "cd /d %~dp0server && npm run server"

rem 等服务端起来
timeout /t 6 /nobreak >nul

rem ---------- 5. 起前端 ----------
echo   [5/5] 启动前端（端口 5173）...
start "知音漫卷-前端" cmd /k "cd /d %~dp0client && npm run dev"

timeout /t 4 /nobreak >nul

echo.
echo   ============================================
echo    启动完成
echo   ============================================
echo.
echo    浏览器打开：  http://localhost:5173
echo    演示账号：    demo@example.com
echo    演示密码：    demo12345
echo.
echo    注意：会弹出两个命令行窗口，分别是服务端与前端。
echo          关掉它们就是停止服务。本窗口可以关掉。
echo.
echo    语音合成的本地引擎（Kokoro）没装也没关系 ——
echo    会自动降级成浏览器发声，跟读照样能用。
echo.

start "" http://localhost:5173

echo   按任意键关闭本窗口（不影响已经启动的服务）...
pause >nul
endlocal

@echo off
title 启动竞彩研习室

cd /d "C:\Users\Zoe Zhang\Documents\ChatGPT\New project\football-focus"

if errorlevel 1 (
    echo 无法进入网站项目目录
    pause
    exit /b 1
)

start "竞彩研习室服务" cmd.exe /k "call npm.cmd run dev"

echo 正在等待网站启动...
timeout /t 10 /nobreak >nul

start "" "http://localhost:3000/"

echo 网站启动命令已经执行。
pause
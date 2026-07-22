@echo off
rem ------------------------------------------------------------------
rem  双六クイズゲーム ワンクリック起動（Windows）
rem    このファイルをダブルクリックするとサーバーが起動し、
rem    自動的にホスト画面がブラウザで開きます。
rem    ※ 初回のみ Node.js のインストールが必要です（https://nodejs.org）。
rem ------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js が見つかりません。
  echo     https://nodejs.org から LTS版 をインストールしてから、もう一度ダブルクリックしてください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo [*] 初回セットアップ中です（1〜2分ほどかかります）...
  call npm install
  if errorlevel 1 (
    echo セットアップに失敗しました。
    pause
    exit /b 1
  )
)

rem AUTO_OPEN=1 でサーバー起動時にホスト画面を自動で開く
set AUTO_OPEN=1
node server.js
pause

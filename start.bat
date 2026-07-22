@echo off
setlocal
chcp 65001 >nul 2>nul
rem ------------------------------------------------------------------
rem  双六クイズゲーム ワンクリック起動（Windows）
rem    このファイルをダブルクリックするとサーバーが起動し、
rem    自動的にホスト画面がブラウザで開きます。
rem    ※ 初回のみ Node.js のインストールが必要です（https://nodejs.org）。
rem ------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

if not exist "node_modules\" goto INSTALL
goto RUN

:INSTALL
echo [*] 初回セットアップ中です（1〜2分ほどかかります）...
call npm install
if errorlevel 1 goto INSTALL_FAIL
goto RUN

:RUN
set "AUTO_OPEN=1"
node server.js
goto END

:NO_NODE
echo [X] Node.js が見つかりません。
echo     https://nodejs.org から LTS版 をインストールしてから、もう一度ダブルクリックしてください。
pause
goto END

:INSTALL_FAIL
echo [X] セットアップ（npm install）に失敗しました。
echo     インターネット接続をご確認のうえ、もう一度お試しください。
pause
goto END

:END
echo.
echo サーバーを終了しました。このウィンドウは閉じて構いません。
pause
endlocal

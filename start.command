#!/bin/bash
# ------------------------------------------------------------------
# 双六クイズゲーム ワンクリック起動（macOS / Linux）
#   このファイルをダブルクリックするとサーバーが起動し、
#   自動的にホスト画面がブラウザで開きます。
#   ※ 初回のみ Node.js のインストールが必要です（https://nodejs.org）。
# ------------------------------------------------------------------
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js が見つかりません。"
  echo "   https://nodejs.org から LTS版 をインストールしてから、もう一度ダブルクリックしてください。"
  read -r -p "Enterキーで閉じます..." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 初回セットアップ中です（1〜2分ほどかかります）…"
  npm install || { echo "セットアップに失敗しました。"; read -r -p "Enterで閉じます..." _; exit 1; }
fi

# AUTO_OPEN=1 でサーバー起動時にホスト画面を自動で開く
AUTO_OPEN=1 node server.js

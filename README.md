# 双六クイズゲーム

授業の振り返り・復習を目的とした、双六形式のリアルタイムクイズゲームです。
教員PCをサーバー兼モニター表示（ホスト画面）とし、各班はタブレットのブラウザから参加します。

- 技術: Node.js + Express + Socket.io（フロントは素の HTML/CSS/JS）
- 要件定義書: `sugoroku-quiz-game.md` に準拠

## セットアップ

```bash
npm install
npm start        # http://localhost:3000
```

- ホスト画面（プロジェクター投影用）: `http://localhost:3000/host`
- プレイヤー画面（タブレット）: `http://<教員PCのIP>:3000/player`

`PORT` 環境変数でポート変更可能（例: `PORT=8080 npm start`）。

## 遊び方

1. 各タブレットで `/player` を開き、班（1〜6班）を選択 → キャラクターを選択。
2. ホスト画面の「ゲーム開始」を押す。
3. 手番の班がタブレットの「サイコロを振る」を押す → コマが進む。
4. マスに止まるとクイズが出題され、参加中の全班が解答。正解で +1 ポイント。
5. いずれかの班がゴールに到達したら終了。最高ポイントの班が勝ち（同点は両者勝利）。

## クイズの登録

- 事前登録: `data/quiz_default.json` を編集。
- 当日追加: ホスト画面右上の「クイズ管理」から問題・選択肢・正解・制限時間を入力して追加登録。
  （追加分はサーバーのメモリ上に保持され、永続化はされません）

## キャラクター画像

`public/assets/characters/` に置いた画像ファイル（`.png` / `.jpg` / `.svg` など）が
自動的にプレイヤーのキャラクター選択に表示されます。
初期状態では確認用の SVG プレースホルダーを同梱しています。Gemini 等で生成した PNG に
差し替える場合は、このフォルダにファイルを追加するだけで反映されます（再起動不要）。

## ファイル構成

```
sugoroku/
├── server.js                 # Express + Socket.io サーバー（状態管理・進行）
├── game/
│   └── rules.js              # 第9章の未確定項目＝「仮ルール」を集約（差し替え容易）
├── data/
│   └── quiz_default.json     # 事前登録クイズ
├── public/
│   ├── host/                 # ホスト画面（盤面・ランキング・クイズ管理）
│   ├── player/               # プレイヤー画面（班選択・サイコロ・解答）
│   └── assets/characters/    # キャラクター画像
└── README.md
```

## 仮ルール（第9章の未確定項目）

`game/rules.js` に以下の仮ルールを集約しています。後で差し替えやすい構造です。

| 項目 | 仮ルール |
|---|---|
| 不正解時の処理 | 何もしない（その場に留まる・減点なし） |
| マスの種類 | 全てクイズマス（スタート/ゴールを除く） |
| 同点時の勝敗 | 同点は両者（全員）勝利 |
| ゴール到達後 | いずれかの班がゴールに到達した時点で終了 |
| クイズ回答者 | 参加中の全班が回答可能 |

例えば「不正解で1マス戻る」に変えるには `onWrongAnswer()` を、
「止まった班だけ回答」に変えるには `answeringTeamIds()` を編集するだけで済みます。

## Socket.io イベント（第6章）

| イベント | 方向 | 内容 |
|---|---|---|
| `join_team` | client→server | 班として参加登録 |
| `select_character` | client→server | キャラクター選択 |
| `roll_dice` | client→server | 手番の班がサイコロを振る |
| `dice_result` | server→all | 出目とコマ移動結果を配信 |
| `quiz_start` | server→all | 問題・選択肢・制限時間を配信 |
| `submit_answer` | client→server | 選択肢を解答 |
| `quiz_result` | server→all | 正誤とポイント更新を配信 |
| `turn_change` | server→all | 次の班へ手番交代 |
| `add_quiz` | host→server | 当日のクイズ追加登録 |
| `game_state_update` | server→all | 盤面・ポイント状況の全体同期 |

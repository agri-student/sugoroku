/**
 * game/rules.js
 * ------------------------------------------------------------------
 * 要件定義書 第9章「未確定（後日決定）項目」に対する【仮ルール】実装。
 *
 * 後で本ルールへ差し替えやすいよう、章9に関わる判断はすべて
 * このファイル1つに集約している。ゲーム本体（server.js）は
 * ここで公開する関数だけを呼び出し、ルールの中身には依存しない。
 *
 * 現在の仮ルール:
 *   - 不正解時の処理      : 何もしない（その場に留まる／減点なし）
 *   - マスの種類          : 全てクイズマス（スタート/ゴールを除く）
 *   - 同点時の勝敗判定    : 同点は両者（全員）勝利扱い
 *   - ゴール到達後の扱い  : いずれかの班がゴールに到達した時点で終了
 *   - クイズの回答者      : 全ての参加班が回答できる
 * ------------------------------------------------------------------
 */

// 盤面のマス数。0がスタート、BOARD_SIZE がゴール。
const BOARD_SIZE = 30;

/**
 * マスの種類を返す。
 * 仮ルール: スタート/ゴール以外は全てクイズマス。
 * 将来「お楽しみマス」等を追加する場合はここを変更する。
 */
function boardCellType(index) {
  if (index <= 0) return 'start';
  if (index >= BOARD_SIZE) return 'goal';
  return 'quiz';
}

/**
 * 盤面データを生成する。data モデル 4章の board に相当。
 */
function buildBoard() {
  const board = [];
  for (let i = 0; i <= BOARD_SIZE; i++) {
    board.push({ index: i, type: boardCellType(i) });
  }
  return board;
}

/**
 * サイコロを振った後の到達位置を計算する。
 * 仮ルール: ゴールを超えないようクランプ（ぴったりでなくてもゴール扱い）。
 */
function applyDiceMove(position, dice) {
  return Math.min(position + dice, BOARD_SIZE);
}

/**
 * そのマスに止まったときクイズを出題するか。
 * 仮ルール: 全てクイズマスなので常に true（スタートは除く）。
 */
function shouldTriggerQuiz(cellType) {
  return cellType === 'quiz' || cellType === 'goal';
}

/**
 * 正解時に加算するポイント。
 * 仮ルール: 一律 +1。
 */
function pointsForCorrect(team, quiz) {
  return 1;
}

/**
 * 不正解時の処理。
 * 仮ルール: 何もしない（no-op）。
 * 将来「1マス戻る」等にする場合はここで team.position を操作する。
 */
function onWrongAnswer(team, quiz) {
  // no-op
}

/**
 * そのクイズラウンドで回答できる班のIDリストを返す。
 * 仮ルール: 参加している全班が回答可能。
 * 「止まった班だけが回答」に変えたい場合は、
 * currentTeamId のみを返すよう変更する。
 */
function answeringTeamIds(teams, currentTeamId) {
  return teams.filter((t) => t.joined).map((t) => t.id);
}

/**
 * ゲーム終了判定。
 * 仮ルール: いずれかの班がゴールに到達したら終了。
 */
function isGameFinished(teams) {
  return teams.some((t) => t.joined && t.position >= BOARD_SIZE);
}

/**
 * 勝者判定。
 * 仮ルール: 最高ポイントの班（同点なら全員）を勝者とする。
 */
function decideWinners(teams) {
  const active = teams.filter((t) => t.joined);
  if (active.length === 0) return [];
  const maxPoints = Math.max(...active.map((t) => t.points));
  return active.filter((t) => t.points === maxPoints).map((t) => t.id);
}

module.exports = {
  BOARD_SIZE,
  boardCellType,
  buildBoard,
  applyDiceMove,
  shouldTriggerQuiz,
  pointsForCorrect,
  onWrongAnswer,
  answeringTeamIds,
  isGameFinished,
  decideWinners,
};

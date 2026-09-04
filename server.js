/**
 * server.js
 * ------------------------------------------------------------------
 * 農業すごろくクイズ サーバー（Express + Socket.io）
 *
 * - 静的配信: /host（ホスト画面）, /player（プレイヤー画面）
 * - REST:     GET /api/characters（キャラ画像一覧）, GET /api/lessons（授業ファイル一覧）
 * - リアルタイム通信: 要件定義 第6章のイベント設計に準拠
 * - 状態管理: 第4章のデータモデルをメモリ上で保持
 * - クイズ: data/quiz_教科名_単元名.json を授業ごとに切り替え。
 *           教員追加分・承認済みの生徒登録分はファイルへ反映（永続化）
 * - 章9の未確定項目は game/rules.js の仮ルールに委譲（差し替え容易）
 * ------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const rules = require('./game/rules');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHARACTERS_DIR = path.join(PUBLIC_DIR, 'assets', 'characters');
const DATA_DIR = path.join(__dirname, 'data');

// ------------------------------------------------------------------
// Express セットアップ
// ------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ルート: ホスト / プレイヤー画面
app.get('/', (_req, res) => res.redirect('/host'));
app.get('/host', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host', 'index.html')));
app.get('/player', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player', 'index.html')));

// キャラクター画像一覧（assets/characters 配下の画像ファイル名を返す）
app.get('/api/characters', (_req, res) => {
  res.json({ characters: listCharacterFiles() });
});

// 授業ファイル一覧（data/quiz_*.json）
app.get('/api/lessons', (_req, res) => {
  res.json({ lessons: listLessonFiles() });
});

function listCharacterFiles() {
  try {
    const allow = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    return fs
      .readdirSync(CHARACTERS_DIR)
      .filter((f) => allow.includes(path.extname(f).toLowerCase()))
      .sort();
  } catch (e) {
    console.warn('[characters] ディレクトリを読めませんでした:', e.message);
    return [];
  }
}

// ------------------------------------------------------------------
// 授業（教科・単元）別クイズファイル
//   命名規則: quiz_教科名.json または quiz_教科名_単元名.json
// ------------------------------------------------------------------

// ファイル名から画面表示用のラベルを作る
//   quiz_情報技術.json            → { subject: '情報技術', unit: '',       label: '情報技術' }
//   quiz_農業と環境_土と肥料.json → { subject: '農業と環境', unit: '土と肥料', label: '農業と環境 / 土と肥料' }
function describeLessonFile(fileName) {
  const base = fileName.replace(/^quiz_/, '').replace(/\.json$/i, '');
  const parts = base.split('_');
  const subject = parts[0] || base;
  const unit = parts.slice(1).join('_');
  return {
    file: fileName,
    subject,
    unit,
    label: unit ? `${subject} / ${unit}` : subject,
  };
}

function listLessonFiles() {
  try {
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^quiz_.+\.json$/i.test(f))
      .sort()
      .map((f) => {
        const info = describeLessonFile(f);
        info.count = readLessonFile(f).length;
        return info;
      });
  } catch (e) {
    console.warn('[lesson] data ディレクトリを読めませんでした:', e.message);
    return [];
  }
}

// 与えられたファイル名が data/ 直下の正規の授業ファイルか検証する（パス横断の防止）
function resolveLessonPath(fileName) {
  if (typeof fileName !== 'string') return null;
  const base = path.basename(fileName); // ディレクトリ部分を除去
  if (base !== fileName) return null;
  if (!/^quiz_.+\.json$/i.test(base)) return null;
  const full = path.join(DATA_DIR, base);
  if (!full.startsWith(DATA_DIR + path.sep)) return null;
  return full;
}

function readLessonFile(fileName) {
  const full = resolveLessonPath(fileName);
  if (!full) return [];
  try {
    const raw = fs.readFileSync(full, 'utf-8');
    const parsed = JSON.parse(raw);
    // 配列形式（標準）と { quizzes: [...] } 形式の両方を受け付ける
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.quizzes) ? parsed.quizzes : [];
    return arr.filter(isValidQuizObject).map(normalizeQuiz);
  } catch (e) {
    console.warn(`[lesson] ${fileName} を読めませんでした:`, e.message);
    return [];
  }
}

// 現在の授業ファイルへ quizPool を書き戻す（教員追加分・承認済み生徒分の永続化）
function saveCurrentLessonFile() {
  const fileName = gameState.currentLessonFile;
  const full = resolveLessonPath(fileName);
  if (!full) return { ok: false, error: '保存先の授業ファイルが選択されていません。' };
  try {
    fs.writeFileSync(full, JSON.stringify(gameState.quizPool, null, 2) + '\n', 'utf-8');
    return { ok: true };
  } catch (e) {
    console.error(`[lesson] ${fileName} への保存に失敗:`, e.message);
    return { ok: false, error: `ファイル保存に失敗しました: ${e.message}` };
  }
}

function isValidQuizObject(q) {
  return q && typeof q.question === 'string' && Array.isArray(q.choices) && q.choices.length >= 2;
}

let quizSeq = 0;
function newQuizId() {
  quizSeq += 1;
  return `q_${Date.now()}_${quizSeq}`;
}

function normalizeQuiz(q) {
  const limit = Number(q.timeLimitSec);
  return {
    id: q.id || newQuizId(),
    question: String(q.question).trim(),
    choices: q.choices.map((c) => String(c).trim()),
    answerIndex: Number.isInteger(q.answerIndex) ? q.answerIndex : 0,
    timeLimitSec: Number.isFinite(limit) && limit >= 5 && limit <= 60 ? limit : 20,
    source: q.source === 'student' ? 'student' : 'teacher',
    registeredBy: q.registeredBy || undefined,
  };
}

// ------------------------------------------------------------------
// ゲーム状態（第4章データモデル）— メモリ上で管理
// ------------------------------------------------------------------
const TEAM_COUNT = 6;

function createInitialTeams() {
  const teams = [];
  for (let i = 1; i <= TEAM_COUNT; i++) {
    teams.push({
      id: `team${i}`,
      name: `${i}班`,
      character: null, // 選択後にファイル名が入る
      position: 0,
      points: 0,
      isCurrentTurn: false, // キャラクター表示サイズの切り替えにも使用
      joined: false, // タブレットが参加登録したか
      connected: false, // ソケット接続中か
    });
  }
  return teams;
}

let gameState = null;
// 進行中のクイズラウンド（一時的な作業領域。gameStateとは分離）
let round = null; // { quiz, answers: {teamId: choiceIndex}, eligible, endsAt }
let roundTimer = null;

// 初期選択する授業ファイル（data/ 内の最初の quiz_*.json）
function defaultLessonFile() {
  const lessons = listLessonFiles();
  return lessons.length > 0 ? lessons[0].file : null;
}

// ゲームをリセットする。
// 授業ファイルの選択と承認モードは教員の設定なので引き継ぐ。
function resetGame(keepSettings = true) {
  const prevLesson = keepSettings && gameState ? gameState.currentLessonFile : null;
  const prevApproval = keepSettings && gameState ? gameState.approvalRequired : true;

  const lessonFile = prevLesson || defaultLessonFile();

  gameState = {
    teams: createInitialTeams(),
    currentTurnIndex: 0,
    board: rules.buildBoard(),
    currentLessonFile: lessonFile,
    approvalRequired: prevApproval,
    quizPool: lessonFile ? readLessonFile(lessonFile) : [],
    pendingQuizzes: [],
    status: 'waiting', // waiting | rolling | quiz | result | finished
  };

  round = null;
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }
}

resetGame(false);

// ------------------------------------------------------------------
// 状態のサニタイズ（クライアントへ送る用）
//   - 進行中クイズの正解（answerIndex）は漏らさない
//   - quizPool の中身は送らず件数のみ（正解漏洩防止）
// ------------------------------------------------------------------
function publicGameState() {
  return {
    teams: gameState.teams.map(publicTeam),
    currentTurnIndex: gameState.currentTurnIndex,
    currentTeamId: currentTeam() ? currentTeam().id : null,
    board: gameState.board,
    boardSize: rules.BOARD_SIZE,
    currentLessonFile: gameState.currentLessonFile,
    currentLessonLabel: gameState.currentLessonFile
      ? describeLessonFile(gameState.currentLessonFile).label
      : null,
    approvalRequired: gameState.approvalRequired,
    quizCount: gameState.quizPool.length,
    pendingCount: gameState.pendingQuizzes.length,
    status: gameState.status,
    // クイズ中は「誰が回答済みか」だけ配信（何を選んだかは伏せる）
    answered: round ? Object.keys(round.answers) : [],
  };
}

function broadcastState() {
  io.emit('game_state_update', publicGameState());
}

function publicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    character: team.character,
    position: team.position,
    points: team.points,
    isCurrentTurn: team.isCurrentTurn,
    joined: team.joined,
    connected: team.connected,
  };
}

function currentTeam() {
  return gameState.teams[gameState.currentTurnIndex] || null;
}

function joinedTeams() {
  return gameState.teams.filter((t) => t.joined);
}

function syncTurnFlags() {
  gameState.teams.forEach((t, i) => {
    t.isCurrentTurn = i === gameState.currentTurnIndex && t.joined;
  });
}

// 次の「参加済み」の班へ手番を移す
function advanceTurn() {
  const total = gameState.teams.length;
  for (let step = 1; step <= total; step++) {
    const idx = (gameState.currentTurnIndex + step) % total;
    if (gameState.teams[idx].joined) {
      gameState.currentTurnIndex = idx;
      syncTurnFlags();
      return;
    }
  }
  syncTurnFlags(); // 参加班が無い場合はそのまま
}

// 最初の手番を参加済みの班に合わせる
function ensureCurrentTeamJoined() {
  if (!currentTeam() || !currentTeam().joined) {
    const firstJoined = gameState.teams.findIndex((t) => t.joined);
    if (firstJoined >= 0) {
      gameState.currentTurnIndex = firstJoined;
    }
  }
  // 参加済みかどうかに関わらず、手番フラグを必ず同期する
  syncTurnFlags();
}

// ホスト画面向けの配信ヘルパー
function sendQuizListToHosts() {
  io.to('hosts').emit('quiz_list', { quizzes: gameState.quizPool });
}
function sendPendingListToHosts() {
  io.to('hosts').emit('quiz_pending_list', { pending: gameState.pendingQuizzes });
}
function sendLessonListToAll() {
  io.emit('lesson_list', { lessons: listLessonFiles(), current: gameState.currentLessonFile });
}

// ------------------------------------------------------------------
// Socket.io イベント（第6章の設計）
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.teamId = null;
  socket.data.isHost = false;

  // 接続直後に現在状態を送る
  socket.emit('game_state_update', publicGameState());
  socket.emit('characters', { characters: listCharacterFiles() });
  socket.emit('lesson_list', { lessons: listLessonFiles(), current: gameState.currentLessonFile });

  // ---- ホスト参加 ----
  socket.on('join_host', () => {
    socket.data.isHost = true;
    socket.join('hosts');
    socket.emit('game_state_update', publicGameState());
    socket.emit('quiz_list', { quizzes: gameState.quizPool });
    socket.emit('quiz_pending_list', { pending: gameState.pendingQuizzes });
    socket.emit('lesson_list', { lessons: listLessonFiles(), current: gameState.currentLessonFile });
  });

  // ---- 班として参加登録（join_team） ----
  socket.on('join_team', ({ teamId } = {}) => {
    const team = gameState.teams.find((t) => t.id === teamId);
    if (!team) return socket.emit('error_msg', { message: '存在しない班です。' });
    if (team.joined && team.connected && socket.data.teamId !== teamId) {
      return socket.emit('error_msg', { message: 'その班は既に使用中です。' });
    }
    socket.data.teamId = teamId;
    team.joined = true;
    team.connected = true;
    socket.join(teamId);

    ensureCurrentTeamJoined();
    socket.emit('joined', { teamId, team: publicTeam(team) });
    broadcastState();
  });

  // ---- キャラクター選択（select_character） ----
  socket.on('select_character', ({ teamId, character } = {}) => {
    const team = gameState.teams.find((t) => t.id === (teamId || socket.data.teamId));
    if (!team) return;
    const available = listCharacterFiles();
    if (character && !available.includes(character)) {
      return socket.emit('error_msg', { message: 'そのキャラクターは選べません。' });
    }
    team.character = character;
    broadcastState();
  });

  // ---- 授業ファイル選択（select_lesson_file / host→server） ----
  socket.on('select_lesson_file', ({ file } = {}) => handleSelectLesson(socket, file));
  socket.on('host:select_lesson_file', ({ file } = {}) => handleSelectLesson(socket, file));

  // ---- 承認モード切替（set_approval_mode / host→server） ----
  socket.on('set_approval_mode', ({ required } = {}) => handleSetApprovalMode(socket, required));
  socket.on('host:set_approval_mode', ({ required } = {}) => handleSetApprovalMode(socket, required));

  // ---- 生徒によるクイズ登録（submit_quiz_by_student） ----
  socket.on('submit_quiz_by_student', (payload = {}) => {
    handleStudentQuiz(socket, payload);
  });

  // ---- 承認待ちクイズの承認（approve_quiz / host→server） ----
  socket.on('approve_quiz', ({ quizId } = {}) => handleApproveQuiz(socket, quizId));
  socket.on('host:approve_quiz', ({ quizId } = {}) => handleApproveQuiz(socket, quizId));

  // ---- 承認待ちクイズの却下（承認運用の補助） ----
  socket.on('reject_quiz', ({ quizId } = {}) => handleRejectQuiz(socket, quizId));
  socket.on('host:reject_quiz', ({ quizId } = {}) => handleRejectQuiz(socket, quizId));

  // ---- サイコロを振る（roll_dice） ----
  socket.on('roll_dice', ({ teamId } = {}) => {
    const id = teamId || socket.data.teamId;
    const team = gameState.teams.find((t) => t.id === id);
    if (!team) return;
    if (gameState.status !== 'waiting' && gameState.status !== 'rolling') {
      return socket.emit('error_msg', { message: '今はサイコロを振れません。' });
    }
    if (!team.isCurrentTurn) {
      return socket.emit('error_msg', { message: 'あなたの班の手番ではありません。' });
    }

    gameState.status = 'rolling';
    const dice = 1 + Math.floor(Math.random() * 6);
    const from = team.position;
    const to = rules.applyDiceMove(from, dice);
    team.position = to;

    io.emit('dice_result', { teamId: team.id, teamName: team.name, dice, from, to });
    broadcastState();

    const cellType = rules.boardCellType(to);
    if (rules.shouldTriggerQuiz(cellType)) {
      // 少し間を置いてクイズ開始（コマ移動アニメの猶予）
      setTimeout(() => startQuizRound(team.id), 900);
    } else {
      // クイズ以外のマス（仮ルールでは発生しない）→ 手番交代
      setTimeout(() => finishRoundAndAdvance(), 900);
    }
  });

  // ---- 解答（submit_answer） ----
  socket.on('submit_answer', ({ teamId, choiceIndex } = {}) => {
    const id = teamId || socket.data.teamId;
    if (gameState.status !== 'quiz' || !round) return;
    const team = gameState.teams.find((t) => t.id === id);
    if (!team || !team.joined) return;
    if (!round.eligible.includes(team.id)) return; // 回答権のある班か
    if (Object.prototype.hasOwnProperty.call(round.answers, team.id)) return; // 二重回答は無視

    round.answers[team.id] = choiceIndex;
    io.emit('answer_progress', { answered: Object.keys(round.answers) });
    broadcastState();

    if (round.eligible.every((tid) => tid in round.answers)) {
      concludeQuizRound(); // 全員回答したら締め切り
    }
  });

  // ---- 教員によるクイズ追加登録（add_quiz / host→server） ----
  socket.on('add_quiz', (payload = {}) => handleAddQuiz(socket, payload));
  socket.on('host:add_quiz', (payload = {}) => handleAddQuiz(socket, payload));

  // ---- ホスト操作: ゲーム開始 ----
  socket.on('host:start_game', () => {
    if (joinedTeams().length === 0) {
      return socket.emit('error_msg', { message: '参加している班がありません。' });
    }
    gameState.teams.forEach((t) => {
      t.position = 0;
      t.points = 0;
    });
    ensureCurrentTeamJoined();
    gameState.status = 'waiting';
    round = null;
    io.emit('turn_change', { currentTeamId: currentTeam().id });
    broadcastState();
  });

  // ---- ホスト操作: ゲームリセット ----
  socket.on('host:reset_game', () => {
    resetGame(true); // 授業ファイル・承認モードは維持
    sendQuizListToHosts();
    sendPendingListToHosts();
    broadcastState();
  });

  // ---- ホスト操作: 手番を強制的に次へ ----
  socket.on('host:next_turn', () => {
    if (gameState.status === 'quiz') return; // クイズ中は不可
    finishRoundAndAdvance();
  });

  // ---- ホスト操作: クイズ一覧要求 ----
  socket.on('host:get_quizzes', () => {
    socket.emit('quiz_list', { quizzes: gameState.quizPool });
    socket.emit('quiz_pending_list', { pending: gameState.pendingQuizzes });
  });

  // ---- 切断 ----
  socket.on('disconnect', () => {
    if (socket.data.teamId) {
      const team = gameState.teams.find((t) => t.id === socket.data.teamId);
      if (team) {
        team.connected = false;
        // joined は維持（再接続で復帰できるように）
        broadcastState();
      }
    }
  });
});

// ------------------------------------------------------------------
// 授業ファイル / 承認モード
// ------------------------------------------------------------------
function handleSelectLesson(socket, file) {
  if (gameState.status === 'quiz') {
    return socket.emit('error_msg', { message: 'クイズ出題中は授業ファイルを変更できません。' });
  }
  const full = resolveLessonPath(file);
  if (!full || !fs.existsSync(full)) {
    return socket.emit('error_msg', { message: '指定された授業ファイルが見つかりません。' });
  }
  gameState.currentLessonFile = path.basename(file);
  gameState.quizPool = readLessonFile(gameState.currentLessonFile);
  // 承認待ちは元の授業ファイル向けの登録なので、切り替え時にクリアする
  gameState.pendingQuizzes = [];

  sendQuizListToHosts();
  sendPendingListToHosts();
  sendLessonListToAll();
  broadcastState();
}

function handleSetApprovalMode(socket, required) {
  gameState.approvalRequired = !!required;
  // 承認不要へ切り替えたら、承認待ちを一括で出題プールへ反映する
  if (!gameState.approvalRequired && gameState.pendingQuizzes.length > 0) {
    gameState.pendingQuizzes.forEach((q) => {
      gameState.quizPool.push(stripInternal(q)); // 内部用フィールドはファイルに残さない
      if (q.registeredByTeamId) {
        io.to(q.registeredByTeamId).emit('quiz_approved', { quiz: publicQuizSummary(q) });
      }
    });
    gameState.pendingQuizzes = [];
    saveCurrentLessonFile();
  }
  sendQuizListToHosts();
  sendPendingListToHosts();
  broadcastState();
}

// ------------------------------------------------------------------
// クイズラウンド進行
// ------------------------------------------------------------------
function pickQuiz() {
  const pool = gameState.quizPool;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function startQuizRound(currentTeamId) {
  const quiz = pickQuiz();
  if (!quiz) {
    io.emit('error_msg', { message: 'クイズが登録されていません。' });
    finishRoundAndAdvance();
    return;
  }

  const eligible = rules.answeringTeamIds(gameState.teams, currentTeamId);
  const timeLimitSec = Number(quiz.timeLimitSec) > 0 ? Number(quiz.timeLimitSec) : 20;
  const endsAt = Date.now() + timeLimitSec * 1000;

  round = { quiz, answers: {}, eligible, endsAt };
  gameState.status = 'quiz';

  // 正解（answerIndex）は伏せて配信
  io.emit('quiz_start', {
    quiz: {
      id: quiz.id,
      question: quiz.question,
      choices: quiz.choices,
      timeLimitSec,
      source: quiz.source,
      registeredBy: quiz.registeredBy,
    },
    eligible,
    currentTeamId,
    endsAt,
  });
  broadcastState();

  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(concludeQuizRound, timeLimitSec * 1000 + 200);
}

function concludeQuizRound() {
  if (!round || gameState.status !== 'quiz') return;
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }

  const quiz = round.quiz;
  const results = round.eligible.map((teamId) => {
    const team = gameState.teams.find((t) => t.id === teamId);
    const choiceIndex = teamId in round.answers ? round.answers[teamId] : null;
    const correct = choiceIndex === quiz.answerIndex;
    let gained = 0;
    if (correct) {
      gained = rules.pointsForCorrect(team, quiz);
      team.points += gained;
    } else {
      rules.onWrongAnswer(team, quiz); // 仮ルール: 何もしない
    }
    return { teamId, teamName: team.name, choiceIndex, correct, gained, points: team.points };
  });

  gameState.status = 'result';
  io.emit('quiz_result', {
    quizId: quiz.id,
    answerIndex: quiz.answerIndex,
    results,
    teams: gameState.teams.map(publicTeam),
  });
  round = null;
  broadcastState();

  // 結果表示のあと、終了判定 → 手番交代
  setTimeout(() => {
    if (rules.isGameFinished(gameState.teams)) {
      finishGame();
    } else {
      finishRoundAndAdvance();
    }
  }, 3500);
}

function finishRoundAndAdvance() {
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }
  round = null;
  advanceTurn();
  gameState.status = 'waiting';
  const ct = currentTeam();
  io.emit('turn_change', { currentTeamId: ct ? ct.id : null });
  broadcastState();
}

function finishGame() {
  gameState.status = 'finished';
  const winnerIds = rules.decideWinners(gameState.teams);
  io.emit('game_finished', {
    winners: winnerIds,
    teams: gameState.teams.map(publicTeam),
  });
  broadcastState();
}

// ------------------------------------------------------------------
// クイズ登録（教員 / 生徒）
// ------------------------------------------------------------------

// 入力値の検証。問題なければ正規化したクイズを返す。
function validateQuizPayload(payload) {
  const { question, choices, answerIndex, timeLimitSec } = payload;
  const errors = [];
  if (!question || typeof question !== 'string' || !question.trim()) {
    errors.push('問題文を入力してください。');
  }
  const list = Array.isArray(choices) ? choices.map((c) => String(c == null ? '' : c).trim()) : [];
  const filled = list.filter((c) => c.length > 0);
  if (filled.length < 2) errors.push('選択肢は2つ以上入力してください。');
  const ansIdx = Number(answerIndex);
  if (!Number.isInteger(ansIdx) || ansIdx < 0 || ansIdx >= list.length || !list[ansIdx]) {
    errors.push('正解の選択肢を正しく選んでください。');
  }
  if (errors.length > 0) return { errors };

  // 空欄の選択肢は詰めて除去し、正解位置を追従させる
  const compact = [];
  let newAnswerIndex = 0;
  list.forEach((c, i) => {
    if (!c) return;
    if (i === ansIdx) newAnswerIndex = compact.length;
    compact.push(c);
  });

  const limit = Number(timeLimitSec);
  return {
    quiz: {
      id: newQuizId(),
      question: question.trim(),
      choices: compact,
      answerIndex: newAnswerIndex,
      timeLimitSec: Number.isFinite(limit) && limit >= 5 && limit <= 60 ? limit : 20,
    },
  };
}

function publicQuizSummary(q) {
  return {
    id: q.id,
    question: q.question,
    choices: q.choices,
    answerIndex: q.answerIndex,
    timeLimitSec: q.timeLimitSec,
    source: q.source,
    registeredBy: q.registeredBy,
  };
}

// 教員による追加登録（ホスト画面）
function handleAddQuiz(socket, payload) {
  const { errors, quiz } = validateQuizPayload(payload);
  if (errors) return socket.emit('add_quiz_result', { ok: false, errors });

  quiz.source = 'teacher';
  gameState.quizPool.push(quiz);
  const saved = saveCurrentLessonFile();

  socket.emit('add_quiz_result', {
    ok: true,
    quiz,
    saved: saved.ok,
    savedTo: gameState.currentLessonFile,
    saveError: saved.ok ? undefined : saved.error,
  });
  sendQuizListToHosts();
  sendLessonListToAll();
  broadcastState();
}

// 生徒による登録（プレイヤー画面）。承認モードに応じて振り分ける。
function handleStudentQuiz(socket, payload) {
  const teamId = payload.teamId || socket.data.teamId;
  const team = gameState.teams.find((t) => t.id === teamId);
  if (!team) {
    return socket.emit('submit_quiz_result', { ok: false, errors: ['班に参加してから登録してください。'] });
  }

  const { errors, quiz } = validateQuizPayload(payload);
  if (errors) return socket.emit('submit_quiz_result', { ok: false, errors });

  quiz.source = 'student';
  quiz.registeredBy = team.name;
  quiz.registeredByTeamId = team.id; // 承認時の通知用（ファイルには保存しない）

  if (gameState.approvalRequired) {
    // 承認モードON: 承認待ちへ。教員が承認するまで出題されない
    gameState.pendingQuizzes.push(quiz);
    socket.emit('submit_quiz_result', {
      ok: true,
      pending: true,
      quiz: publicQuizSummary(quiz),
    });
    sendPendingListToHosts();
  } else {
    // 承認モードOFF: すぐ出題プールへ反映し、ファイルにも保存
    gameState.quizPool.push(stripInternal(quiz));
    const saved = saveCurrentLessonFile();
    socket.emit('submit_quiz_result', {
      ok: true,
      pending: false,
      quiz: publicQuizSummary(quiz),
      saved: saved.ok,
    });
    sendQuizListToHosts();
    sendLessonListToAll();
  }
  broadcastState();
}

// ファイル保存用に内部フィールドを落とす
function stripInternal(quiz) {
  const { registeredByTeamId, ...rest } = quiz;
  return rest;
}

// 教員による承認 → 出題プールへ追加し、授業ファイルへ保存
function handleApproveQuiz(socket, quizId) {
  const idx = gameState.pendingQuizzes.findIndex((q) => q.id === quizId);
  if (idx < 0) return socket.emit('error_msg', { message: '対象の承認待ちクイズが見つかりません。' });

  const [quiz] = gameState.pendingQuizzes.splice(idx, 1);
  gameState.quizPool.push(stripInternal(quiz));
  const saved = saveCurrentLessonFile();

  // 登録した班へ承認を通知
  if (quiz.registeredByTeamId) {
    io.to(quiz.registeredByTeamId).emit('quiz_approved', { quiz: publicQuizSummary(quiz) });
  }
  socket.emit('approve_quiz_result', { ok: true, quizId, saved: saved.ok });

  sendQuizListToHosts();
  sendPendingListToHosts();
  sendLessonListToAll();
  broadcastState();
}

// 教員による却下（承認待ちから削除するだけ。ファイルには影響しない）
function handleRejectQuiz(socket, quizId) {
  const idx = gameState.pendingQuizzes.findIndex((q) => q.id === quizId);
  if (idx < 0) return;
  const [quiz] = gameState.pendingQuizzes.splice(idx, 1);
  if (quiz.registeredByTeamId) {
    io.to(quiz.registeredByTeamId).emit('quiz_rejected', { quiz: publicQuizSummary(quiz) });
  }
  sendPendingListToHosts();
  broadcastState();
}

// ------------------------------------------------------------------
// 起動補助: LAN内IPアドレスの取得とブラウザ自動オープン
// ------------------------------------------------------------------
// 同一Wi-Fiのタブレットからアクセスする際に使う、PCのLAN内IPv4アドレスを列挙する。
function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

// 既定ブラウザでURLを開く（AUTO_OPEN=1 のときのみ）。失敗しても無視する。
function openBrowser(url) {
  if (process.env.AUTO_OPEN !== '1') return;
  const platform = process.platform;
  try {
    if (platform === 'darwin') execFile('open', [url]);
    else if (platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else execFile('xdg-open', [url], () => {}); // Linux（無ければ黙って失敗）
  } catch (_e) {
    /* ブラウザ自動起動は必須ではないので握りつぶす */
  }
}

// ------------------------------------------------------------------
// 起動
// ------------------------------------------------------------------
server.listen(PORT, () => {
  const lan = getLanAddresses();
  console.log('==================================================');
  console.log('  🚜 農業すごろくクイズ サーバー起動');
  console.log('--------------------------------------------------');
  console.log('  ▼ この画面をプロジェクターに（教員PC）');
  console.log(`    ホスト画面 : http://localhost:${PORT}/host`);
  console.log('');
  console.log('  ▼ タブレットのブラウザでこのURLを開く（同じWi-Fi）');
  if (lan.length > 0) {
    lan.forEach((ip) => console.log(`    プレイヤー : http://${ip}:${PORT}/player`));
  } else {
    console.log(`    プレイヤー : http://<このPCのIPアドレス>:${PORT}/player`);
  }
  console.log('--------------------------------------------------');
  const label = gameState.currentLessonFile
    ? describeLessonFile(gameState.currentLessonFile).label
    : '（授業ファイルなし）';
  console.log(`  授業ファイル : ${label}（${gameState.quizPool.length}問）`);
  console.log('==================================================');
  console.log('  終了するには、この画面で Ctrl + C を押してください。');
  console.log('');

  openBrowser(`http://localhost:${PORT}/host`);
});

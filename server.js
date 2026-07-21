/**
 * server.js
 * ------------------------------------------------------------------
 * 双六クイズゲーム サーバー（Express + Socket.io）
 *
 * - 静的配信: /host（ホスト画面）, /player（プレイヤー画面）
 * - REST:     GET /api/characters（キャラクター画像一覧）
 * - リアルタイム通信: 要件定義 第6章のイベント設計に準拠
 * - 状態管理: 第4章のデータモデルをメモリ上で保持（永続化なし）
 * - 章9の未確定項目は game/rules.js の仮ルールに委譲（差し替え容易）
 * ------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const rules = require('./game/rules');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHARACTERS_DIR = path.join(PUBLIC_DIR, 'assets', 'characters');
const QUIZ_DEFAULT_PATH = path.join(__dirname, 'data', 'quiz_default.json');

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
      isCurrentTurn: false,
      joined: false, // タブレットが参加登録したか
      connected: false, // ソケット接続中か
    });
  }
  return teams;
}

let gameState = null;

function loadDefaultQuizzes() {
  try {
    const raw = fs.readFileSync(QUIZ_DEFAULT_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[quiz] quiz_default.json を読めませんでした:', e.message);
    return [];
  }
}

function resetGame() {
  gameState = {
    teams: createInitialTeams(),
    currentTurnIndex: 0,
    board: rules.buildBoard(),
    quizPool: loadDefaultQuizzes(),
    status: 'waiting', // waiting | rolling | quiz | result | finished
  };
  // 進行中クイズラウンドの一時状態（gameStateとは分離）
  round = null;
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }
}

// 進行中のクイズラウンド（一時的な作業領域）
let round = null; // { quiz, answers: {teamId: choiceIndex}, endsAt }
let roundTimer = null;

resetGame();

// ------------------------------------------------------------------
// 状態のサニタイズ（クライアントへ送る用）
//   - 進行中クイズの正解（answerIndex）は漏らさない
//   - quizPool の中身は送らず件数のみ（正解漏洩防止）
// ------------------------------------------------------------------
function publicGameState() {
  return {
    teams: gameState.teams.map((t) => ({
      id: t.id,
      name: t.name,
      character: t.character,
      position: t.position,
      points: t.points,
      isCurrentTurn: t.isCurrentTurn,
      joined: t.joined,
      connected: t.connected,
    })),
    currentTurnIndex: gameState.currentTurnIndex,
    currentTeamId: currentTeam() ? currentTeam().id : null,
    board: gameState.board,
    boardSize: rules.BOARD_SIZE,
    quizCount: gameState.quizPool.length,
    status: gameState.status,
    // クイズ中は「誰が回答済みか」だけ配信（何を選んだかは伏せる）
    answered: round ? Object.keys(round.answers) : [],
  };
}

function broadcastState() {
  io.emit('game_state_update', publicGameState());
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
  // 参加班が無い場合はそのまま
  syncTurnFlags();
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

// ------------------------------------------------------------------
// Socket.io イベント（第6章の設計）
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  // このソケットが担当している班（プレイヤーの場合）
  socket.data.teamId = null;
  socket.data.isHost = false;

  // 接続直後に現在状態を送る
  socket.emit('game_state_update', publicGameState());
  socket.emit('characters', { characters: listCharacterFiles() });

  // ---- ホスト参加 ----
  socket.on('join_host', () => {
    socket.data.isHost = true;
    socket.join('hosts');
    socket.emit('game_state_update', publicGameState());
    socket.emit('quiz_list', { quizzes: gameState.quizPool });
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

    // dice_result を全体配信
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
    // 回答権のある班か
    if (!round.eligible.includes(team.id)) return;
    // 二重回答は無視
    if (Object.prototype.hasOwnProperty.call(round.answers, team.id)) return;

    round.answers[team.id] = choiceIndex;
    // 誰が回答済みかを配信（内容は伏せる）
    io.emit('answer_progress', { answered: Object.keys(round.answers) });
    broadcastState();

    // 全員回答したら締め切り
    if (round.eligible.every((tid) => tid in round.answers)) {
      concludeQuizRound();
    }
  });

  // ---- クイズ追加登録（add_quiz / host→server） ----
  socket.on('add_quiz', (payload = {}) => handleAddQuiz(socket, payload));
  socket.on('host:add_quiz', (payload = {}) => handleAddQuiz(socket, payload));

  // ---- ホスト操作: ゲーム開始 ----
  socket.on('host:start_game', () => {
    if (joinedTeams().length === 0) {
      return socket.emit('error_msg', { message: '参加している班がありません。' });
    }
    // ポイント・位置をリセットして開始
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
    resetGame();
    io.emit('quiz_list', { quizzes: gameState.quizPool });
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
  });

  // ---- 切断 ----
  socket.on('disconnect', () => {
    if (socket.data.teamId) {
      const team = gameState.teams.find((t) => t.id === socket.data.teamId);
      if (team) {
        team.connected = false;
        // joined は維持（再接続で復帰できるように）。手番などの状態は保持。
        broadcastState();
      }
    }
  });
});

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
    // 問題が無ければクイズをスキップして手番交代
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
    return {
      teamId,
      teamName: team.name,
      choiceIndex,
      correct,
      gained,
      points: team.points,
    };
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
// クイズ追加登録
// ------------------------------------------------------------------
function handleAddQuiz(socket, payload) {
  const { question, choices, answerIndex, timeLimitSec } = payload;
  const errors = [];
  if (!question || typeof question !== 'string') errors.push('問題文が必要です。');
  if (!Array.isArray(choices) || choices.length < 2) errors.push('選択肢は2つ以上必要です。');
  if (Array.isArray(choices) && choices.some((c) => !c || !String(c).trim())) {
    errors.push('空の選択肢があります。');
  }
  const ansIdx = Number(answerIndex);
  if (!Number.isInteger(ansIdx) || ansIdx < 0 || (Array.isArray(choices) && ansIdx >= choices.length)) {
    errors.push('正解の選択肢が不正です。');
  }
  if (errors.length > 0) {
    return socket.emit('add_quiz_result', { ok: false, errors });
  }

  const limit = Number(timeLimitSec);
  const quiz = {
    id: `q_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    question: question.trim(),
    choices: choices.map((c) => String(c).trim()),
    answerIndex: ansIdx,
    timeLimitSec: Number.isFinite(limit) && limit >= 5 && limit <= 60 ? limit : 20,
  };
  gameState.quizPool.push(quiz);

  socket.emit('add_quiz_result', { ok: true, quiz });
  // ホスト全員にクイズ一覧を更新配信
  io.to('hosts').emit('quiz_list', { quizzes: gameState.quizPool });
  broadcastState();
}

// ------------------------------------------------------------------
// 起動
// ------------------------------------------------------------------
server.listen(PORT, () => {
  console.log('==================================================');
  console.log('  双六クイズゲーム サーバー起動');
  console.log(`  ホスト画面   : http://localhost:${PORT}/host`);
  console.log(`  プレイヤー   : http://localhost:${PORT}/player`);
  console.log(`  （タブレットは http://<PCのIP>:${PORT}/player へ）`);
  console.log('==================================================');
});

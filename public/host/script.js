/* ホスト画面ロジック */
const socket = io();

const TEAM_COLORS = {
  team1: '#ff6b6b', team2: '#4ecdc4', team3: '#ffd93d',
  team4: '#6bcb77', team5: '#a66dd4', team6: '#4d96ff',
};

let state = null;      // 最新の game_state
let characters = [];   // 利用可能キャラ一覧
let timerInterval = null;

// ---- DOM ----
const el = (id) => document.getElementById(id);
const boardEl = el('board');
const rankingEl = el('ranking');
const turnBanner = el('turnBanner');
const statusPill = el('statusPill');

const quizCard = el('quizCard');
const resultCard = el('resultCard');

// ---- 起動 ----
socket.emit('join_host');

// ================= 受信イベント =================
socket.on('characters', (data) => { characters = data.characters || []; });

socket.on('game_state_update', (s) => {
  state = s;
  renderBoard();
  renderRanking();
  renderStatus();
});

socket.on('turn_change', ({ currentTeamId }) => {
  // 状態は game_state_update で更新されるためバナーのみ即時更新
  const t = findTeam(currentTeamId);
  if (t) turnBanner.textContent = `▶ ${t.name} の手番`;
});

socket.on('dice_result', ({ teamName, dice }) => {
  showDice(teamName, dice);
});

socket.on('quiz_start', ({ quiz, eligible, endsAt }) => {
  showQuiz(quiz, eligible, endsAt);
});

socket.on('answer_progress', ({ answered }) => {
  updateAnswerStatus(answered);
});

socket.on('quiz_result', ({ answerIndex, results }) => {
  showResult(answerIndex, results);
});

socket.on('game_finished', ({ winners, teams }) => {
  showFinished(winners, teams);
});

socket.on('quiz_list', ({ quizzes }) => renderQuizList(quizzes));

// ================= 描画 =================
function findTeam(id) { return state ? state.teams.find((t) => t.id === id) : null; }

function renderStatus() {
  const map = {
    waiting: '待機中', rolling: 'サイコロ', quiz: 'クイズ中',
    result: '結果発表', finished: 'ゲーム終了',
  };
  statusPill.textContent = map[state.status] || state.status;

  const ct = findTeam(state.currentTeamId);
  if (state.status === 'finished') {
    turnBanner.textContent = '🏁 ゲーム終了！';
  } else if (state.teams.every((t) => !t.joined)) {
    turnBanner.textContent = '参加を待っています…';
  } else if (ct) {
    turnBanner.textContent = `▶ ${ct.name} の手番`;
  }

  // クイズ/結果カードの表示制御
  if (state.status !== 'quiz') hideQuizCardIfIdle();
  if (state.status !== 'result') resultCard.hidden = state.status !== 'finished' ? resultCard.hidden : false;
}

function hideQuizCardIfIdle() {
  if (state.status === 'waiting' || state.status === 'rolling' || state.status === 'finished') {
    quizCard.hidden = true;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
}

function renderBoard() {
  const size = state.boardSize;
  boardEl.innerHTML = '';
  // 各マスにどの班がいるか
  const tokensAt = {};
  state.teams.forEach((t) => {
    if (!t.joined) return;
    (tokensAt[t.position] = tokensAt[t.position] || []).push(t);
  });

  for (let i = 0; i <= size; i++) {
    const cell = document.createElement('div');
    const type = i === 0 ? 'start' : i === size ? 'goal' : 'quiz';
    cell.className = `cell ${type}`;
    const label = i === 0 ? 'START' : i === size ? 'GOAL' : i;
    cell.innerHTML = `<span class="idx">${label}</span>`;

    const tokens = tokensAt[i];
    if (tokens) {
      const wrap = document.createElement('div');
      wrap.className = 'tokens';
      tokens.forEach((t) => {
        const tk = document.createElement('div');
        tk.className = 'token';
        tk.title = t.name;
        if (t.character) {
          tk.style.backgroundImage = `url(/assets/characters/${t.character})`;
        } else {
          tk.style.background = TEAM_COLORS[t.id] || '#888';
        }
        wrap.appendChild(tk);
      });
      cell.appendChild(wrap);
    }
    boardEl.appendChild(cell);
  }
}

function renderRanking() {
  const sorted = [...state.teams]
    .filter((t) => t.joined)
    .sort((a, b) => b.points - a.points || a.position - b.position);
  rankingEl.innerHTML = '';
  if (sorted.length === 0) {
    rankingEl.innerHTML = '<li class="offline">まだ参加している班がありません</li>';
    return;
  }
  sorted.forEach((t, i) => {
    const li = document.createElement('li');
    if (t.isCurrentTurn) li.classList.add('current');
    if (!t.connected) li.classList.add('offline');
    const avatar = t.character
      ? `background-image:url(/assets/characters/${t.character})`
      : `background:${TEAM_COLORS[t.id] || '#888'}`;
    li.innerHTML = `
      <span class="rank-no">${i + 1}</span>
      <span class="avatar" style="${avatar}"></span>
      <span class="tname">${t.name}${t.connected ? '' : '（切断中）'}</span>
      <span class="tpts">${t.points}</span>`;
    rankingEl.appendChild(li);
  });
}

// ---- サイコロ演出 ----
function showDice(teamName, dice) {
  const overlay = el('diceOverlay');
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  el('diceFace').textContent = faces[dice - 1] || '🎲';
  el('diceCaption').textContent = `${teamName} → ${dice} が出た！`;
  overlay.hidden = false;
  // 少しで自動的に消す
  setTimeout(() => { overlay.hidden = true; }, 1600);
}

// ---- クイズ表示 ----
function showQuiz(quiz, eligible, endsAt) {
  resultCard.hidden = true;
  quizCard.hidden = false;
  el('quizQuestion').textContent = quiz.question;

  const ul = el('quizChoices');
  ul.innerHTML = '';
  quiz.choices.forEach((c, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    li.textContent = `${i + 1}. ${c}`;
    ul.appendChild(li);
  });

  // 解答状況チップ
  const status = el('answerStatus');
  status.innerHTML = '';
  eligible.forEach((tid) => {
    const t = findTeam(tid);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.team = tid;
    chip.textContent = t ? t.name : tid;
    status.appendChild(chip);
  });

  startTimer(endsAt, quiz.timeLimitSec);
}

function updateAnswerStatus(answered) {
  document.querySelectorAll('#answerStatus .chip').forEach((chip) => {
    chip.classList.toggle('done', answered.includes(chip.dataset.team));
  });
}

function startTimer(endsAt, totalSec) {
  const bar = el('timerBar');
  const text = el('timerText');
  if (timerInterval) clearInterval(timerInterval);
  const tick = () => {
    const remain = Math.max(0, endsAt - Date.now()) / 1000;
    bar.style.width = `${Math.min(100, (remain / totalSec) * 100)}%`;
    text.textContent = `残り ${Math.ceil(remain)} 秒`;
    if (remain <= 0 && timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  };
  tick();
  timerInterval = setInterval(tick, 200);
}

// ---- 結果表示 ----
function showResult(answerIndex, results) {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  // 正解の選択肢をハイライト
  document.querySelectorAll('#quizChoices li').forEach((li) => {
    li.classList.toggle('correct', Number(li.dataset.index) === answerIndex);
  });

  resultCard.hidden = false;
  const body = el('resultBody');
  body.innerHTML = '';
  results.forEach((r) => {
    const row = document.createElement('div');
    row.className = `rrow ${r.correct ? 'correct' : 'wrong'}`;
    const choiceLabel = r.choiceIndex === null ? '未回答' : `選択肢${r.choiceIndex + 1}`;
    row.innerHTML = `
      <strong>${r.teamName}</strong>
      <span>${r.correct ? '⭕ 正解' : '❌ ' + choiceLabel}</span>
      <span class="gained">${r.gained > 0 ? '+' + r.gained : ''}</span>`;
    body.appendChild(row);
  });
}

// ---- ゲーム終了 ----
function showFinished(winners, teams) {
  quizCard.hidden = true;
  resultCard.hidden = false;
  const names = winners.map((id) => (teams.find((t) => t.id === id) || {}).name).filter(Boolean);
  const body = el('resultBody');
  const tie = names.length > 1 ? '（同点・両者勝利）' : '';
  body.innerHTML = `<div class="rrow correct"><strong>🏆 勝者: ${names.join('・')} ${tie}</strong></div>`;
  const sorted = [...teams].filter((t) => t.joined).sort((a, b) => b.points - a.points);
  sorted.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'rrow';
    row.innerHTML = `<strong>${t.name}</strong><span class="gained">${t.points} pt</span>`;
    body.appendChild(row);
  });
}

// ================= 操作 =================
el('startBtn').onclick = () => socket.emit('host:start_game');
el('nextBtn').onclick = () => socket.emit('host:next_turn');
el('resetBtn').onclick = () => {
  if (confirm('ゲームをリセットしますか？（ポイント・位置・参加が初期化されます）')) {
    socket.emit('host:reset_game');
  }
};

// クイズ管理パネル
const adminOverlay = el('adminOverlay');
el('adminToggle').onclick = () => {
  adminOverlay.hidden = false;
  socket.emit('host:get_quizzes');
};
el('adminClose').onclick = () => { adminOverlay.hidden = true; };

el('quizForm').onsubmit = (e) => {
  e.preventDefault();
  const question = el('qQuestion').value.trim();
  const choices = [...document.querySelectorAll('#choicesGrid input[data-choice]')]
    .map((i) => i.value.trim())
    .filter((v) => v.length > 0);
  const answerIndex = Number(el('qAnswer').value);
  const timeLimitSec = Number(el('qTime').value);

  socket.emit('add_quiz', { question, choices, answerIndex, timeLimitSec });
};

socket.on('add_quiz_result', ({ ok, errors, quiz }) => {
  const msg = el('formMsg');
  if (ok) {
    msg.className = 'form-msg ok';
    msg.textContent = `「${quiz.question}」を追加しました。`;
    el('quizForm').reset();
    el('qTime').value = 20;
  } else {
    msg.className = 'form-msg err';
    msg.textContent = (errors || ['追加に失敗しました。']).join(' / ');
  }
});

function renderQuizList(quizzes) {
  el('quizCount').textContent = quizzes.length;
  const ul = el('quizList');
  ul.innerHTML = '';
  quizzes.forEach((q, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${i + 1}.</strong> ${q.question}
      <span class="q-ans">［答: ${q.choices[q.answerIndex]}］</span>
      <span style="color:var(--muted)">(${q.timeLimitSec}秒)</span>`;
    ul.appendChild(li);
  });
}

// 正解セレクトを選択肢数に応じて更新（簡易）
document.querySelectorAll('#choicesGrid input[data-choice]').forEach((inp, idx) => {
  inp.addEventListener('input', () => {
    const opts = document.querySelectorAll('#qAnswer option');
    const val = inp.value.trim();
    if (opts[idx]) opts[idx].textContent = val ? `選択肢${idx + 1}: ${val}` : `選択肢${idx + 1}`;
  });
});

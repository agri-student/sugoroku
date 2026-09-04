/* ホスト画面ロジック */
const socket = io();

const TEAM_COLORS = {
  team1: '#ff6b6b', team2: '#4ecdc4', team3: '#ffd93d',
  team4: '#6bcb77', team5: '#a66dd4', team6: '#4d96ff',
};

// 各マスに表示する作物アイコン（農業テーマ）。順番に繰り返し表示。
const CROP_ICONS = ['🌾', '🥕', '🌽', '🍅', '🥔', '🍆', '🌻', '🥬', '🫑', '🧅', '🍠', '🥦', '🍓', '🐄', '🐔'];

let state = null;      // 最新の game_state
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
socket.on('game_state_update', (s) => {
  state = s;
  renderBoard();
  renderRanking();
  renderStatus();
  renderSetupBar();
});

socket.on('lesson_list', ({ lessons, current }) => renderLessonSelect(lessons, current));

socket.on('turn_change', ({ currentTeamId }) => {
  const t = findTeam(currentTeamId);
  if (t) turnBanner.textContent = `▶ ${t.name} の手番`;
});

socket.on('dice_result', ({ teamName, dice }) => showDice(teamName, dice));

socket.on('quiz_start', ({ quiz, eligible, endsAt }) => showQuiz(quiz, eligible, endsAt));

socket.on('answer_progress', ({ answered }) => updateAnswerStatus(answered));

socket.on('quiz_result', ({ answerIndex, results }) => showResult(answerIndex, results));

socket.on('game_finished', ({ winners, teams }) => showFinished(winners, teams));

socket.on('quiz_list', ({ quizzes }) => renderQuizList(quizzes));

socket.on('quiz_pending_list', ({ pending }) => renderPendingList(pending));

socket.on('error_msg', ({ message }) => {
  const msg = el('formMsg');
  if (msg && !el('adminOverlay').hidden) {
    msg.className = 'form-msg err';
    msg.textContent = message;
  } else {
    console.warn(message);
  }
});

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

  if (state.status !== 'quiz') hideQuizCardIfIdle();
}

function hideQuizCardIfIdle() {
  if (state.status === 'waiting' || state.status === 'rolling' || state.status === 'finished') {
    quizCard.hidden = true;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
}

// 授業ファイル・承認モードの設定バー
function renderSetupBar() {
  el('lessonInfo').textContent = `${state.quizCount} 問`;
  const toggle = el('approvalToggle');
  toggle.checked = !!state.approvalRequired;
  el('approvalText').textContent = state.approvalRequired ? '必須' : '不要';

  // 承認待ち件数バッジ
  const n = state.pendingCount || 0;
  [el('pendingBadge'), el('pendingTabBadge')].forEach((b) => {
    if (!b) return;
    b.textContent = n;
    b.hidden = n === 0;
  });

  // ゲーム中は授業ファイルの変更を禁止（クイズプールが入れ替わるため）
  const locked = state.status === 'quiz';
  el('lessonSelect').disabled = locked;
}

function renderLessonSelect(lessons, current) {
  const sel = el('lessonSelect');
  sel.innerHTML = '';
  if (!lessons || lessons.length === 0) {
    sel.innerHTML = '<option value="">（data フォルダに quiz_*.json がありません）</option>';
    return;
  }
  lessons.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l.file;
    opt.textContent = `${l.label}（${l.count}問）`;
    if (l.file === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderBoard() {
  const size = state.boardSize;
  boardEl.innerHTML = '';
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
    const crop = i === 0 ? '🏡' : i === size ? '🏆' : CROP_ICONS[(i - 1) % CROP_ICONS.length];
    cell.innerHTML = `<span class="idx">${label}</span><span class="crop">${crop}</span>`;

    const tokens = tokensAt[i];
    if (tokens) {
      const wrap = document.createElement('div');
      wrap.className = 'tokens';
      tokens.forEach((t) => {
        const tk = document.createElement('div');
        // 手番の班のキャラクターは大きく表示する（要件 5-1）
        tk.className = 'token' + (t.isCurrentTurn ? ' current' : '');
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
      <span class="tname">${escapeHtml(t.name)}${t.connected ? '' : '（切断中）'}</span>
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
  setTimeout(() => { overlay.hidden = true; }, 1600);
}

// ---- クイズ表示 ----
function showQuiz(quiz, eligible, endsAt) {
  resultCard.hidden = true;
  quizCard.hidden = false;
  el('quizQuestion').textContent = quiz.question;
  el('quizMeta').textContent = quiz.source === 'student'
    ? `📝 ${quiz.registeredBy || '生徒'} が登録した問題`
    : '';

  const ul = el('quizChoices');
  ul.innerHTML = '';
  quiz.choices.forEach((c, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    li.textContent = `${i + 1}. ${c}`;
    ul.appendChild(li);
  });

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
      <strong>${escapeHtml(r.teamName)}</strong>
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
  body.innerHTML = `<div class="rrow correct"><strong>🏆 勝者: ${escapeHtml(names.join('・'))} ${tie}</strong></div>`;
  const sorted = [...teams].filter((t) => t.joined).sort((a, b) => b.points - a.points);
  sorted.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'rrow';
    row.innerHTML = `<strong>${escapeHtml(t.name)}</strong><span class="gained">${t.points} pt</span>`;
    body.appendChild(row);
  });
}

// ================= 操作 =================
el('startBtn').onclick = () => socket.emit('host:start_game');
el('nextBtn').onclick = () => socket.emit('host:next_turn');
el('resetBtn').onclick = () => {
  if (confirm('ゲームをリセットしますか？（ポイント・位置・参加が初期化されます。授業ファイルの選択は保持されます）')) {
    socket.emit('host:reset_game');
  }
};

// 授業ファイル選択
el('lessonSelect').onchange = (e) => {
  socket.emit('select_lesson_file', { file: e.target.value });
};

// 承認モード切替
el('approvalToggle').onchange = (e) => {
  socket.emit('set_approval_mode', { required: e.target.checked });
};

// クイズ管理パネル
const adminOverlay = el('adminOverlay');
el('adminToggle').onclick = () => {
  adminOverlay.hidden = false;
  socket.emit('host:get_quizzes');
};
el('adminClose').onclick = () => { adminOverlay.hidden = true; };

// タブ切り替え
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach((b) => {
      b.hidden = b.dataset.body !== tab.dataset.tab;
    });
  };
});

// 教員によるクイズ追加
el('quizForm').onsubmit = (e) => {
  e.preventDefault();
  const question = el('qQuestion').value.trim();
  const choices = [...document.querySelectorAll('#choicesGrid input[data-choice]')].map((i) => i.value.trim());
  const answerIndex = Number(el('qAnswer').value);
  const timeLimitSec = Number(el('qTime').value);
  socket.emit('add_quiz', { question, choices, answerIndex, timeLimitSec });
};

socket.on('add_quiz_result', ({ ok, errors, quiz, saved, savedTo, saveError }) => {
  const msg = el('formMsg');
  if (ok) {
    msg.className = 'form-msg ok';
    msg.textContent = saved
      ? `「${quiz.question}」を追加し、${savedTo} に保存しました。`
      : `「${quiz.question}」を追加しました（ファイル保存は失敗: ${saveError || '不明'}）。`;
    el('quizForm').reset();
    el('qTime').value = 20;
    resetAnswerOptions();
  } else {
    msg.className = 'form-msg err';
    msg.textContent = (errors || ['追加に失敗しました。']).join(' / ');
  }
});

// ---- 承認待ち一覧 ----
function renderPendingList(pending) {
  const ul = el('pendingList');
  const hint = el('pendingHint');
  ul.innerHTML = '';

  if (state && !state.approvalRequired) {
    hint.textContent = '承認モードは「不要」です。生徒が登録したクイズはすぐ出題プールに入ります。';
  } else {
    hint.textContent = '生徒が登録したクイズです。「承認」を押すと出題プールに入り、授業ファイルにも保存されます。';
  }

  if (!pending || pending.length === 0) {
    ul.innerHTML = '<li class="empty">承認待ちのクイズはありません。</li>';
    return;
  }
  pending.forEach((q) => {
    const li = document.createElement('li');
    li.className = 'pending-item';
    const choices = q.choices
      .map((c, i) => `<span class="pc ${i === q.answerIndex ? 'ans' : ''}">${i + 1}. ${escapeHtml(c)}</span>`)
      .join('');
    li.innerHTML = `
      <div class="pending-head">
        <span class="who">📝 ${escapeHtml(q.registeredBy || '生徒')}</span>
        <span class="sec">${q.timeLimitSec}秒</span>
      </div>
      <div class="pending-q">${escapeHtml(q.question)}</div>
      <div class="pending-choices">${choices}</div>
      <div class="pending-actions">
        <button class="btn btn-primary sm" data-approve="${q.id}">承認する</button>
        <button class="btn btn-ghost sm" data-reject="${q.id}">却下</button>
      </div>`;
    ul.appendChild(li);
  });

  ul.querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = () => socket.emit('approve_quiz', { quizId: b.dataset.approve });
  });
  ul.querySelectorAll('[data-reject]').forEach((b) => {
    b.onclick = () => {
      if (confirm('このクイズを却下しますか？')) socket.emit('reject_quiz', { quizId: b.dataset.reject });
    };
  });
}

// ---- 登録済み一覧 ----
function renderQuizList(quizzes) {
  el('quizCount').textContent = quizzes.length;
  el('saveNote').textContent = state && state.currentLessonFile ? `保存先: ${state.currentLessonFile}` : '';
  const ul = el('quizList');
  ul.innerHTML = '';
  quizzes.forEach((q, i) => {
    const li = document.createElement('li');
    const tag = q.source === 'student'
      ? `<span class="tag student">生徒: ${escapeHtml(q.registeredBy || '')}</span>`
      : '<span class="tag teacher">教員</span>';
    li.innerHTML = `<strong>${i + 1}.</strong> ${escapeHtml(q.question)} ${tag}
      <span class="q-ans">［答: ${escapeHtml(q.choices[q.answerIndex] || '')}］</span>
      <span class="q-sec">(${q.timeLimitSec}秒)</span>`;
    ul.appendChild(li);
  });
}

// 正解セレクトの表示を入力に追従させる
function resetAnswerOptions() {
  document.querySelectorAll('#qAnswer option').forEach((opt, i) => {
    opt.textContent = `選択肢${i + 1}`;
  });
}
document.querySelectorAll('#choicesGrid input[data-choice]').forEach((inp, idx) => {
  inp.addEventListener('input', () => {
    const opts = document.querySelectorAll('#qAnswer option');
    const val = inp.value.trim();
    if (opts[idx]) opts[idx].textContent = val ? `選択肢${idx + 1}: ${val}` : `選択肢${idx + 1}`;
  });
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

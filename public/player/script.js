/* プレイヤー画面ロジック */
const socket = io();
const el = (id) => document.getElementById(id);

let myTeamId = null;
let selectedCharacter = null;
let characters = [];
let state = null;
let currentQuiz = null;   // 出題中クイズ
let answered = false;
let qTimerInterval = null;
let myQuizzes = [];       // 自分の班が登録したクイズ（承認状況つき）

// 端末に班を記憶（リロード復帰用）
const savedTeam = sessionStorage.getItem('sugoroku_team');

// ================= 受信 =================
socket.on('characters', (data) => {
  characters = data.characters || [];
  renderCharacterGrid();
});

socket.on('game_state_update', (s) => {
  state = s;
  renderJoinGrid();
  updateSubmitHint();
  if (myTeamId) updateGame();
});

socket.on('joined', ({ teamId }) => {
  myTeamId = teamId;
  sessionStorage.setItem('sugoroku_team', teamId);
  el('joinErr').textContent = '';
  goCharacterScreen();
});

socket.on('error_msg', ({ message }) => {
  if (!el('screenJoin').hidden) el('joinErr').textContent = message;
  else flashDiceMsg(message);
});

socket.on('dice_result', ({ teamId, dice, to }) => {
  if (teamId === myTeamId) {
    el('diceResult').textContent = `🎲 ${dice} が出た！ → ${to} マスへ`;
  }
});

socket.on('quiz_start', ({ quiz, eligible, endsAt }) => {
  currentQuiz = quiz;
  answered = false;
  showQuiz(quiz, eligible.includes(myTeamId), endsAt);
});

socket.on('quiz_result', ({ answerIndex, results }) => showQuizResult(answerIndex, results));

socket.on('game_finished', ({ winners, teams }) => showFinished(winners, teams));

// 自分の班が登録したクイズが承認された／却下された
socket.on('quiz_approved', ({ quiz }) => {
  markMyQuiz(quiz.id, 'approved');
  showSubmitMsg(`✅ 「${quiz.question}」が先生に承認されました！`, 'ok');
});
socket.on('quiz_rejected', ({ quiz }) => {
  markMyQuiz(quiz.id, 'rejected');
  showSubmitMsg(`「${quiz.question}」は今回は使われないことになりました。`, '');
});

// ================= 班選択 =================
function renderJoinGrid() {
  if (!state) return;
  const grid = el('teamGrid');
  if (!grid) return;
  grid.innerHTML = '';
  state.teams.forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'team-card';
    const taken = t.joined && t.connected && t.id !== myTeamId;
    btn.disabled = taken;
    btn.innerHTML = `${t.name}<span class="tag">${taken ? '使用中' : (t.joined ? '参加済み' : '空き')}</span>`;
    btn.onclick = () => socket.emit('join_team', { teamId: t.id });
    grid.appendChild(btn);
  });
}

// 自動復帰
if (savedTeam) {
  socket.emit('join_team', { teamId: savedTeam });
}

// ================= キャラクター選択 =================
function renderCharacterGrid() {
  const grid = el('charGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (characters.length === 0) {
    grid.innerHTML = '<p style="grid-column:1/-1;color:var(--muted);text-align:center">キャラクター画像がありません（assets/characters に追加してください）</p>';
    return;
  }
  characters.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'char-item';
    item.innerHTML = `<img src="/assets/characters/${c}" alt="${c}" />`;
    item.onclick = () => {
      selectedCharacter = c;
      [...grid.children].forEach((ch) => ch.classList.remove('selected'));
      item.classList.add('selected');
      el('charConfirm').disabled = false;
    };
    grid.appendChild(item);
  });
}

function goCharacterScreen() {
  el('screenJoin').hidden = true;
  el('screenCharacter').hidden = false;
  el('screenGame').hidden = true;
  const t = state && state.teams.find((x) => x.id === myTeamId);
  el('charTitle').textContent = `${t ? t.name : ''} のキャラクターをえらぼう`;
  renderCharacterGrid();
  if (t && t.character) {
    selectedCharacter = t.character;
    goGameScreen();
  }
}

el('charConfirm').onclick = () => {
  if (!selectedCharacter) return;
  socket.emit('select_character', { teamId: myTeamId, character: selectedCharacter });
  goGameScreen();
};

// ================= ゲーム画面 =================
function goGameScreen() {
  el('screenJoin').hidden = true;
  el('screenCharacter').hidden = true;
  el('screenGame').hidden = false;
  updateGame();
  updateSubmitHint();
}

function myTeam() {
  return state ? state.teams.find((t) => t.id === myTeamId) : null;
}

function updateGame() {
  if (el('screenGame').hidden) return;
  const me = myTeam();
  if (!me) return;

  if (me.character) el('meAvatar').style.backgroundImage = `url(/assets/characters/${me.character})`;
  el('meName').textContent = me.name;
  el('mePts').textContent = me.points;
  el('mePos').textContent = me.position;

  const turnInfo = el('turnInfo');
  const ct = state.teams.find((t) => t.id === state.currentTeamId);

  const inQuiz = state.status === 'quiz';
  const inResult = state.status === 'result';
  el('dicePanel').hidden = inQuiz || inResult || state.status === 'finished';

  const myTurn = me.isCurrentTurn;
  const canRoll = myTurn && state.status === 'waiting';
  el('rollBtn').disabled = !canRoll;

  // 手番の時は自分のキャラクターを大きく表示する（要件 5-2）
  el('meAvatar').classList.toggle('big', !!myTurn);

  if (state.status === 'finished') {
    turnInfo.textContent = '🏁 ゲーム終了';
    turnInfo.classList.remove('my-turn');
  } else if (myTurn && state.status === 'waiting') {
    turnInfo.textContent = '👉 あなたの手番です！サイコロを振ろう';
    turnInfo.classList.add('my-turn');
  } else if (ct) {
    turnInfo.textContent = `${ct.name} の手番です`;
    turnInfo.classList.remove('my-turn');
  } else {
    turnInfo.textContent = '開始を待っています…';
    turnInfo.classList.remove('my-turn');
  }

  if (state.status === 'waiting') el('diceResult').textContent = '';
}

el('rollBtn').onclick = () => {
  socket.emit('roll_dice', { teamId: myTeamId });
  el('rollBtn').disabled = true;
  el('diceResult').textContent = '🎲 …';
};

function flashDiceMsg(msg) {
  const d = el('diceResult');
  d.textContent = msg;
  setTimeout(() => { if (d.textContent === msg) d.textContent = ''; }, 2000);
}

// ================= クイズ =================
function showQuiz(quiz, canAnswer, endsAt) {
  el('dicePanel').hidden = true;
  el('resultPanel').hidden = true;
  el('quizPanel').hidden = false;

  el('qQuestion').textContent = quiz.question;
  el('qFeedback').textContent = canAnswer ? '' : '（この問題は回答できません）';
  el('qFeedback').className = 'q-feedback';

  const wrap = el('qChoices');
  wrap.innerHTML = '';
  quiz.choices.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = `${i + 1}. ${c}`;
    btn.disabled = !canAnswer;
    btn.dataset.index = i;
    btn.onclick = () => pickAnswer(i, btn);
    wrap.appendChild(btn);
  });

  startQTimer(endsAt, quiz.timeLimitSec);
}

function pickAnswer(index, btn) {
  if (answered) return;
  answered = true;
  socket.emit('submit_answer', { teamId: myTeamId, choiceIndex: index });
  [...el('qChoices').children].forEach((b) => { b.disabled = true; });
  btn.classList.add('picked');
  el('qFeedback').textContent = '回答しました。結果を待っています…';
  el('qFeedback').className = 'q-feedback';
}

function startQTimer(endsAt, totalSec) {
  if (qTimerInterval) clearInterval(qTimerInterval);
  const tick = () => {
    const remain = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el('qTimer').textContent = `残り ${remain} 秒`;
    if (remain <= 0 && qTimerInterval) { clearInterval(qTimerInterval); qTimerInterval = null; }
  };
  tick();
  qTimerInterval = setInterval(tick, 250);
}

function showQuizResult(answerIndex, results) {
  if (qTimerInterval) { clearInterval(qTimerInterval); qTimerInterval = null; }
  el('qTimer').textContent = '';

  [...el('qChoices').children].forEach((b) => {
    const idx = Number(b.dataset.index);
    if (idx === answerIndex) b.classList.add('correct');
    if (b.classList.contains('picked') && idx !== answerIndex) b.classList.add('wrong');
  });

  const mine = results.find((r) => r.teamId === myTeamId);
  const fb = el('qFeedback');
  if (mine) {
    if (mine.correct) {
      fb.textContent = `⭕ 正解！ +${mine.gained} ポイント`;
      fb.className = 'q-feedback ok';
    } else if (mine.choiceIndex === null) {
      fb.textContent = '⌛ 時間切れ…';
      fb.className = 'q-feedback ng';
    } else {
      fb.textContent = '❌ 残念、不正解';
      fb.className = 'q-feedback ng';
    }
  } else {
    fb.textContent = `正解は「${currentQuiz ? currentQuiz.choices[answerIndex] : ''}」`;
    fb.className = 'q-feedback';
  }

  setTimeout(() => {
    el('quizPanel').hidden = true;
    updateGame();
  }, 3200);
}

// ================= 終了 =================
function showFinished(winners, teams) {
  el('quizPanel').hidden = true;
  el('dicePanel').hidden = true;
  const panel = el('resultPanel');
  panel.hidden = false;
  const iWon = winners.includes(myTeamId);
  const names = winners.map((id) => (teams.find((t) => t.id === id) || {}).name).filter(Boolean);
  panel.innerHTML = `
    <div class="big-emoji">${iWon ? '🏆' : '🎉'}</div>
    <h2>${iWon ? 'あなたの班の勝ち！' : 'ゲーム終了'}</h2>
    <p style="text-align:center">勝者: ${escapeHtml(names.join('・'))}${names.length > 1 ? '（同点・両者勝利）' : ''}</p>`;
}

// ================= クイズ登録（生徒） =================
el('submitToggle').onclick = () => {
  const body = el('submitBody');
  body.hidden = !body.hidden;
  el('submitChev').textContent = body.hidden ? '▼' : '▲';
};

function updateSubmitHint() {
  const hint = el('submitHint');
  if (!hint || !state) return;
  hint.textContent = state.approvalRequired
    ? '登録した問題は先生の承認後に出題されます。'
    : '登録した問題はすぐに出題プールに入ります。';
  hint.className = 'submit-hint' + (state.approvalRequired ? ' pending' : ' direct');
}

el('studentQuizForm').onsubmit = (e) => {
  e.preventDefault();
  const question = el('sQuestion').value.trim();
  const choices = [...document.querySelectorAll('#sChoices input[data-schoice]')].map((i) => i.value.trim());
  const answerIndex = Number(el('sAnswer').value);
  const timeLimitSec = Number(el('sTime').value);
  socket.emit('submit_quiz_by_student', { teamId: myTeamId, question, choices, answerIndex, timeLimitSec });
};

socket.on('submit_quiz_result', ({ ok, errors, pending, quiz }) => {
  if (!ok) {
    showSubmitMsg((errors || ['登録に失敗しました。']).join(' / '), 'ng');
    return;
  }
  myQuizzes.push({ ...quiz, status: pending ? 'pending' : 'approved' });
  renderMyQuizzes();
  showSubmitMsg(
    pending ? '📮 登録しました。先生の承認待ちです。' : '✅ 登録しました。すぐに出題されます！',
    'ok'
  );
  el('studentQuizForm').reset();
  el('sTime').value = 20;
  resetSAnswerOptions();
});

function showSubmitMsg(text, kind) {
  const m = el('submitMsg');
  m.textContent = text;
  m.className = 'submit-msg' + (kind ? ' ' + kind : '');
  // 登録パネルが閉じていたら開いて気づけるようにする
  if (el('submitBody').hidden) {
    el('submitBody').hidden = false;
    el('submitChev').textContent = '▲';
  }
}

function markMyQuiz(quizId, status) {
  const q = myQuizzes.find((x) => x.id === quizId);
  if (q) q.status = status;
  renderMyQuizzes();
}

function renderMyQuizzes() {
  const ul = el('myQuizzes');
  ul.innerHTML = '';
  if (myQuizzes.length === 0) return;
  const label = { pending: '承認待ち', approved: '出題プールに反映', rejected: '見送り' };
  myQuizzes.forEach((q) => {
    const li = document.createElement('li');
    li.className = `mq ${q.status}`;
    li.innerHTML = `<span class="mq-q">${escapeHtml(q.question)}</span>
      <span class="mq-status">${label[q.status] || ''}</span>`;
    ul.appendChild(li);
  });
}

function resetSAnswerOptions() {
  document.querySelectorAll('#sAnswer option').forEach((opt, i) => {
    opt.textContent = `選択肢${i + 1}`;
  });
}
document.querySelectorAll('#sChoices input[data-schoice]').forEach((inp, idx) => {
  inp.addEventListener('input', () => {
    const opts = document.querySelectorAll('#sAnswer option');
    const val = inp.value.trim();
    if (opts[idx]) opts[idx].textContent = val ? `選択肢${idx + 1}: ${val}` : `選択肢${idx + 1}`;
  });
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

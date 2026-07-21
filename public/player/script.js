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
  if (myTeamId) updateGame();
});

socket.on('joined', ({ teamId }) => {
  myTeamId = teamId;
  sessionStorage.setItem('sugoroku_team', teamId);
  el('joinErr').textContent = '';
  goCharacterScreen();
});

socket.on('error_msg', ({ message }) => {
  // 班選択中はその場に、ゲーム中は一時表示
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
  const canAnswer = eligible.includes(myTeamId);
  showQuiz(quiz, canAnswer, endsAt);
});

socket.on('quiz_result', ({ answerIndex, results }) => {
  showQuizResult(answerIndex, results);
});

socket.on('game_finished', ({ winners, teams }) => {
  showFinished(winners, teams);
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
  // stateが来る前でもjoinを試みる
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
  // 既にキャラ選択済みなら復帰時はゲームへ
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

  // クイズ中/結果中はサイコロパネルを隠す
  const inQuiz = state.status === 'quiz';
  const inResult = state.status === 'result';
  el('dicePanel').hidden = inQuiz || inResult || state.status === 'finished';

  // サイコロボタンの有効化
  const myTurn = me.isCurrentTurn;
  const canRoll = myTurn && (state.status === 'waiting');
  el('rollBtn').disabled = !canRoll;

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

  // 手番が変わったらサイコロ結果表示をクリア
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
  const panel = el('quizPanel');
  panel.hidden = false;

  el('qQuestion').textContent = quiz.question;
  el('qFeedback').textContent = canAnswer ? '' : '（このラウンドは他班の手番の問題です）';
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

  // 次の手番に向けてしばらく後にクイズパネルを閉じる
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
    <p style="text-align:center">勝者: ${names.join('・')}${names.length > 1 ? '（同点・両者勝利）' : ''}</p>`;
}

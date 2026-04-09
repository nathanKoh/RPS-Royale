const socket = io();

let state = {
  roomId: null,
  joinCode: null,
  playerId: null,
  isHost: false,
  username: null,
  roomState: null,
  roundNumber: 0,
  fieldWidth: 800,
  fieldHeight: 600,
  choiceDeadline: null,
  currentType: null,
  spawn: { x: null, y: null },
  players: []
};

// DOM elements
const loginScreen = document.getElementById('login-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');

const usernameInput = document.getElementById('username');
const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const joinCodeInput = document.getElementById('join-code-input');
const errorDiv = document.getElementById('error');

const roomCodeSpan = document.getElementById('room-code');
const playerNameSpan = document.getElementById('player-name');
const hostLabelSpan = document.getElementById('host-label');
const roundNumberSpan = document.getElementById('round-number');
const playerList = document.getElementById('player-list');
const startGameBtn = document.getElementById('start-game-btn');

const gameRoundNumberSpan = document.getElementById('game-round-number');
const countdownSpan = document.getElementById('countdown');
const currentTypeSpan = document.getElementById('current-type');
const choiceButtons = document.querySelectorAll('.choice-btn');
const choiceStatusSpan = document.getElementById('choice-status');
const roundResultDiv = document.getElementById('round-result');
const gameOverDiv = document.getElementById('game-over');

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// Simple colors for types
const typeColors = {
  ROCK: '#8888ff',
  PAPER: '#88ff88',
  SCISSORS: '#ff8888'
};

// --- Load sprites ---
const sprites = {
  ROCK: new Image(),
  PAPER: new Image(),
  SCISSORS: new Image()
};

sprites.ROCK.src = 'assets/rock.png';
sprites.PAPER.src = 'assets/paper.png';
sprites.SCISSORS.src = 'assets/scissors.png';

// --- UI helpers ---
function showLogin() {
  loginScreen.classList.remove('hidden');
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.add('hidden');
}

function showLobby() {
  loginScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  gameScreen.classList.add('hidden');
}

function showGame() {
  loginScreen.classList.add('hidden');
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
}

function updateLobby(roomUpdate) {
  state.roomState = roomUpdate.state;
  state.roundNumber = roomUpdate.roundNumber;

  roomCodeSpan.textContent = roomUpdate.joinCode;
  playerNameSpan.textContent = state.username;
  hostLabelSpan.textContent = state.isHost ? 'Host' : 'Player';
  roundNumberSpan.textContent = roomUpdate.roundNumber;

  playerList.innerHTML = '';
  roomUpdate.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.username + (p.id === roomUpdate.hostId ? ' (Host)' : '');
    playerList.appendChild(li);
  });

  if (state.isHost && roomUpdate.state === 'WAITING_FOR_PLAYERS') {
    startGameBtn.classList.remove('hidden');
  } else {
    startGameBtn.classList.add('hidden');
  }
}

function updateCountdown() {
  if (!state.choiceDeadline) {
    countdownSpan.textContent = '';
    countdownSpan.classList.remove('flash');
    return;
  }
  const now = Date.now();
  const remainingMs = state.choiceDeadline - now;
  if (remainingMs <= 0) {
    countdownSpan.textContent = '0';
    countdownSpan.classList.remove('flash');
    return;
  }
  const remainingSec = Math.ceil(remainingMs / 1000);
  countdownSpan.textContent = remainingSec.toString();

  if (remainingSec <= 3) {
    countdownSpan.classList.add('flash');
  } else {
    countdownSpan.classList.remove('flash');
  }
}

// --- Event handlers ---
createRoomBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  if (!username) {
    errorDiv.textContent = 'Enter a username';
    return;
  }
  errorDiv.textContent = '';
  state.username = username;
  socket.emit('createRoom', { username });
});

joinRoomBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  const joinCode = joinCodeInput.value.trim().toUpperCase();
  if (!username || !joinCode) {
    errorDiv.textContent = 'Enter username and join code';
    return;
  }
  errorDiv.textContent = '';
  state.username = username;
  socket.emit('joinRoom', { username, joinCode });
});

startGameBtn.addEventListener('click', () => {
  if (!state.roomId) return;
  socket.emit('startGame', { roomId: state.roomId });
});

choiceButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.roomId || !state.choiceDeadline) return;
    const type = btn.getAttribute('data-type');
    state.currentType = type;
    currentTypeSpan.textContent = type;
    choiceStatusSpan.textContent = 'Click on the field to choose spawn location';
  });
});

canvas.addEventListener('click', e => {
  if (!state.roomId || !state.choiceDeadline) return;
  if (!state.currentType) {
    choiceStatusSpan.textContent = 'Choose Rock/Paper/Scissors first';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  state.spawn = { x, y };
  choiceStatusSpan.textContent = `Chosen ${state.currentType} at (${x | 0}, ${y | 0})`;

  socket.emit('submitChoice', {
    roomId: state.roomId,
    type: state.currentType,
    x,
    y
  });
});

// --- Socket events ---
socket.on('roomJoined', data => {
  state.roomId = data.roomId;
  state.joinCode = data.joinCode;
  state.playerId = data.playerId;
  state.isHost = data.isHost;
  showLobby();
});

socket.on('roomUpdate', data => {
  updateLobby(data);
});

socket.on('roundSetup', data => {
  state.roomState = 'ROUND_SETUP';
  state.roundNumber = data.roundNumber;
  state.choiceDeadline = data.deadline;
  state.fieldWidth = data.fieldWidth;
  state.fieldHeight = data.fieldHeight;
  state.currentType = null;
  state.spawn = { x: null, y: null };
  roundResultDiv.classList.add('hidden');
  gameOverDiv.classList.add('hidden');
  gameRoundNumberSpan.textContent = state.roundNumber;
  currentTypeSpan.textContent = '';
  choiceStatusSpan.textContent = 'Choose type and spawn location';
  showGame();
});

socket.on('roundStarted', data => {
  state.roomState = 'ROUND_RUNNING';
  state.choiceDeadline = null;
  choiceStatusSpan.textContent = 'Round running!';
});

socket.on('stateUpdate', data => {
  state.players = data.players;
});

socket.on('roundEnded', data => {
  state.roomState = 'ROUND_END';
  roundResultDiv.classList.remove('hidden');
  roundResultDiv.textContent = `Round ${data.roundNumber} ended. Winning type: ${data.winningType}. Advancing players: ${data.winners.map(w => w.username).join(', ')}`;
});

socket.on('gameOver', data => {
  state.roomState = 'GAME_OVER';
  gameOverDiv.classList.remove('hidden');
  gameOverDiv.textContent = `Game Over! Winner: ${data.winner.username} (${data.winner.type})`;
});

socket.on('errorMessage', data => {
  errorDiv.textContent = data.message;
  showLogin();
});

// --- Rendering loop ---
function render() {
  requestAnimationFrame(render);

  updateCountdown();

  if (state.roomState === 'ROUND_SETUP' || state.roomState === 'ROUND_RUNNING' || state.roomState === 'ROUND_END' || state.roomState === 'GAME_OVER') {
    drawGame();
  }
}

function drawGame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw background grid
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#333';
  for (let x = 0; x < canvas.width; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Draw players as sprites
  state.players.forEach(p => {
    if (!p.type) return;

    const img = sprites[p.type];
    if (!img.complete) return; // not loaded yet

    const size = 48; // sprite size
    const half = size / 2;

    ctx.globalAlpha = p.alive ? 1.0 : 0.3;

    // Draw sprite centered on (x, y)
    ctx.drawImage(img, p.x - half, p.y - half, size, size);

    ctx.globalAlpha = 1.0;

    // Draw username above sprite
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.username, p.x, p.y - (half + 10));
  });
}

render();
showLogin();
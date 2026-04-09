const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// --- Game constants ---
const TICK_RATE = 20; // 20 updates per second
const DT = 1 / TICK_RATE;
const SPEED = 120; // units per second
const RADIUS = 16;
const FIELD_WIDTH = 800;
const FIELD_HEIGHT = 600;
const CHOICE_DURATION_MS = 15000; // 15 seconds

// --- Data structures ---
/**
 * Room state:
 * WAITING_FOR_PLAYERS, ROUND_SETUP, ROUND_RUNNING, ROUND_END, GAME_OVER
 */
const rooms = new Map(); // roomId -> room

function createRoom(hostSocketId, username) {
  const roomId = randomUUID();
  const joinCode = generateJoinCode();
  const hostPlayerId = hostSocketId;

  const hostPlayer = {
    id: hostPlayerId,
    socketId: hostSocketId,
    username,
    type: null,
    x: 0,
    y: 0,
    alive: true,
    roomId,
    isHost: true,
    lastChoiceRound: 0
  };

  const room = {
    id: roomId,
    joinCode,
    hostId: hostPlayerId,
    players: new Map([[hostPlayerId, hostPlayer]]),
    state: 'WAITING_FOR_PLAYERS',
    roundNumber: 0,
    choiceDeadline: null,
    gameLoopInterval: null
  };

  rooms.set(roomId, room);
  return { room, player: hostPlayer };
}

function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function findRoomByJoinCode(code) {
  for (const room of rooms.values()) {
    if (room.joinCode === code) return room;
  }
  return null;
}

function getPreyType(type) {
  if (type === 'ROCK') return 'SCISSORS';
  if (type === 'SCISSORS') return 'PAPER';
  if (type === 'PAPER') return 'ROCK';
  return null;
}

function getNearest(p, targets) {
  let best = null;
  let bestDist = Infinity;
  for (const t of targets) {
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      best = t;
    }
  }
  return best;
}

function countAliveByType(players) {
  const counts = { ROCK: 0, PAPER: 0, SCISSORS: 0 };
  for (const p of players) {
    if (!p.alive || !p.type) continue;
    counts[p.type]++;
  }
  return counts;
}

function randomSpawn() {
  return {
    x: Math.random() * (FIELD_WIDTH - 2 * RADIUS) + RADIUS,
    y: Math.random() * (FIELD_HEIGHT - 2 * RADIUS) + RADIUS
  };
}

function randomType() {
  const types = ['ROCK', 'PAPER', 'SCISSORS'];
  return types[Math.floor(Math.random() * types.length)];
}

// --- Game loop per room ---
function startGameLoop(room) {
  if (room.gameLoopInterval) return;
  room.gameLoopInterval = setInterval(() => {
    if (room.state !== 'ROUND_RUNNING') return;

    const players = Array.from(room.players.values()).filter(p => p.alive && p.type);

    // Movement
    for (const p of players) {
      const preyType = getPreyType(p.type);
      const targets = players.filter(
        q => q.alive && q.type === preyType && q.id !== p.id
      );
      if (targets.length === 0) continue;

      const target = getNearest(p, targets);
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const ux = dx / len;
        const uy = dy / len;
        p.x += ux * SPEED * DT;
        p.y += uy * SPEED * DT;

        // clamp to field
        p.x = Math.max(RADIUS, Math.min(FIELD_WIDTH - RADIUS, p.x));
        p.y = Math.max(RADIUS, Math.min(FIELD_HEIGHT - RADIUS, p.y));
      }
    }

    // Collisions
    handleCollisions(room);

    // Broadcast state
    broadcastStateUpdate(room);

    // Check round end
    const aliveByType = countAliveByType(room.players.values());
    const aliveTypes = Object.entries(aliveByType)
      .filter(([_, count]) => count > 0)
      .map(([type]) => type);

    if (aliveTypes.length === 1) {
      endRound(room, aliveTypes[0]);
    }
  }, 1000 / TICK_RATE);
}

function stopGameLoop(room) {
  if (room.gameLoopInterval) {
    clearInterval(room.gameLoopInterval);
    room.gameLoopInterval = null;
  }
}

function handleCollisions(room) {
  const players = Array.from(room.players.values()).filter(p => p.alive && p.type);
  const n = players.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = players[i];
      const q = players[j];
      if (!p.alive || !q.alive) continue;

      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= 2 * RADIUS) {
        // p defeats q
        if (getPreyType(p.type) === q.type) {
          q.alive = false;
        }
        // q defeats p
        else if (getPreyType(q.type) === p.type) {
          p.alive = false;
        }
        // same type → no elimination
      }
    }
  }
}

function broadcastRoomUpdate(room) {
  io.to(room.id).emit('roomUpdate', {
    roomId: room.id,
    joinCode: room.joinCode,
    state: room.state,
    roundNumber: room.roundNumber,
    hostId: room.hostId,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      username: p.username,
      isHost: p.isHost
    }))
  });
}

function broadcastStateUpdate(room) {
  io.to(room.id).emit('stateUpdate', {
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      username: p.username,
      type: p.type,
      x: p.x,
      y: p.y,
      alive: p.alive
    }))
  });
}

function startRoundSetup(room) {
  room.state = 'ROUND_SETUP';
  room.roundNumber += 1;
  room.choiceDeadline = Date.now() + CHOICE_DURATION_MS;

  // Reset players for this round (alive, clear type/position)
  for (const p of room.players.values()) {
    p.alive = true;
    p.type = null;
    p.x = 0;
    p.y = 0;
  }

  io.to(room.id).emit('roundSetup', {
    roundNumber: room.roundNumber,
    deadline: room.choiceDeadline,
    fieldWidth: FIELD_WIDTH,
    fieldHeight: FIELD_HEIGHT
  });

  broadcastRoomUpdate(room);

  // Poll for deadline
  const checkInterval = setInterval(() => {
    if (room.state !== 'ROUND_SETUP') {
      clearInterval(checkInterval);
      return;
    }
    if (Date.now() >= room.choiceDeadline) {
      clearInterval(checkInterval);
      finalizeChoicesAndStartRound(room);
    }
  }, 100);
}

function finalizeChoicesAndStartRound(room) {
  // Assign defaults for missing choices
  for (const p of room.players.values()) {
    if (!p.type) {
      p.type = randomType();
    }
    if (p.x === 0 && p.y === 0) {
      const { x, y } = randomSpawn();
      p.x = x;
      p.y = y;
    }
    p.alive = true;
  }

  room.state = 'ROUND_RUNNING';
  io.to(room.id).emit('roundStarted', {
    roundNumber: room.roundNumber
  });

  startGameLoop(room);
}

function endRound(room, winningType) {
  room.state = 'ROUND_END';
  stopGameLoop(room);

  // Determine all players who chose winningType this round
  const winners = Array.from(room.players.values()).filter(p => p.type === winningType);

  io.to(room.id).emit('roundEnded', {
    roundNumber: room.roundNumber,
    winningType,
    winners: winners.map(p => ({ id: p.id, username: p.username }))
  });

  // Game over condition: only one player chose winningType
  if (winners.length === 1) {
    room.state = 'GAME_OVER';
    const winner = winners[0];
    io.to(room.id).emit('gameOver', {
      winner: { id: winner.id, username: winner.username, type: winningType }
    });
    return;
  }

  // Otherwise, keep only winners in the room for next round
  const newPlayers = new Map();
  for (const p of winners) {
    newPlayers.set(p.id, p);
  }
  room.players = newPlayers;

  // Small delay, then next round setup
  setTimeout(() => {
    if (room.state === 'GAME_OVER') return;
    startRoundSetup(room);
  }, 3000);
}

// --- Socket.IO handlers ---
io.on('connection', socket => {
  console.log('Client connected', socket.id);

  socket.on('createRoom', ({ username }) => {
    const { room, player } = createRoom(socket.id, username);
    socket.join(room.id);
    socket.emit('roomJoined', {
      roomId: room.id,
      joinCode: room.joinCode,
      playerId: player.id,
      isHost: true
    });
    broadcastRoomUpdate(room);
  });

  socket.on('joinRoom', ({ username, joinCode }) => {
    const room = findRoomByJoinCode(joinCode);
    if (!room) {
      socket.emit('errorMessage', { message: 'Room not found' });
      return;
    }
    if (room.state === 'GAME_OVER') {
      socket.emit('errorMessage', { message: 'Game already finished' });
      return;
    }

    const playerId = socket.id;
    const player = {
      id: playerId,
      socketId: socket.id,
      username,
      type: null,
      x: 0,
      y: 0,
      alive: true,
      roomId: room.id,
      isHost: false,
      lastChoiceRound: 0
    };
    room.players.set(playerId, player);
    socket.join(room.id);

    socket.emit('roomJoined', {
      roomId: room.id,
      joinCode: room.joinCode,
      playerId: player.id,
      isHost: false
    });
    broadcastRoomUpdate(room);
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !player.isHost) return;
    if (room.state !== 'WAITING_FOR_PLAYERS') return;

    startRoundSetup(room);
  });

  socket.on('submitChoice', ({ roomId, type, x, y }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.state !== 'ROUND_SETUP') return;

    const player = room.players.get(socket.id);
    if (!player) return;

    // Only allow choices for current round
    player.type = type;
    player.x = x;
    player.y = y;
    player.lastChoiceRound = room.roundNumber;
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected', socket.id);
    // Remove player from any room
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        broadcastRoomUpdate(room);
        // If host left and room still has players, promote someone else
        if (room.hostId === socket.id) {
          const remaining = Array.from(room.players.values());
          if (remaining.length > 0) {
            room.hostId = remaining[0].id;
            remaining[0].isHost = true;
          } else {
            // No players left, clean up room
            stopGameLoop(room);
            rooms.delete(room.id);
          }
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
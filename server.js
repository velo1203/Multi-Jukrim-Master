const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const ARENA_W = 800, ARENA_H = 500;
const PLAYER_R = 18, SHURIKEN_R = 10;
const TICK_MS = 50; // 20fps server tick
const PLAYER_COLORS = ['#4fc3f7','#ef5350','#66bb6a','#ffa726','#ab47bc','#26c6da','#ffca28','#ec407a'];

const rooms = new Map();
let nextId = 0;

function getRoomList() {
  return [...rooms.values()]
    .filter(r => r.status === 'waiting')
    .map(r => {
      const host = [...r.players.values()][0];
      return {
        id: r.id,
        hostName: host?.nickname || '?',
        playerCount: r.players.size,
        maxPlayers: 8,
      };
    });
}

function broadcastRoomList() {
  io.emit('roomList', getRoomList());
}
function uid() { return nextId++; }
function randId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function getShurikenPos(s, now) {
  const dt = (now - s.spawnTime) / 1000;
  return { x: s.startX + s.vx * dt, y: s.startY + s.vy * dt };
}

function collides(ax, ay, bx, by, r) {
  return (ax - bx) ** 2 + (ay - by) ** 2 < r * r;
}

function serializeRoom(room) {
  return {
    id: room.id, host: room.host, status: room.status,
    players: [...room.players.values()].map(p => ({
      id: p.id, nickname: p.nickname, color: p.color,
      x: p.x, y: p.y, lives: p.lives, alive: p.alive, score: p.score
    }))
  };
}

function getStartPos(i, n) {
  if (n === 1) return { x: ARENA_W / 2, y: ARENA_H / 2 };
  const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
  const r = Math.min(ARENA_W, ARENA_H) * 0.28;
  return {
    x: Math.round(ARENA_W / 2 + Math.cos(angle) * r),
    y: Math.round(ARENA_H / 2 + Math.sin(angle) * r)
  };
}

function spawnShuriken(room) {
  const now = Date.now();
  const id = uid();
  const side = Math.floor(Math.random() * 4);
  const elapsed = (now - room.startTime) / 1000;
  const baseSpeed = 140 + Math.min(elapsed * 2.5, 180);
  const speed = baseSpeed + Math.random() * 60;

  let startX, startY;
  switch (side) {
    case 0: startX = Math.random() * ARENA_W; startY = -15; break;
    case 1: startX = ARENA_W + 15; startY = Math.random() * ARENA_H; break;
    case 2: startX = Math.random() * ARENA_W; startY = ARENA_H + 15; break;
    case 3: startX = -15; startY = Math.random() * ARENA_H; break;
  }

  const alive = [...room.players.values()].filter(p => p.alive);
  let tx = ARENA_W / 2, ty = ARENA_H / 2;
  if (alive.length > 0) {
    const target = alive[Math.floor(Math.random() * alive.length)];
    // Aimed at player with slight spread
    tx = target.x + (Math.random() - 0.5) * 100;
    ty = target.y + (Math.random() - 0.5) * 100;
  }

  const dx = tx - startX, dy = ty - startY;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const vx = (dx / dist) * speed;
  const vy = (dy / dist) * speed;

  const s = { id, startX, startY, vx, vy, spawnTime: now };
  room.shurikens.set(id, s);
  io.to(room.id).emit('shuriken', s);
}

function handleHit(room, player) {
  if (!player.alive) return;
  player.lives--;
  io.to(room.id).emit('playerHit', { playerId: player.id, lives: player.lives });
  if (player.lives <= 0) {
    player.alive = false;
    io.to(room.id).emit('playerEliminated', { playerId: player.id, nickname: player.nickname });
  }
}

function gameTick(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;

  const now = Date.now();
  const elapsed = (now - room.startTime) / 1000;
  room.tickCount++;

  // Score (surviving time)
  for (const p of room.players.values()) {
    if (p.alive) p.score = Math.floor(elapsed);
  }

  // Spawn shurikens: interval decreases with time
  const spawnEvery = Math.max(6, Math.round(38 - elapsed * 0.7));
  if (room.tickCount % spawnEvery === 0) {
    spawnShuriken(room);
    if (elapsed > 25 && room.tickCount % (spawnEvery * 2) === 0) spawnShuriken(room);
    if (elapsed > 55 && room.tickCount % (spawnEvery * 3) === 0) spawnShuriken(room);
  }

  // Move & collide shurikens
  const toRemove = new Set();
  for (const [sid, s] of room.shurikens) {
    const pos = getShurikenPos(s, now);
    if (pos.x < -80 || pos.x > ARENA_W + 80 || pos.y < -80 || pos.y > ARENA_H + 80) {
      toRemove.add(sid);
      continue;
    }
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      if (collides(pos.x, pos.y, p.x, p.y, PLAYER_R + SHURIKEN_R + 3)) {
        toRemove.add(sid);
        handleHit(room, p);
        break;
      }
    }
  }

  for (const sid of toRemove) room.shurikens.delete(sid);
  if (toRemove.size > 0) io.to(roomId).emit('shuriken_remove', [...toRemove]);

  // Check win condition
  const alive = [...room.players.values()].filter(p => p.alive);
  if (room.players.size > 1 && alive.length <= 1) {
    endGame(roomId, alive[0]);
    return;
  }
  if (room.players.size === 1 && alive.length === 0) {
    endGame(roomId, null);
    return;
  }

  // Broadcast positions of all players
  io.to(roomId).emit('positions', [...room.players.values()].map(p => ({
    id: p.id, x: p.x, y: p.y, alive: p.alive
  })));
}

function endGame(roomId, winner) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearInterval(room.ticker);
  room.status = 'ended';
  if (!winner) {
    winner = [...room.players.values()].sort((a, b) => b.score - a.score)[0];
  }
  console.log(`[게임 종료] 방 ${roomId} | 우승: ${winner?.nickname}`);
  io.to(roomId).emit('gameOver', { winner, state: serializeRoom(room) });
}

io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  socket.on('getRooms', () => {
    socket.emit('roomList', getRoomList());
  });

  socket.on('createRoom', ({ nickname }) => {
    nickname = nickname?.trim();
    if (!nickname) return socket.emit('err', '닉네임을 입력하세요.');
    let id;
    do { id = randId(); } while (rooms.has(id));

    const room = {
      id, host: socket.id, status: 'waiting',
      players: new Map([[socket.id, {
        id: socket.id, nickname, color: PLAYER_COLORS[0],
        x: ARENA_W / 2, y: ARENA_H / 2, lives: 3, alive: true, score: 0
      }]]),
      shurikens: new Map(), ticker: null, tickCount: 0, startTime: 0
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    socket.emit('roomCreated', { roomId: id, state: serializeRoom(room) });
    broadcastRoomList();
  });

  socket.on('joinRoom', ({ roomId, nickname }) => {
    nickname = nickname?.trim();
    roomId = roomId?.trim().toUpperCase();
    if (!nickname) return socket.emit('err', '닉네임을 입력하세요.');
    const room = rooms.get(roomId);
    if (!room) return socket.emit('err', '방을 찾을 수 없습니다.');
    if (room.status !== 'waiting') return socket.emit('err', '이미 게임이 시작된 방입니다.');
    if (room.players.size >= 8) return socket.emit('err', '방이 가득 찼습니다. (최대 8명)');

    const ci = room.players.size % PLAYER_COLORS.length;
    room.players.set(socket.id, {
      id: socket.id, nickname, color: PLAYER_COLORS[ci],
      x: ARENA_W / 2, y: ARENA_H / 2, lives: 3, alive: true, score: 0
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('joinedRoom', { state: serializeRoom(room) });
    socket.to(roomId).emit('playerJoined', { nickname, state: serializeRoom(room) });
    broadcastRoomList();
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.host !== socket.id || room.status !== 'waiting') return;

    let i = 0;
    const n = room.players.size;
    for (const p of room.players.values()) {
      const pos = getStartPos(i, n);
      p.x = pos.x; p.y = pos.y;
      p.lives = 3; p.alive = true; p.score = 0;
      p.color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      i++;
    }
    room.status = 'playing';
    room.shurikens = new Map();
    room.tickCount = 0;
    room.startTime = Date.now();

    io.to(room.id).emit('gameStarted', { state: serializeRoom(room) });
    room.ticker = setInterval(() => gameTick(room.id), TICK_MS);
    broadcastRoomList();
    console.log(`[게임 시작] 방 ${room.id} | ${n}명`);
  });

  socket.on('posUpdate', ({ x, y }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.x = Math.max(PLAYER_R, Math.min(ARENA_W - PLAYER_R, x ?? p.x));
    p.y = Math.max(PLAYER_R, Math.min(ARENA_H - PLAYER_R, y ?? p.y));
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'ended') return;
    // 방장만 실제 재시작, 아니면 무시
    if (room.host !== socket.id) {
      socket.emit('err', '방장만 게임을 다시 시작할 수 있습니다.');
      return;
    }
    clearInterval(room.ticker);
    room.status = 'waiting';
    io.to(room.id).emit('backToLobby', { state: serializeRoom(room) });
    broadcastRoomList();
  });

  socket.on('chat', ({ message }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const trimmed = message?.trim().substring(0, 120);
    if (!trimmed) return;
    io.to(room.id).emit('chatMsg', {
      nickname: player.nickname,
      color: player.color,
      message: trimmed,
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    room.players.delete(socket.id);
    if (room.players.size === 0) {
      clearInterval(room.ticker);
      rooms.delete(roomId);
      return;
    }
    if (room.host === socket.id) {
      room.host = room.players.keys().next().value;
      io.to(roomId).emit('hostChanged', { newHost: room.host });
    }
    io.to(roomId).emit('playerLeft', { nickname: p.nickname, state: serializeRoom(room) });
    broadcastRoomList();

    if (room.status === 'playing') {
      const alive = [...room.players.values()].filter(q => q.alive);
      if (room.players.size > 0 && alive.length <= 1) endGame(roomId, alive[0]);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`죽림고수 → http://localhost:${PORT}`));

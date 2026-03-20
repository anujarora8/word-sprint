import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import type { LetterState, ScoringMode, GuessResult, MatchOverResult } from "./src/lib/types";
import {
  initSchema,
  syncAnswers,
  syncValidWords,
  scheduleDailySync,
  isValidWord,
  pickWord,
  answersCount,
  clearAnswersMeta,
  saveRoom,
  loadActiveRooms,
  deleteRoom,
} from "./db";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

// --- Points mode constants ---
const POINTS_TO_WIN = 12;
const POINTS_TABLE: Record<number, number> = {
  1: 9,
  2: 6,
  3: 4,
  4: 3,
  5: 2,
  6: 1,
};
const MAX_NAME_LENGTH = 16;
const GUESS_RATE_LIMIT_MS = 500;
// Grace period before a disconnected player is removed (allows reconnect after server restart)
const DISCONNECT_GRACE_MS = 30_000;

function pointsForGuesses(guessCount: number, solved: boolean): number {
  return solved ? (POINTS_TABLE[guessCount] ?? 0) : 0;
}

// --- Game state types ---

interface PlayerState {
  id: string;       // persistent client-generated UUID
  name: string;
  currentWord: string;
  guesses: GuessResult[][];
  wordsCompleted: number;
  totalGuesses: number;
  finished: boolean;
  wordsFailed: number;
  score: number;
  tiebreakerScore: number;
  tiebreakerDone: boolean;
  waitingForOpponent: boolean;
  ready: boolean;
}

interface Room {
  id: string;
  players: Map<string, PlayerState>; // keyed by persistent playerId
  started: boolean;
  finished: boolean;
  counting: boolean;
  createdAt: number;
  totalRounds: number;
  scoringMode: ScoringMode;
  tiebreaker: boolean;
  wordSequence: string[];
  wordSet: Set<string>;
}

function evaluateGuess(guess: string, target: string): GuessResult[] {
  const result: GuessResult[] = Array.from({ length: 5 }, (_, i) => ({
    letter: guess[i],
    state: "absent" as LetterState,
  }));
  const targetLetters = target.split("");
  const used = Array(5).fill(false);
  for (let i = 0; i < 5; i++) {
    if (guess[i] === target[i]) { result[i].state = "correct"; used[i] = true; }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i].state === "correct") continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guess[i] === targetLetters[j]) {
        result[i].state = "present"; used[j] = true; break;
      }
    }
  }
  return result;
}

function generateWordSequence(n: number): { words: string[]; wordSet: Set<string> } {
  const wordSet = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    const word = pickWord(wordSet);
    wordSet.add(word);
    words.push(word);
  }
  return { words, wordSet };
}

// --- In-memory rooms (backed by SQLite) ---
const rooms = new Map<string, Room>();

// Pending disconnect timers: "roomId:playerId" → timer
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Serialise room → SQLite
function persistRoom(room: Room): void {
  const players = [...room.players.values()];
  saveRoom({
    id: room.id,
    started: room.started,
    finished: room.finished,
    counting: room.counting,
    createdAt: room.createdAt,
    totalRounds: room.totalRounds,
    scoringMode: room.scoringMode,
    tiebreaker: room.tiebreaker,
    wordSequence: room.wordSequence,
    players: players.map((p, i) => ({
      playerId: p.id,
      name: p.name,
      currentWord: p.currentWord,
      guesses: JSON.stringify(p.guesses),
      wordsCompleted: p.wordsCompleted,
      totalGuesses: p.totalGuesses,
      finished: p.finished,
      wordsFailed: p.wordsFailed,
      score: p.score,
      tiebreakerScore: p.tiebreakerScore,
      tiebreakerDone: p.tiebreakerDone,
      waitingForOpponent: p.waitingForOpponent,
      ready: p.ready,
      joinOrder: i,
    })),
  });
}

// Restore rooms from SQLite into the in-memory map on startup
function restoreRooms(): void {
  const stored = loadActiveRooms();
  for (const r of stored) {
    const wordSet = new Set(r.wordSequence);
    const players = new Map<string, PlayerState>();
    for (const p of r.players) {
      players.set(p.playerId, {
        id: p.playerId,
        name: p.name,
        currentWord: p.currentWord,
        guesses: JSON.parse(p.guesses) as GuessResult[][],
        wordsCompleted: p.wordsCompleted,
        totalGuesses: p.totalGuesses,
        finished: p.finished,
        wordsFailed: p.wordsFailed,
        score: p.score,
        tiebreakerScore: p.tiebreakerScore,
        tiebreakerDone: p.tiebreakerDone,
        waitingForOpponent: p.waitingForOpponent,
        ready: p.ready,
      });
    }
    rooms.set(r.id, {
      id: r.id,
      players,
      started: r.started,
      finished: r.finished,
      counting: false, // server can't resume countdown timers after restart
      createdAt: r.createdAt,
      totalRounds: r.totalRounds,
      scoringMode: r.scoringMode as ScoringMode,
      tiebreaker: r.tiebreaker,
      wordSequence: r.wordSequence,
      wordSet,
    });
  }
  if (stored.length > 0) console.log(`> Restored ${stored.length} active room(s) from DB`);
}

// Expire rooms older than 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 3_600_000) {
      rooms.delete(id);
      deleteRoom(id);
    }
  }
}, 300_000);

app.prepare().then(async () => {
  initSchema();
  restoreRooms();

  const forceReset = process.env.RESET_WORDS === "true";
  if (forceReset) clearAnswersMeta();

  const [answersResult, wordsResult] = await Promise.allSettled([
    syncAnswers(forceReset),
    syncValidWords(),
  ]);

  if (answersResult.status === "rejected") {
    console.error("> Answers sync failed at startup:", answersResult.reason);
    const count = answersCount();
    if (count === 0) throw new Error("No words in DB and sync failed — cannot start.");
    console.warn(`> Continuing with existing ${count} answers from DB`);
  }
  if (wordsResult.status === "rejected") {
    console.error("> Valid-words sync failed at startup:", wordsResult.reason);
    console.warn("> Continuing without updated valid-word list");
  }

  scheduleDailySync();
  console.log(`> answers table: ${answersCount()} rows`);

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin && !dev) throw new Error("CORS_ORIGIN must be set in production");

  const httpServer = createServer((req, res) => handle(req, res));
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin ?? "*" },
  });

  io.on("connection", (socket) => {
    let currentRoomId: string | null = null;
    let currentPlayerId: string | null = null;
    let lastGuessTime = 0;

    function validateName(raw: unknown): string | null {
      const trimmed = (typeof raw === "string" ? raw : "").trim();
      if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
      return trimmed;
    }

    function isHost(room: Room): boolean {
      return [...room.players.keys()][0] === currentPlayerId;
    }

    socket.on("create_room", ({ playerName, playerId }: { playerName: string; playerId: string }) => {
      const name = validateName(playerName);
      if (!name) { socket.emit("app_error", { message: "Name must be 1–16 characters." }); return; }

      const roomId = uuidv4().slice(0, 6).toUpperCase();
      const room: Room = {
        id: roomId,
        players: new Map(),
        started: false,
        finished: false,
        counting: false,
        createdAt: Date.now(),
        totalRounds: 3,
        scoringMode: "sprint",
        tiebreaker: false,
        wordSequence: [],
        wordSet: new Set(),
      };
      room.players.set(playerId, makePlayer(playerId, name));
      rooms.set(roomId, room);
      currentRoomId = roomId;
      currentPlayerId = playerId;
      socket.join(roomId);
      socket.emit("room_created", { roomId });
      persistRoom(room);
      io.to(roomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("join_room", ({ roomId, playerName, playerId }: { roomId: string; playerName: string; playerId: string }) => {
      const name = validateName(playerName);
      if (!name) { socket.emit("app_error", { message: "Name must be 1–16 characters." }); return; }

      const room = rooms.get(roomId.toUpperCase());
      if (!room) { socket.emit("app_error", { message: "Room not found." }); return; }
      if (room.started) { socket.emit("app_error", { message: "Game already started." }); return; }
      if (room.players.size >= 2 && !room.players.has(playerId)) {
        socket.emit("app_error", { message: "Room is full." }); return;
      }

      // Cancel any pending disconnect timer if the player is rejoining
      const timerKey = `${roomId.toUpperCase()}:${playerId}`;
      const pending = disconnectTimers.get(timerKey);
      if (pending) { clearTimeout(pending); disconnectTimers.delete(timerKey); }

      room.players.set(playerId, makePlayer(playerId, name));
      currentRoomId = roomId.toUpperCase();
      currentPlayerId = playerId;
      socket.join(currentRoomId);
      socket.emit("room_joined", { roomId: currentRoomId });
      persistRoom(room);
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("request_room_state", ({ roomId, playerId }: { roomId: string; playerId?: string }) => {
      const upperRoomId = roomId.toUpperCase();
      const room = rooms.get(upperRoomId);
      if (!room) return;

      // Reconnect: cancel pending disconnect timer and re-associate this socket
      if (playerId && room.players.has(playerId)) {
        const timerKey = `${upperRoomId}:${playerId}`;
        const pending = disconnectTimers.get(timerKey);
        if (pending) { clearTimeout(pending); disconnectTimers.delete(timerKey); }

        currentRoomId = upperRoomId;
        currentPlayerId = playerId;
        socket.join(upperRoomId);
      }

      socket.emit("room_update", roomSnapshot(room));
    });

    socket.on("set_rounds", ({ totalRounds }: { totalRounds: number }) => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started || !isHost(room)) return;
      room.totalRounds = Math.min(Math.max(1, totalRounds), 5);
      for (const p of room.players.values()) p.ready = false;
      persistRoom(room);
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("set_scoring_mode", ({ scoringMode }: { scoringMode: ScoringMode }) => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started || !isHost(room)) return;
      if (scoringMode !== "sprint" && scoringMode !== "points") return;
      room.scoringMode = scoringMode;
      for (const p of room.players.values()) p.ready = false;
      persistRoom(room);
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("player_ready", () => {
      if (!currentRoomId || !currentPlayerId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started || room.counting) return;
      const player = room.players.get(currentPlayerId);
      if (!player) return;

      player.ready = !player.ready;
      persistRoom(room);
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));

      const allPlayers = [...room.players.values()];
      if (allPlayers.length === 2 && allPlayers.every((p) => p.ready)) {
        startCountdown(room, currentRoomId, io);
      }
    });

    socket.on("start_game", () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started || room.players.size < 2 || !isHost(room)) return;
      room.started = true;
      room.tiebreaker = false;
      const sequenceLen = room.scoringMode === "points" ? 20 : room.totalRounds;
      const { words, wordSet } = generateWordSequence(sequenceLen);
      room.wordSequence = words;
      room.wordSet = wordSet;
      console.log(`> Room ${room.id} word sequence: ${room.wordSequence.join(", ")}`);
      for (const player of room.players.values()) {
        resetPlayer(player, room.wordSequence[0]);
      }
      persistRoom(room);
      io.to(currentRoomId).emit("match_started");
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("submit_guess", ({ guess }: { guess: string }) => {
      const now = Date.now();
      if (now - lastGuessTime < GUESS_RATE_LIMIT_MS) return;
      lastGuessTime = now;

      if (!currentRoomId || !currentPlayerId) return;
      const room = rooms.get(currentRoomId);
      if (!room || !room.started || room.finished) return;
      const player = room.players.get(currentPlayerId);
      if (!player || player.finished) return;
      if (player.guesses.length >= 6) return;
      if (guess.length !== 5) { socket.emit("app_error", { message: "Guess must be 5 letters." }); return; }
      if (!isValidWord(guess)) { socket.emit("app_error", { message: "Not in word list." }); return; }

      const result = evaluateGuess(guess.toLowerCase(), player.currentWord);
      player.guesses.push(result);

      const solved = guess.toLowerCase() === player.currentWord;
      const failed = !solved && player.guesses.length >= 6;

      if (!solved && !failed) {
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));
        return;
      }

      // --- Word completed ---
      const wordUsed = player.currentWord;
      const guessCount = player.guesses.length;
      player.wordsCompleted += 1;
      player.totalGuesses += guessCount;
      if (failed) player.wordsFailed += 1;

      // --- Tiebreaker round ---
      if (room.tiebreaker) {
        const tbPts = pointsForGuesses(guessCount, solved);
        player.tiebreakerScore = tbPts;
        player.tiebreakerDone = true;
        socket.emit("word_result", { word: wordUsed, solved, pointsEarned: tbPts, newTotal: player.score + tbPts, tiebreaker: true });
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));

        const allPlayers = [...room.players.values()];
        if (allPlayers.every((p) => p.tiebreakerDone)) {
          room.finished = true;
          const [a, b] = allPlayers;
          let winnerId: string | null = null;
          if (a && b) {
            if (a.tiebreakerScore > b.tiebreakerScore) winnerId = a.id;
            else if (b.tiebreakerScore > a.tiebreakerScore) winnerId = b.id;
          } else if (a) { winnerId = a.id; }
          persistRoom(room);
          io.to(currentRoomId).emit("match_over", {
            scoringMode: "points", tiebreaker: true, winnerId,
            results: allPlayers.map((p) => ({
              id: p.id, name: p.name,
              wordsCompleted: p.wordsCompleted, wordsFailed: p.wordsFailed,
              totalGuesses: p.totalGuesses, finished: p.finished,
              score: p.score, tiebreakerScore: p.tiebreakerScore,
            })) satisfies MatchOverResult[],
          });
        }
        return;
      }

      // --- Sprint mode ---
      if (room.scoringMode === "sprint") {
        const isLastWord = player.wordsCompleted >= room.totalRounds;
        if (isLastWord) player.finished = true;

        socket.emit("word_result", { word: wordUsed, solved, pointsEarned: 0, newTotal: 0, tiebreaker: false });

        if (!isLastWord) {
          player.currentWord = room.wordSequence[player.wordsCompleted];
          player.guesses = [];
          console.log(`> [${player.name}] next word (sprint #${player.wordsCompleted}): ${player.currentWord}`);
        }

        if (isLastWord) {
          room.finished = true;
          const allPlayers = [...room.players.values()];
          const winner = allPlayers.find((p) => p.finished);
          persistRoom(room);
          io.to(currentRoomId).emit("room_update", roomSnapshot(room));
          io.to(currentRoomId).emit("match_over", {
            scoringMode: "sprint", tiebreaker: false, winnerId: winner?.id ?? null,
            results: allPlayers.map((p) => ({
              id: p.id, name: p.name,
              wordsCompleted: p.wordsCompleted, wordsFailed: p.wordsFailed,
              totalGuesses: p.totalGuesses, finished: p.finished,
              score: 0, tiebreakerScore: 0,
            })) satisfies MatchOverResult[],
          });
        } else {
          persistRoom(room);
          io.to(currentRoomId).emit("room_update", roomSnapshot(room));
        }
        return;
      }

      // --- Points mode ---
      const pointsEarned = pointsForGuesses(guessCount, solved);
      player.score += pointsEarned;

      const allPlayers = [...room.players.values()];
      const other = allPlayers.find((p) => p.id !== player.id);
      const hitTarget = player.score >= POINTS_TO_WIN;

      socket.emit("word_result", {
        word: wordUsed, solved, pointsEarned,
        newTotal: player.score,
        pointsToWin: Math.max(0, POINTS_TO_WIN - player.score),
        tiebreaker: false,
      });

      if (hitTarget) {
        player.finished = true;
        player.waitingForOpponent = false;
        if (other && !other.finished) {
          // player hit 12 first — give opponent one grace word
          other.waitingForOpponent = true;
          persistRoom(room);
          io.to(currentRoomId).emit("room_update", roomSnapshot(room));
        } else {
          // other was already finished → other hit 12 first
          resolvePointsGame(room, allPlayers, currentRoomId, io, other?.id ?? player.id);
        }
      } else if (other?.waitingForOpponent) {
        // other hit 12 first; this player just finished their grace word
        other.waitingForOpponent = false;
        persistRoom(room);
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));
        resolvePointsGame(room, allPlayers, currentRoomId, io, other.id);
      } else {
        while (room.wordSequence.length <= player.wordsCompleted) {
          const extra = pickWord(room.wordSet);
          room.wordSequence.push(extra);
          room.wordSet.add(extra);
          console.log(`> Room ${room.id} extended sequence with: ${extra}`);
        }
        player.currentWord = room.wordSequence[player.wordsCompleted];
        player.guesses = [];
        console.log(`> [${player.name}] next word (points #${player.wordsCompleted}): ${player.currentWord}`);
        persistRoom(room);
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));
      }
    });

    socket.on("restart_game", () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || !isHost(room)) return;
      room.started = false;
      room.finished = false;
      room.counting = false;
      room.tiebreaker = false;
      room.wordSequence = [];
      room.wordSet = new Set();
      for (const player of room.players.values()) {
        resetPlayerToLobby(player);
      }
      persistRoom(room);
      io.to(currentRoomId).emit("game_restarted");
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("disconnect", () => {
      if (!currentRoomId || !currentPlayerId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;

      const roomId = currentRoomId;
      const playerId = currentPlayerId;
      const timerKey = `${roomId}:${playerId}`;

      // Grace period: give the player DISCONNECT_GRACE_MS to reconnect
      // before actually removing them (handles server restarts cleanly)
      const timer = setTimeout(() => {
        disconnectTimers.delete(timerKey);
        const r = rooms.get(roomId);
        if (!r) return;
        r.players.delete(playerId);
        if (r.players.size === 0) {
          rooms.delete(roomId);
          deleteRoom(roomId);
        } else {
          if (r.started && !r.finished) {
            r.finished = true;
            io.to(roomId).emit("opponent_disconnected");
          }
          persistRoom(r);
          io.to(roomId).emit("room_update", roomSnapshot(r));
        }
      }, DISCONNECT_GRACE_MS);

      disconnectTimers.set(timerKey, timer);
    });
  });

  httpServer.listen(port, () => console.log(`> Ready on http://localhost:${port}`));
});

function startCountdown(room: Room, roomId: string, io: Server): void {
  room.counting = true;
  persistRoom(room);
  io.to(roomId).emit("room_update", roomSnapshot(room));

  let count = 3;
  io.to(roomId).emit("countdown", { value: count });

  const interval = setInterval(() => {
    count--;
    if (count > 0) {
      io.to(roomId).emit("countdown", { value: count });
    } else {
      clearInterval(interval);
      room.counting = false;
      room.started = true;
      room.tiebreaker = false;
      const sequenceLen = room.scoringMode === "points" ? 20 : room.totalRounds;
      const { words, wordSet } = generateWordSequence(sequenceLen);
      room.wordSequence = words;
      room.wordSet = wordSet;
      console.log(`> Room ${room.id} word sequence: ${room.wordSequence.join(", ")}`);
      for (const player of room.players.values()) {
        resetPlayer(player, room.wordSequence[0]);
      }
      persistRoom(room);
      io.to(roomId).emit("match_started");
      io.to(roomId).emit("room_update", roomSnapshot(room));
    }
  }, 1000);
}

function resolvePointsGame(
  room: Room,
  allPlayers: PlayerState[],
  roomId: string,
  io: Server,
  firstFinisherId?: string,
) {
  const [a, b] = allPlayers;

  // Tiebreaker: both hit 12 and ended on identical scores
  if (a && b && a.finished && b.finished && a.score === b.score) {
    room.tiebreaker = true;
    const tbWord = pickWord(room.wordSet);
    room.wordSequence.push(tbWord);
    room.wordSet.add(tbWord);
    console.log(`> Room ${room.id} tiebreaker word: ${tbWord}`);
    for (const p of allPlayers) {
      p.finished = false;
      p.tiebreakerScore = 0;
      p.tiebreakerDone = false;
      p.currentWord = tbWord;
      p.guesses = [];
    }
    persistRoom(room);
    io.to(roomId).emit("tiebreaker_started");
    io.to(roomId).emit("room_update", roomSnapshot(room));
    return;
  }

  // First to 12 wins — score during the grace word is irrelevant
  room.finished = true;
  const winnerId = firstFinisherId ?? allPlayers.find((p) => p.finished)?.id ?? null;

  persistRoom(room);
  io.to(roomId).emit("match_over", {
    scoringMode: "points", tiebreaker: false, winnerId,
    results: allPlayers.map((p) => ({
      id: p.id, name: p.name,
      wordsCompleted: p.wordsCompleted, wordsFailed: p.wordsFailed,
      totalGuesses: p.totalGuesses, finished: p.finished,
      score: p.score, tiebreakerScore: 0,
    })) satisfies MatchOverResult[],
  });
}

function makePlayer(id: string, name: string): PlayerState {
  return {
    id, name, currentWord: "", guesses: [],
    wordsCompleted: 0, totalGuesses: 0, finished: false,
    wordsFailed: 0, score: 0,
    tiebreakerScore: 0, tiebreakerDone: false,
    waitingForOpponent: false, ready: false,
  };
}

function resetPlayerToLobby(player: PlayerState): void {
  player.currentWord = "";
  player.guesses = [];
  player.wordsCompleted = 0;
  player.totalGuesses = 0;
  player.finished = false;
  player.wordsFailed = 0;
  player.score = 0;
  player.tiebreakerScore = 0;
  player.tiebreakerDone = false;
  player.waitingForOpponent = false;
  player.ready = false;
}

function resetPlayer(player: PlayerState, firstWord: string) {
  resetPlayerToLobby(player);
  player.currentWord = firstWord;
  console.log(`> [${player.name}] start word: ${player.currentWord}`);
}

function roomSnapshot(room: Room) {
  return {
    id: room.id,
    started: room.started,
    finished: room.finished,
    counting: room.counting,
    totalRounds: room.totalRounds,
    scoringMode: room.scoringMode,
    tiebreaker: room.tiebreaker,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, guesses: p.guesses,
      wordsCompleted: p.wordsCompleted, totalGuesses: p.totalGuesses,
      finished: p.finished, wordsFailed: p.wordsFailed,
      score: p.score, tiebreakerScore: p.tiebreakerScore, tiebreakerDone: p.tiebreakerDone,
      waitingForOpponent: p.waitingForOpponent, ready: p.ready,
    })),
  };
}

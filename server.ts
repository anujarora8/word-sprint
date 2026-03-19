import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import {
  initSchema,
  syncAnswers,
  syncValidWords,
  scheduleDailySync,
  isValidWord,
  pickWord,
  answersCount,
  clearAnswersMeta,
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

function pointsForGuesses(guessCount: number, solved: boolean): number {
  return solved ? (POINTS_TABLE[guessCount] ?? 0) : 0;
}

// --- Game state types ---
type LetterState = "correct" | "present" | "absent";
type ScoringMode = "sprint" | "points";

interface GuessResult {
  letter: string;
  state: LetterState;
}

interface PlayerState {
  id: string;
  name: string;
  currentWord: string;
  guesses: GuessResult[][];
  wordsCompleted: number;
  totalGuesses: number;
  finished: boolean;      // reached target (sprint: all rounds done, points: hit 12)
  wordsFailed: number;
  score: number;
  // Tiebreaker
  tiebreakerScore: number;
  tiebreakerDone: boolean;
  // Points mode: waiting for opponent to finish their current word before game ends
  waitingForOpponent: boolean;
}

interface Room {
  id: string;
  players: Map<string, PlayerState>;
  started: boolean;
  finished: boolean;
  createdAt: number;
  totalRounds: number;   // sprint only
  scoringMode: ScoringMode;
  tiebreaker: boolean;
  wordSequence: string[]; // shared across both players
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

// Generate n distinct words for the shared room sequence
function generateWordSequence(n: number): string[] {
  const used = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    const word = pickWord(used);
    used.add(word);
    words.push(word);
  }
  return words;
}

// --- Server ---
const rooms = new Map<string, Room>();

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 3_600_000) rooms.delete(id);
  }
}, 300_000);

app.prepare().then(async () => {
  initSchema();

  const forceReset = process.env.RESET_WORDS === "true";
  if (forceReset) clearAnswersMeta();

  await Promise.all([syncAnswers(forceReset), syncValidWords()]);
  scheduleDailySync();

  const count = answersCount();
  console.log(`> answers table: ${count} rows`);

  const httpServer = createServer((req, res) => handle(req, res));
  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? "*" },
  });

  io.on("connection", (socket) => {
    let currentRoomId: string | null = null;

    socket.on("create_room", ({ playerName }: { playerName: string }) => {
      const roomId = uuidv4().slice(0, 6).toUpperCase();
      const room: Room = {
        id: roomId,
        players: new Map(),
        started: false,
        finished: false,
        createdAt: Date.now(),
        totalRounds: 3,
        scoringMode: "sprint",
        tiebreaker: false,
        wordSequence: [],
      };
      room.players.set(socket.id, makePlayer(socket.id, playerName));
      rooms.set(roomId, room);
      currentRoomId = roomId;
      socket.join(roomId);
      socket.emit("room_created", { roomId });
      io.to(roomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("join_room", ({ roomId, playerName }: { roomId: string; playerName: string }) => {
      const room = rooms.get(roomId.toUpperCase());
      if (!room) { socket.emit("error", { message: "Room not found." }); return; }
      if (room.started) { socket.emit("error", { message: "Game already started." }); return; }
      if (room.players.size >= 2) { socket.emit("error", { message: "Room is full." }); return; }
      room.players.set(socket.id, makePlayer(socket.id, playerName));
      currentRoomId = roomId.toUpperCase();
      socket.join(currentRoomId);
      socket.emit("room_joined", { roomId: currentRoomId });
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("set_rounds", ({ totalRounds }: { totalRounds: number }) => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started) return;
      if ([...room.players.keys()][0] !== socket.id) return;
      room.totalRounds = Math.min(Math.max(1, totalRounds), 5);
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("set_scoring_mode", ({ scoringMode }: { scoringMode: ScoringMode }) => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started) return;
      if ([...room.players.keys()][0] !== socket.id) return;
      if (scoringMode !== "sprint" && scoringMode !== "points") return;
      room.scoringMode = scoringMode;
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("request_room_state", ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId.toUpperCase());
      if (room) socket.emit("room_update", roomSnapshot(room));
    });

    socket.on("start_game", () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || room.started || room.players.size < 2) return;
      room.started = true;
      room.tiebreaker = false;
      // Points mode: pre-generate a large pool (players may need many words racing to 12)
      const sequenceLen = room.scoringMode === "points" ? 20 : room.totalRounds;
      room.wordSequence = generateWordSequence(sequenceLen);
      console.log(`> Room ${room.id} word sequence: ${room.wordSequence.join(", ")}`);
      for (const player of room.players.values()) {
        resetPlayer(player, room.wordSequence[0]);
      }
      io.to(currentRoomId).emit("match_started");
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("submit_guess", ({ guess }: { guess: string }) => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room || !room.started || room.finished) return;
      const player = room.players.get(socket.id);
      if (!player || player.finished) return;
      if (player.guesses.length >= 6) return;
      if (guess.length !== 5) { socket.emit("error", { message: "Guess must be 5 letters." }); return; }
      if (!isValidWord(guess)) { socket.emit("error", { message: "Not in word list." }); return; }

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
          io.to(currentRoomId).emit("match_over", {
            scoringMode: "points",
            tiebreaker: true,
            results: allPlayers.map((p) => ({
              id: p.id, name: p.name,
              wordsCompleted: p.wordsCompleted, wordsFailed: p.wordsFailed,
              totalGuesses: p.totalGuesses, finished: p.finished,
              score: p.score, tiebreakerScore: p.tiebreakerScore,
            })),
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

        io.to(currentRoomId).emit("room_update", roomSnapshot(room));

        if (isLastWord) {
          room.finished = true;
          const allPlayers = [...room.players.values()];
          io.to(currentRoomId).emit("match_over", {
            scoringMode: "sprint",
            tiebreaker: false,
            results: allPlayers.map((p) => ({
              id: p.id, name: p.name,
              wordsCompleted: p.wordsCompleted, wordsFailed: p.wordsFailed,
              totalGuesses: p.totalGuesses, finished: p.finished,
              score: 0, tiebreakerScore: 0,
            })),
          });
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
        // Mark this player done. Don't end the game yet — give the opponent a
        // chance to finish their current word so neither player is cut off mid-guess.
        player.finished = true;
        player.waitingForOpponent = false;

        if (other && !other.finished) {
          // Opponent is still playing — let them complete their current word.
          // Signal them so the UI can show "opponent reached 12!" if desired.
          other.waitingForOpponent = true;
          io.to(currentRoomId).emit("room_update", roomSnapshot(room));
          // Game will resolve when the opponent finishes their current word (below).
        } else {
          // Opponent already finished (or doesn't exist) — resolve now.
          resolvePointsGame(room, allPlayers, currentRoomId, io);
        }
      } else if (other?.waitingForOpponent) {
        // This player just finished their word and the opponent was waiting.
        // Now both have completed their current word — resolve.
        other.waitingForOpponent = false;
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));
        resolvePointsGame(room, allPlayers, currentRoomId, io);
      } else {
        // Haven't hit 12 yet — next word
        // Extend sequence if somehow exhausted (safety net)
        while (room.wordSequence.length <= player.wordsCompleted) {
          const extra = pickWord(new Set(room.wordSequence));
          room.wordSequence.push(extra);
          console.log(`> Room ${room.id} extended sequence with: ${extra}`);
        }
        player.currentWord = room.wordSequence[player.wordsCompleted];
        player.guesses = [];
        console.log(`> [${player.name}] next word (points #${player.wordsCompleted}): ${player.currentWord}`);
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));
      }
    });

    socket.on("restart_game", () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;
      // Only host can restart
      if ([...room.players.keys()][0] !== socket.id) return;
      room.started = false;
      room.finished = false;
      room.tiebreaker = false;
      room.wordSequence = [];
      for (const player of room.players.values()) {
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
      }
      io.to(currentRoomId).emit("game_restarted");
      io.to(currentRoomId).emit("room_update", roomSnapshot(room));
    });

    socket.on("disconnect", () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;
      room.players.delete(socket.id);
      if (room.players.size === 0) {
        rooms.delete(currentRoomId);
      } else {
        io.to(currentRoomId).emit("room_update", roomSnapshot(room));
        if (room.started && !room.finished) io.to(currentRoomId).emit("opponent_disconnected");
      }
    });
  });

  httpServer.listen(port, () => console.log(`> Ready on http://localhost:${port}`));
});

function resolvePointsGame(
  room: Room,
  allPlayers: PlayerState[],
  roomId: string,
  io: Server
) {
  const [a, b] = allPlayers;

  // Both hit 12 with equal scores → tiebreaker
  if (a && b && a.finished && b.finished && a.score === b.score) {
    room.tiebreaker = true;
    const tbWord = pickWord(new Set(room.wordSequence));
    room.wordSequence.push(tbWord);
    console.log(`> Room ${room.id} tiebreaker word: ${tbWord}`);
    for (const p of allPlayers) {
      p.finished = false;
      p.tiebreakerScore = 0;
      p.tiebreakerDone = false;
      p.currentWord = tbWord;
      p.guesses = [];
    }
    io.to(roomId).emit("tiebreaker_started");
    io.to(roomId).emit("room_update", roomSnapshot(room));
    return;
  }

  // Otherwise: highest score wins (one or both may have hit 12)
  room.finished = true;
  io.to(roomId).emit("match_over", {
    scoringMode: "points",
    tiebreaker: false,
    results: allPlayers.map((p) => ({
      id: p.id, name: p.name,
      wordsCompleted: p.wordsCompleted, wordsFailed: p.wordsFailed,
      totalGuesses: p.totalGuesses, finished: p.finished,
      score: p.score, tiebreakerScore: 0,
    })),
  });
}

function makePlayer(id: string, name: string): PlayerState {
  return {
    id, name, currentWord: "", guesses: [],
    wordsCompleted: 0, totalGuesses: 0, finished: false,
    wordsFailed: 0, score: 0,
    tiebreakerScore: 0, tiebreakerDone: false,
    waitingForOpponent: false,
  };
}

function resetPlayer(player: PlayerState, firstWord: string) {
  player.currentWord = firstWord;
  player.guesses = [];
  player.wordsCompleted = 0;
  player.totalGuesses = 0;
  player.finished = false;
  player.wordsFailed = 0;
  player.score = 0;
  player.tiebreakerScore = 0;
  player.tiebreakerDone = false;
  player.waitingForOpponent = false;
  console.log(`> [${player.name}] start word: ${player.currentWord}`);
}

function roomSnapshot(room: Room) {
  return {
    id: room.id,
    started: room.started,
    finished: room.finished,
    totalRounds: room.totalRounds,
    scoringMode: room.scoringMode,
    tiebreaker: room.tiebreaker,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, guesses: p.guesses,
      wordsCompleted: p.wordsCompleted, totalGuesses: p.totalGuesses,
      finished: p.finished, wordsFailed: p.wordsFailed,
      score: p.score, tiebreakerScore: p.tiebreakerScore, tiebreakerDone: p.tiebreakerDone,
    })),
  };
}

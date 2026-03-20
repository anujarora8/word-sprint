import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "words.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initSchema(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS answers (
      word TEXT PRIMARY KEY,
      date TEXT,
      game INTEGER
    );
    CREATE TABLE IF NOT EXISTS valid_words (
      word TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS meta (
      key  TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id           TEXT PRIMARY KEY,
      started      INTEGER NOT NULL DEFAULT 0,
      finished     INTEGER NOT NULL DEFAULT 0,
      counting     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      total_rounds INTEGER NOT NULL DEFAULT 3,
      scoring_mode TEXT    NOT NULL DEFAULT 'sprint',
      tiebreaker   INTEGER NOT NULL DEFAULT 0,
      word_sequence TEXT   NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS room_players (
      player_id          TEXT    NOT NULL,
      room_id            TEXT    NOT NULL,
      name               TEXT    NOT NULL,
      current_word       TEXT    NOT NULL DEFAULT '',
      guesses            TEXT    NOT NULL DEFAULT '[]',
      words_completed    INTEGER NOT NULL DEFAULT 0,
      total_guesses      INTEGER NOT NULL DEFAULT 0,
      finished           INTEGER NOT NULL DEFAULT 0,
      words_failed       INTEGER NOT NULL DEFAULT 0,
      score              INTEGER NOT NULL DEFAULT 0,
      tiebreaker_score   INTEGER NOT NULL DEFAULT 0,
      tiebreaker_done    INTEGER NOT NULL DEFAULT 0,
      waiting_for_opponent INTEGER NOT NULL DEFAULT 0,
      ready              INTEGER NOT NULL DEFAULT 0,
      join_order         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player_id, room_id)
    );
  `);

  // Migrate existing tables (safe to run repeatedly — ALTER TABLE fails silently if column exists)
  for (const sql of [
    "ALTER TABLE rooms ADD COLUMN counting INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE room_players ADD COLUMN ready INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db().exec(sql); } catch { /* column already exists */ }
  }
}

// ---------------------------------------------------------------------------
// Room persistence
// ---------------------------------------------------------------------------

export interface StoredPlayer {
  playerId: string;
  name: string;
  currentWord: string;
  guesses: string; // JSON string of GuessResult[][]
  wordsCompleted: number;
  totalGuesses: number;
  finished: boolean;
  wordsFailed: number;
  score: number;
  tiebreakerScore: number;
  tiebreakerDone: boolean;
  waitingForOpponent: boolean;
  ready: boolean;
  joinOrder: number;
}

export interface StoredRoom {
  id: string;
  started: boolean;
  finished: boolean;
  counting: boolean;
  createdAt: number;
  totalRounds: number;
  scoringMode: string;
  tiebreaker: boolean;
  wordSequence: string[];
  players: StoredPlayer[];
}

export function saveRoom(room: StoredRoom): void {
  const d = db();
  d.transaction(() => {
    d.prepare(`
      INSERT OR REPLACE INTO rooms
        (id, started, finished, counting, created_at, total_rounds, scoring_mode, tiebreaker, word_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      room.id,
      room.started ? 1 : 0,
      room.finished ? 1 : 0,
      room.counting ? 1 : 0,
      room.createdAt,
      room.totalRounds,
      room.scoringMode,
      room.tiebreaker ? 1 : 0,
      JSON.stringify(room.wordSequence),
    );
    for (const p of room.players) {
      d.prepare(`
        INSERT OR REPLACE INTO room_players
          (player_id, room_id, name, current_word, guesses, words_completed,
           total_guesses, finished, words_failed, score,
           tiebreaker_score, tiebreaker_done, waiting_for_opponent, ready, join_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        p.playerId, room.id, p.name, p.currentWord, p.guesses,
        p.wordsCompleted, p.totalGuesses, p.finished ? 1 : 0, p.wordsFailed,
        p.score, p.tiebreakerScore, p.tiebreakerDone ? 1 : 0,
        p.waitingForOpponent ? 1 : 0, p.ready ? 1 : 0, p.joinOrder,
      );
    }
  })();
}

export function loadActiveRooms(): StoredRoom[] {
  const d = db();
  const cutoff = Date.now() - 3_600_000; // ignore rooms older than 1 hour
  const rows = d.prepare(
    "SELECT * FROM rooms WHERE finished = 0 AND created_at > ?"
  ).all(cutoff) as {
    id: string; started: number; finished: number; counting: number; created_at: number;
    total_rounds: number; scoring_mode: string; tiebreaker: number; word_sequence: string;
  }[];

  return rows.map((r) => {
    const players = d.prepare(
      "SELECT * FROM room_players WHERE room_id = ? ORDER BY join_order ASC"
    ).all(r.id) as {
      player_id: string; name: string; current_word: string; guesses: string;
      words_completed: number; total_guesses: number; finished: number;
      words_failed: number; score: number; tiebreaker_score: number;
      tiebreaker_done: number; waiting_for_opponent: number; ready: number; join_order: number;
    }[];

    return {
      id: r.id,
      started: r.started === 1,
      finished: r.finished === 1,
      counting: r.counting === 1,
      createdAt: r.created_at,
      totalRounds: r.total_rounds,
      scoringMode: r.scoring_mode,
      tiebreaker: r.tiebreaker === 1,
      wordSequence: JSON.parse(r.word_sequence) as string[],
      players: players.map((p) => ({
        playerId: p.player_id,
        name: p.name,
        currentWord: p.current_word,
        guesses: p.guesses,
        wordsCompleted: p.words_completed,
        totalGuesses: p.total_guesses,
        finished: p.finished === 1,
        wordsFailed: p.words_failed,
        score: p.score,
        tiebreakerScore: p.tiebreaker_score,
        tiebreakerDone: p.tiebreaker_done === 1,
        waitingForOpponent: p.waiting_for_opponent === 1,
        ready: p.ready === 1,
        joinOrder: p.join_order,
      })),
    };
  });
}

export function deleteRoom(roomId: string): void {
  const d = db();
  d.transaction(() => {
    d.prepare("DELETE FROM room_players WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  })();
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

function getMeta(key: string): string | null {
  stmts.getMeta ??= db().prepare("SELECT value FROM meta WHERE key = ?");
  const row = stmts.getMeta.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  stmts.setMeta ??= db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  stmts.setMeta.run(key, value);
}

// ---------------------------------------------------------------------------
// Cached prepared statements — prepared once, reused on every call
// ---------------------------------------------------------------------------

const stmts: {
  isValidWordValid?: Database.Statement;
  isValidWordAnswer?: Database.Statement;
  randomAnswer?: Database.Statement;
  getMeta?: Database.Statement;
  setMeta?: Database.Statement;
} = {};

// ---------------------------------------------------------------------------
// Word queries (synchronous — no API calls during gameplay)
// ---------------------------------------------------------------------------

export function isValidWord(word: string): boolean {
  const w = word.toLowerCase();
  stmts.isValidWordValid ??= db().prepare("SELECT 1 FROM valid_words WHERE word = ?");
  stmts.isValidWordAnswer ??= db().prepare("SELECT 1 FROM answers WHERE word = ?");
  return !!stmts.isValidWordValid.get(w) || !!stmts.isValidWordAnswer.get(w);
}

export function pickWord(exclude: Set<string> = new Set()): string {
  if (exclude.size === 0) {
    stmts.randomAnswer ??= db().prepare("SELECT word FROM answers ORDER BY RANDOM() LIMIT 1");
    const row = stmts.randomAnswer.get() as { word: string } | undefined;
    return row?.word ?? "crane";
  }

  // Exclusion list varies in size — cannot cache this statement, but the no-exclusion
  // path (the hot path during normal gameplay) IS cached above.
  const placeholders = Array.from({ length: exclude.size }, () => "?").join(",");
  const row = db()
    .prepare(
      `SELECT word FROM answers WHERE word NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`
    )
    .get(...([...exclude] as [string, ...string[]])) as { word: string } | undefined;

  // Fallback: if somehow every answer word was used, sample from full pool
  if (!row) {
    stmts.randomAnswer ??= db().prepare("SELECT word FROM answers ORDER BY RANDOM() LIMIT 1");
    return (stmts.randomAnswer.get() as { word: string } | undefined)?.word ?? "crane";
  }

  return row.word;
}

// ---------------------------------------------------------------------------
// Populate answers (wordlehints.co.uk) — refreshed daily
// ---------------------------------------------------------------------------

export async function syncAnswers(force = false): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && getMeta("answers_fetched") === today) {
    console.log("> Answers already up to date");
    return;
  }

  console.log(`> Fetching answers from wordlehints.co.uk… (force=${force})`);
  const words: { word: string; date: string; game: number }[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `https://wordlehints.co.uk/wp-json/wordlehint/v1/answers?per_page=200&page=${page}`
    );
    if (!res.ok) throw new Error(`Answers API error: ${res.status}`);
    const data = (await res.json()) as {
      results?: { answer: string; date: string; game: number }[];
      has_more?: boolean;
    };
    for (const entry of data.results ?? []) {
      if (entry.answer?.length === 5)
        words.push({ word: entry.answer.toLowerCase(), date: entry.date, game: entry.game });
    }
    hasMore = data.has_more ?? false;
    page++;
  }

  if (words.length === 0) {
    console.warn("> Answers sync returned 0 words — skipping setMeta so next startup retries");
    return;
  }

  const insert = db().prepare(
    "INSERT OR REPLACE INTO answers (word, date, game) VALUES (?, ?, ?)"
  );
  db().transaction(() => {
    for (const { word, date, game } of words) insert.run(word, date, game);
  })();

  setMeta("answers_fetched", today);
  console.log(`> Answers DB: ${words.length} words stored (${today})`);
}

export function answersCount(): number {
  const row = db().prepare("SELECT COUNT(*) as cnt FROM answers").get() as { cnt: number };
  return row.cnt;
}

export function clearAnswersMeta(): void {
  db().prepare("DELETE FROM meta WHERE key = 'answers_fetched'").run();
  console.log("> Cleared answers_fetched meta — next startup will re-sync");
}

// ---------------------------------------------------------------------------
// Populate valid words (english-words list) — refreshed weekly
// ---------------------------------------------------------------------------

export async function syncValidWords(): Promise<void> {
  const lastFetch = getMeta("valid_words_fetched");
  if (lastFetch) {
    const daysSince =
      (Date.now() - new Date(lastFetch).getTime()) / 86_400_000;
    if (daysSince < 7) {
      console.log("> Valid words already up to date");
      return;
    }
  }

  console.log("> Fetching valid word list…");
  const res = await fetch(
    "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt"
  );
  if (!res.ok) throw new Error(`Word list fetch error: ${res.status}`);
  const text = await res.text();

  const words = text
    .split("\n")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length === 5 && /^[a-z]+$/.test(w));

  const insert = db().prepare("INSERT OR IGNORE INTO valid_words (word) VALUES (?)");
  db().transaction(() => {
    for (const word of words) insert.run(word);
  })();

  setMeta("valid_words_fetched", new Date().toISOString().slice(0, 10));
  console.log(`> Valid words DB: ${words.length} words stored`);
}

// ---------------------------------------------------------------------------
// Daily refresh scheduler
// ---------------------------------------------------------------------------

export function scheduleDailySync(): void {
  const msUntilMidnight = (): number => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  };

  const runDaily = async () => {
    try {
      await syncAnswers();
    } catch (err) {
      console.error("> Daily answer sync failed:", err);
    }
    setTimeout(runDaily, 24 * 60 * 60 * 1000);
  };

  setTimeout(runDaily, msUntilMidnight());
}

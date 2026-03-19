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
  `);
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

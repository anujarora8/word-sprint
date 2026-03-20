// Shared types between server and client — single source of truth.
// Server imports with "./src/lib/types"; client imports with "@/lib/types".

export type LetterState = "correct" | "present" | "absent";
export type ScoringMode = "sprint" | "points";

export interface GuessResult {
  letter: string;
  state: LetterState;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
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

export interface RoomSnapshot {
  id: string;
  started: boolean;
  finished: boolean;
  counting: boolean;
  totalRounds: number;
  scoringMode: ScoringMode;
  tiebreaker: boolean;
  players: PlayerSnapshot[];
}

export interface MatchOverResult {
  id: string;
  name: string;
  wordsCompleted: number;
  wordsFailed: number;
  totalGuesses: number;
  finished: boolean;
  score: number;
  tiebreakerScore: number;
}

export interface MatchOver {
  scoringMode: ScoringMode;
  tiebreaker: boolean;
  winnerId: string | null;
  results: MatchOverResult[];
}

export interface WordFlash {
  word: string;
  solved: boolean;
  pointsEarned: number;
  newTotal: number;
  pointsToWin: number;
  tiebreaker: boolean;
}

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";
import GameBoard from "@/components/GameBoard";
import Keyboard from "@/components/Keyboard";
import OpponentBoard from "@/components/OpponentBoard";

type LetterState = "correct" | "present" | "absent";
type ScoringMode = "sprint" | "points";

interface GuessResult {
  letter: string;
  state: LetterState;
}

interface PlayerSnapshot {
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
}

interface RoomSnapshot {
  id: string;
  started: boolean;
  finished: boolean;
  totalRounds: number;
  scoringMode: ScoringMode;
  tiebreaker: boolean;
  players: PlayerSnapshot[];
}

interface MatchOverResult {
  id: string;
  name: string;
  wordsCompleted: number;
  wordsFailed: number;
  totalGuesses: number;
  finished: boolean;
  score: number;
  tiebreakerScore: number;
}

interface WordFlash {
  word: string;
  solved: boolean;
  pointsEarned: number;
  newTotal: number;
  pointsToWin: number;
  tiebreaker: boolean;
}

const POINTS_TO_WIN = 12;

export default function GamePage() {
  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();

  const [myId, setMyId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [currentGuess, setCurrentGuess] = useState("");
  const [message, setMessage] = useState("");
  const [wordFlash, setWordFlash] = useState<WordFlash | null>(null);
  const [matchOver, setMatchOver] = useState<{ scoringMode: ScoringMode; tiebreaker: boolean; results: MatchOverResult[] } | null>(null);
  const [opponentLeft, setOpponentLeft] = useState(false);
  const [shake, setShake] = useState(false);
  const [tiebreakerBanner, setTiebreakerBanner] = useState(false);
  const socketRef = useRef(getSocket());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const myPlayer = room?.players.find((p) => p.id === myId) ?? null;
  const opponent = room?.players.find((p) => p.id !== myId) ?? null;
  const isHost = room?.players[0]?.id === myId;

  const letterStates = useCallback((): Record<string, LetterState> => {
    const states: Record<string, LetterState> = {};
    if (!myPlayer) return states;
    for (const guess of myPlayer.guesses) {
      for (const { letter, state } of guess) {
        const current = states[letter];
        if (current === "correct") continue;
        if (current === "present" && state !== "correct") continue;
        states[letter] = state;
      }
    }
    return states;
  }, [myPlayer]);

  useEffect(() => {
    const socket = socketRef.current;

    const init = () => {
      setMyId(socket.id ?? null);
      socket.emit("request_room_state", { roomId });
    };

    if (socket.connected) init();
    else socket.once("connect", init);

    socket.on("connect", () => {
      setMyId(socket.id ?? null);
      socket.emit("request_room_state", { roomId });
    });

    socket.on("room_update", (snapshot: RoomSnapshot) => setRoom(snapshot));

    socket.on("match_started", () => {
      setCurrentGuess("");
      setMessage("");
      setWordFlash(null);
      setMatchOver(null);
      setTiebreakerBanner(false);
    });

    socket.on("game_restarted", () => {
      setMatchOver(null);
      setWordFlash(null);
      setCurrentGuess("");
      setMessage("");
      setTiebreakerBanner(false);
      setOpponentLeft(false);
    });

    socket.on("tiebreaker_started", () => {
      setTiebreakerBanner(true);
      setWordFlash(null);
      setCurrentGuess("");
      setTimeout(() => setTiebreakerBanner(false), 3000);
    });

    socket.on("word_result", ({
      word, solved, pointsEarned, newTotal, pointsToWin, tiebreaker,
    }: { word: string; solved: boolean; pointsEarned: number; newTotal: number; pointsToWin: number; tiebreaker: boolean }) => {
      setCurrentGuess("");
      setWordFlash({ word, solved, pointsEarned, newTotal, pointsToWin: pointsToWin ?? 0, tiebreaker: tiebreaker ?? false });
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setWordFlash(null), 2500);
    });

    socket.on("match_over", (data: { scoringMode: ScoringMode; tiebreaker: boolean; results: MatchOverResult[] }) => {
      setMatchOver(data);
      setWordFlash(null);
      setTiebreakerBanner(false);
    });

    socket.on("opponent_disconnected", () => setOpponentLeft(true));
    socket.on("error", ({ message }: { message: string }) => {
      setMessage(message);
      setShake(true);
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
      shakeTimerRef.current = setTimeout(() => setShake(false), 450);
    });

    return () => {
      socket.off("connect");
      socket.off("room_update");
      socket.off("match_started");
      socket.off("game_restarted");
      socket.off("tiebreaker_started");
      socket.off("word_result");
      socket.off("match_over");
      socket.off("opponent_disconnected");
      socket.off("error");
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    };
  }, [roomId]);

  const submitGuess = useCallback(() => {
    if (currentGuess.length !== 5) { setMessage("Word must be 5 letters."); return; }
    socketRef.current.emit("submit_guess", { guess: currentGuess });
    setCurrentGuess("");
    setMessage("");
  }, [currentGuess]);

  const handleKey = useCallback(
    (key: string) => {
      if (matchOver || myPlayer?.finished) return;
      if (key === "Enter") submitGuess();
      else if (key === "⌫" || key === "Backspace") setCurrentGuess((g) => g.slice(0, -1));
      else if (/^[a-zA-Z]$/.test(key) && currentGuess.length < 5)
        setCurrentGuess((g) => g + key.toLowerCase());
    },
    [matchOver, myPlayer, currentGuess, submitGuess]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handleKey(e.key);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleKey]);

  const setRounds = (n: number) => socketRef.current.emit("set_rounds", { totalRounds: n });
  const setScoringMode = (m: ScoringMode) => socketRef.current.emit("set_scoring_mode", { scoringMode: m });
  const startGame = () => socketRef.current.emit("start_game");
  const restartGame = () => socketRef.current.emit("restart_game");
  const leaveGame = () => router.push("/");

  if (!room) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <p className="text-zinc-400 animate-pulse">Connecting to room {roomId}…</p>
      </main>
    );
  }

  const canStart = room.players.length >= 2 && !room.started && isHost;
  const isPoints = room.scoringMode === "points";

  return (
    <main className="min-h-screen bg-zinc-950 text-white flex flex-col items-center gap-4 py-4 px-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap justify-center">
        <h1 className="text-2xl font-extrabold text-sky-400 tracking-tight">Word Sprint</h1>
        <span className="text-xs bg-zinc-800 border border-zinc-700 rounded-full px-3 py-1 text-zinc-400 font-mono">
          {roomId}
        </span>
        {room.started && (
          <span className="text-xs bg-zinc-800 border border-zinc-700 rounded-full px-3 py-1 text-zinc-300">
            {isPoints ? "Points · Race to 12" : `Sprint · ${room.totalRounds} word${room.totalRounds !== 1 ? "s" : ""}`}
          </span>
        )}
      </div>

      {/* Tiebreaker banner */}
      {tiebreakerBanner && (
        <div className="w-full max-w-lg bg-yellow-500/20 border border-yellow-500 rounded-xl px-6 py-3 text-center animate-pulse">
          <p className="text-yellow-400 font-extrabold text-xl tracking-widest">TIEBREAKER!</p>
          <p className="text-yellow-300 text-sm mt-1">One word each — highest score wins</p>
        </div>
      )}

      {/* Tiebreaker persistent badge (during play) */}
      {room.started && !matchOver && room.tiebreaker && !tiebreakerBanner && (
        <div className="bg-yellow-500/10 border border-yellow-600/50 rounded-lg px-4 py-2 text-yellow-400 text-sm font-semibold">
          ⚡ Tiebreaker round
        </div>
      )}

      {/* Live stats bar */}
      {room.started && !matchOver && (
        <div className="flex gap-4 w-full max-w-lg">
          {room.players.map((p) => {
            const progressVal = isPoints ? p.score : p.wordsCompleted;
            const progressMax = isPoints ? POINTS_TO_WIN : room.totalRounds;
            const ptsToWin = Math.max(0, POINTS_TO_WIN - p.score);
            return (
              <div key={p.id} className="flex-1 flex flex-col gap-1">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>{p.name}{p.id === myId ? " (you)" : ""}</span>
                  {isPoints ? (
                    <span className="flex items-center gap-1">
                      <span className="text-yellow-400 font-bold">{p.score}</span>
                      <span className="text-zinc-500">/ {POINTS_TO_WIN}</span>
                      {p.id === myId && ptsToWin > 0 && (
                        <span className="text-zinc-600 ml-1">({ptsToWin} to win)</span>
                      )}
                    </span>
                  ) : (
                    <span>{p.wordsCompleted}/{room.totalRounds}</span>
                  )}
                </div>
                <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${isPoints ? "bg-yellow-500" : "bg-sky-500"}`}
                    style={{ width: `${Math.min(100, (progressVal / progressMax) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lobby */}
      {!room.started && (
        <div className="flex flex-col items-center gap-5 bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-sm">
          <h2 className="text-lg font-semibold">Waiting for players</h2>

          {/* Player list */}
          <div className="flex flex-col gap-2 w-full">
            {room.players.map((p) => (
              <div key={p.id} className="flex items-center gap-2 bg-zinc-800 rounded-lg px-4 py-2">
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                <span className="font-medium">{p.name}</span>
                {p.id === myId && <span className="text-xs text-zinc-500 ml-auto">you</span>}
              </div>
            ))}
            {room.players.length < 2 && (
              <div className="flex items-center gap-2 bg-zinc-800/50 border border-dashed border-zinc-700 rounded-lg px-4 py-2">
                <span className="w-2 h-2 rounded-full bg-zinc-600" />
                <span className="text-zinc-500 text-sm">Waiting for opponent…</span>
              </div>
            )}
          </div>

          {room.players.length < 2 && (
            <p className="text-sm text-zinc-500">
              Share code <span className="font-mono text-sky-400">{roomId}</span> with a friend
            </p>
          )}

          {isHost ? (
            <>
              {/* Scoring mode selector */}
              <div className="w-full flex flex-col gap-2">
                <p className="text-sm text-zinc-400 text-center">Scoring mode</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setScoringMode("sprint")}
                    className={`flex flex-col items-start gap-1 p-3 rounded-xl border-2 text-left transition-colors ${
                      !isPoints
                        ? "border-sky-500 bg-sky-500/10"
                        : "border-zinc-700 bg-zinc-800 hover:border-zinc-600"
                    }`}
                  >
                    <span className="font-bold text-sm">Sprint</span>
                    <span className="text-xs text-zinc-400 leading-snug">
                      Race through words. First to finish wins.
                    </span>
                  </button>
                  <button
                    onClick={() => setScoringMode("points")}
                    className={`flex flex-col items-start gap-1 p-3 rounded-xl border-2 text-left transition-colors ${
                      isPoints
                        ? "border-yellow-500 bg-yellow-500/10"
                        : "border-zinc-700 bg-zinc-800 hover:border-zinc-600"
                    }`}
                  >
                    <span className="font-bold text-sm">Points</span>
                    <span className="text-xs text-zinc-400 leading-snug">
                      Race to 12 pts. Fewer guesses = more points.
                    </span>
                  </button>
                </div>
                {isPoints && (
                  <div className="bg-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-400 leading-relaxed text-center">
                    1 guess = 9 pts · 2 = 6 · 3 = 4 · 4 = 3 · 5 = 2 · 6 = 1
                  </div>
                )}
              </div>

              {/* Round selector — sprint only */}
              {!isPoints && (
                <div className="w-full flex flex-col gap-2">
                  <p className="text-sm text-zinc-400 text-center">Number of Rounds</p>
                  <div className="flex gap-2 justify-center">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        onClick={() => setRounds(n)}
                        className={`w-10 h-10 rounded-lg font-bold text-sm transition-colors ${
                          room.totalRounds === n
                            ? "bg-sky-500 text-white"
                            : "bg-zinc-700 text-white hover:bg-zinc-600"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button
                disabled={!canStart}
                onClick={startGame}
                className="w-full bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-white font-bold py-3 rounded-lg transition-colors"
              >
                {canStart ? "Start" : "Waiting for opponent…"}
              </button>
            </>
          ) : (
            room.players.length >= 2 && (
              <div className="w-full bg-zinc-800 rounded-xl p-4 flex flex-col gap-2 text-sm text-zinc-300">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Mode</span>
                  <span className="font-semibold">{isPoints ? "Points" : "Sprint"}</span>
                </div>
                {!isPoints && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Words</span>
                    <span className="font-semibold">{room.totalRounds}</span>
                  </div>
                )}
                {isPoints && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Goal</span>
                    <span className="font-semibold text-yellow-400">Race to 12 pts</span>
                  </div>
                )}
                <p className="text-zinc-500 text-xs text-center pt-1">Waiting for host to start…</p>
              </div>
            )
          )}
        </div>
      )}

      {/* Game — side-by-side layout */}
      {room.started && !matchOver && (
        <div className="flex gap-6 items-start justify-center w-full">

          {/* Left: opponent panel */}
          <div className="flex flex-col gap-3 shrink-0 w-32">
            {opponent ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col items-center gap-2">
                <span className="text-xs font-semibold text-zinc-300 truncate max-w-full">{opponent.name}</span>
                {opponent.finished && <span className="text-xs text-sky-400 font-bold">DONE!</span>}
                {isPoints && (
                  <span className="text-xs text-yellow-400 font-bold">{opponent.score} pts</span>
                )}
                <OpponentBoard
                  name=""
                  guesses={opponent.guesses}
                  solved={opponent.finished}
                  gaveUp={false}
                />
              </div>
            ) : (
              <div className="bg-zinc-900/50 border border-dashed border-zinc-800 rounded-xl p-3 flex items-center justify-center h-32">
                <span className="text-zinc-600 text-xs text-center">Waiting for opponent</span>
              </div>
            )}
          </div>

          {/* Center: player's board + keyboard */}
          <div className="flex flex-col items-center gap-2">
            {wordFlash && (
              <div className={`text-sm font-bold px-3 py-2 rounded-lg flex flex-col gap-0.5 text-center ${
                wordFlash.solved ? "bg-sky-900/50 border border-sky-700" : "bg-red-900/50 border border-red-800"
              }`}>
                <span className={wordFlash.solved ? "text-sky-300" : "text-red-300"}>
                  {wordFlash.solved
                    ? `✓ "${wordFlash.word.toUpperCase()}" solved!`
                    : `✗ The word was "${wordFlash.word.toUpperCase()}"`}
                </span>
                {isPoints && (
                  <span className="text-yellow-400 font-extrabold">
                    {wordFlash.pointsEarned > 0 ? `+${wordFlash.pointsEarned} pts` : "+0 pts"} · {wordFlash.newTotal} total
                  </span>
                )}
                {isPoints && !myPlayer?.finished && wordFlash.pointsToWin > 0 && !wordFlash.tiebreaker && (
                  <span className="text-zinc-400 text-xs">{wordFlash.pointsToWin} pts to win</span>
                )}
                {!myPlayer?.finished && !isPoints && (
                  <span className="text-zinc-400 text-xs">Next word coming up…</span>
                )}
              </div>
            )}

            {myPlayer && !myPlayer.finished && (
              <>
                <GameBoard
                  guesses={myPlayer.guesses}
                  currentGuess={currentGuess}
                  maxGuesses={6}
                  shake={shake}
                />
                {message && <p className="text-yellow-400 text-xs font-medium">{message}</p>}
                <Keyboard letterStates={letterStates()} onKey={handleKey} />
              </>
            )}

            {myPlayer?.finished && !matchOver && (
              <p className="text-sky-400 font-bold text-lg text-center">
                {isPoints
                  ? `${myPlayer.score} pts — waiting for opponent…`
                  : "All done! Waiting for opponent…"}
              </p>
            )}
          </div>

          {/* Right: spacer to keep board centered */}
          <div className="w-32 shrink-0" />
        </div>
      )}

      {/* Opponent disconnected */}
      {opponentLeft && !matchOver && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl px-6 py-4 text-center">
          <p className="text-yellow-400 font-semibold">Opponent disconnected.</p>
          <button onClick={leaveGame} className="mt-2 text-sm text-zinc-400 underline">Back to lobby</button>
        </div>
      )}

      {/* Match-over modal */}
      {matchOver && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-8 w-full max-w-sm text-center flex flex-col gap-4">
            {(() => {
              const me = matchOver.results.find((r) => r.id === myId);
              const opp = matchOver.results.find((r) => r.id !== myId);

              let iWon: boolean;
              let isDraw: boolean;

              if (matchOver.scoringMode === "points") {
                const myFinal = (me?.score ?? 0) + (matchOver.tiebreaker ? (me?.tiebreakerScore ?? 0) : 0);
                const oppFinal = (opp?.score ?? 0) + (matchOver.tiebreaker ? (opp?.tiebreakerScore ?? 0) : 0);
                isDraw = myFinal === oppFinal;
                iWon = !isDraw && myFinal > oppFinal;
              } else {
                isDraw = !!(me?.finished && opp?.finished && me.totalGuesses === opp.totalGuesses);
                iWon = !isDraw && !!(
                  (me?.finished && !opp?.finished) ||
                  (me?.finished && opp?.finished && (me.totalGuesses ?? 999) < (opp?.totalGuesses ?? 999))
                );
              }

              return (
                <>
                  <h2 className={`text-3xl font-extrabold ${isDraw ? "text-yellow-400" : iWon ? "text-sky-400" : "text-red-400"}`}>
                    {isDraw ? "Draw!" : iWon ? "You Win!" : "You Lose"}
                  </h2>

                  {matchOver.tiebreaker && (
                    <p className="text-yellow-500 text-xs font-semibold tracking-wider">decided by tiebreaker</p>
                  )}

                  <p className="text-zinc-400 text-sm">
                    {matchOver.scoringMode === "points" ? "Points mode · Race to 12" : `Sprint mode · ${room.totalRounds} word${room.totalRounds !== 1 ? "s" : ""}`}
                  </p>

                  <div className="flex flex-col gap-2 text-sm">
                    {matchOver.results
                      .slice()
                      .sort((a, b) => {
                        if (matchOver.scoringMode === "points") {
                          const aTotal = a.score + (matchOver.tiebreaker ? a.tiebreakerScore : 0);
                          const bTotal = b.score + (matchOver.tiebreaker ? b.tiebreakerScore : 0);
                          return bTotal - aTotal;
                        }
                        return (a.totalGuesses ?? 999) - (b.totalGuesses ?? 999);
                      })
                      .map((r) => (
                        <div key={r.id} className="flex items-center justify-between bg-zinc-800 rounded-lg px-4 py-3">
                          <span className="font-medium">{r.name}{r.id === myId ? " (you)" : ""}</span>
                          <span className="flex items-center gap-2 text-right">
                            {matchOver.scoringMode === "points" ? (
                              <span className="flex flex-col items-end gap-0.5">
                                <span className="text-yellow-400 font-bold text-lg">{r.score} pts</span>
                                {matchOver.tiebreaker && (
                                  <span className="text-yellow-600 text-xs">+{r.tiebreakerScore} tb</span>
                                )}
                              </span>
                            ) : (
                              <>
                                <span className="text-zinc-400 text-xs">{r.wordsCompleted}/{room.totalRounds} solved</span>
                                <span className="text-zinc-300 text-xs">{r.totalGuesses} guesses</span>
                                {r.finished && <span className="text-sky-400 text-xs font-bold">✓</span>}
                              </>
                            )}
                          </span>
                        </div>
                      ))}
                  </div>

                  {matchOver.scoringMode === "points" && (
                    <p className="text-zinc-600 text-xs">1 guess=9pts · 2=6 · 3=4 · 4=3 · 5=2 · 6=1</p>
                  )}
                </>
              );
            })()}
            <div className="flex flex-col gap-2 mt-2">
              {isHost ? (
                <button
                  onClick={restartGame}
                  className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-3 rounded-lg transition-colors"
                >
                  Play Again
                </button>
              ) : (
                <p className="text-zinc-500 text-sm text-center">Waiting for host to restart…</p>
              )}
              <button
                onClick={leaveGame}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium py-2 rounded-lg transition-colors text-sm"
              >
                Leave Room
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

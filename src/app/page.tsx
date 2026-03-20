"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSocket, getPlayerId } from "@/lib/socket";

type Step = "name" | "choice" | "join";

export default function Home() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    socket.on("room_created", ({ roomId }: { roomId: string }) => {
      router.push(`/game/${roomId}`);
    });
    socket.on("room_joined", ({ roomId }: { roomId: string }) => {
      router.push(`/game/${roomId}`);
    });
    socket.on("app_error", ({ message }: { message: string }) => {
      setError(message);
      setLoading(false);
    });
    return () => {
      socket.off("room_created");
      socket.off("room_joined");
      socket.off("app_error");
    };
  }, [router]);

  const confirmName = () => {
    if (!name.trim()) { setError("Please enter your name."); return; }
    setError("");
    setStep("choice");
  };

  const createRoom = () => {
    setError("");
    setLoading(true);
    getSocket().emit("create_room", { playerName: name.trim(), playerId: getPlayerId() });
  };

  const goJoin = () => {
    setError("");
    setStep("join");
  };

  const joinRoom = () => {
    if (!roomId.trim()) { setError("Enter the room code."); return; }
    setError("");
    setLoading(true);
    getSocket().emit("join_room", { roomId: roomId.trim(), playerName: name.trim(), playerId: getPlayerId() });
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
      {/* Logo */}
      <div className="text-center mb-10">
        <h1 className="text-5xl font-extrabold tracking-tight text-sky-400">Word Sprint</h1>
        <p className="text-zinc-500 mt-2">Real-time 1v1 Wordle races</p>
      </div>

      <div className="w-full max-w-xs flex flex-col gap-6">

        {/* Step 1 — Name */}
        <div className={`flex flex-col gap-3 transition-opacity duration-200 ${step !== "name" ? "opacity-40 pointer-events-none" : ""}`}>
          <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Step 1 — Your name
          </label>
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition"
            placeholder="Type your name…"
            value={name}
            maxLength={16}
            autoFocus
            onChange={(e) => { setName(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && step === "name" && confirmName()}
          />
          {step === "name" && (
            <button
              onClick={confirmName}
              className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-3 rounded-xl transition-colors"
            >
              Continue →
            </button>
          )}
          {step !== "name" && (
            <div className="flex items-center justify-between">
              <span className="text-white font-medium">{name}</span>
              <button
                onClick={() => { setStep("name"); setError(""); }}
                className="text-xs text-zinc-500 hover:text-zinc-300 underline transition-colors"
              >
                change
              </button>
            </div>
          )}
        </div>

        {/* Step 2 — Create or Join */}
        {step !== "name" && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Step 2 — Start or join a game
            </label>

            {step === "choice" && (
              <div className="flex flex-col gap-3">
                <button
                  onClick={createRoom}
                  disabled={loading}
                  className="w-full bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white font-bold py-4 rounded-xl transition-colors text-left px-5 flex flex-col"
                >
                  <span>Create a room</span>
                  <span className="text-sky-200 text-xs font-normal mt-0.5">Start a new game and invite a friend</span>
                </button>
                <button
                  onClick={goJoin}
                  disabled={loading}
                  className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-bold py-4 rounded-xl border border-zinc-700 transition-colors text-left px-5 flex flex-col"
                >
                  <span>Join a room</span>
                  <span className="text-zinc-400 text-xs font-normal mt-0.5">Enter a code from your friend</span>
                </button>
              </div>
            )}

            {step === "join" && (
              <div className="flex flex-col gap-3">
                <input
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-600 text-center text-xl font-mono tracking-[0.3em] uppercase focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition"
                  placeholder="ABC123"
                  value={roomId}
                  maxLength={6}
                  autoFocus
                  onChange={(e) => { setRoomId(e.target.value.toUpperCase()); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                />
                <button
                  onClick={joinRoom}
                  disabled={loading}
                  className="w-full bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors"
                >
                  {loading ? "Joining…" : "Join Room"}
                </button>
                <button
                  onClick={() => { setStep("choice"); setRoomId(""); setError(""); }}
                  className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  ← Back
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-red-400 text-sm text-center -mt-2">{error}</p>
        )}
      </div>

      <p className="text-zinc-700 text-xs mt-12">Race through words — first to finish wins!</p>
    </main>
  );
}

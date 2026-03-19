"use client";

import React, { useEffect, useRef, useState } from "react";
import type { LetterState, GuessResult } from "@/lib/types";

interface Props {
  guesses: GuessResult[][];
  currentGuess: string;
  maxGuesses?: number;
  shake?: boolean;
}

const STATE_CLASSES: Record<LetterState, string> = {
  correct: "bg-green-600 border-green-600 text-white",
  present: "bg-yellow-500 border-yellow-500 text-white",
  absent: "bg-zinc-600 border-zinc-600 text-white",
};

// Duration of one tile's flip + stagger per tile (ms)
const FLIP_DURATION = 500;
const STAGGER = 280;

export default function GameBoard({ guesses, currentGuess, maxGuesses = 6, shake = false }: Props) {
  const [animatingRow, setAnimatingRow] = useState(-1);
  const prevLengthRef = useRef(guesses.length);

  useEffect(() => {
    if (guesses.length > prevLengthRef.current) {
      const newRow = guesses.length - 1;
      setAnimatingRow(newRow);
      const total = STAGGER * 4 + FLIP_DURATION + 50; // last tile finishes here
      const timer = setTimeout(() => setAnimatingRow(-1), total);
      prevLengthRef.current = guesses.length;
      return () => clearTimeout(timer);
    }
    prevLengthRef.current = guesses.length;
  }, [guesses.length]);

  const rows = Array.from({ length: maxGuesses }, (_, i) => {
    if (i < guesses.length) return { type: "submitted" as const, data: guesses[i] };
    if (i === guesses.length) return { type: "current" as const };
    return { type: "empty" as const };
  });

  return (
    <div className="grid gap-1.5">
      {rows.map((row, rowIdx) => (
        <div key={rowIdx} className="flex gap-1.5">
          {Array.from({ length: 5 }, (_, colIdx) => {
            if (row.type === "submitted") {
              const cell = row.data[colIdx];
              const isAnimating = rowIdx === animatingRow;
              const delay = colIdx * STAGGER;

              if (isAnimating) {
                // 3-D flip: front = neutral dark, back = colored result
                return (
                  <div
                    key={colIdx}
                    className="w-12 h-12"
                    style={{ perspective: "250px" }}
                  >
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        position: "relative",
                        transformStyle: "preserve-3d",
                        animation: `tile-flip ${FLIP_DURATION}ms ease-in-out ${delay}ms forwards`,
                      }}
                    >
                      {/* Front face — shown before flip */}
                      <div
                        className="absolute inset-0 flex items-center justify-center text-xl font-bold uppercase border-2 border-zinc-600 bg-zinc-800 text-white rounded"
                        style={{ backfaceVisibility: "hidden" }}
                      >
                        {cell.letter}
                      </div>
                      {/* Back face — revealed as tile flips */}
                      <div
                        className={`absolute inset-0 flex items-center justify-center text-xl font-bold uppercase border-2 rounded ${STATE_CLASSES[cell.state]}`}
                        style={{
                          backfaceVisibility: "hidden",
                          transform: "rotateX(180deg)",
                        }}
                      >
                        {cell.letter}
                      </div>
                    </div>
                  </div>
                );
              }

              // Settled tile — no animation
              return (
                <div
                  key={colIdx}
                  className={`w-12 h-12 flex items-center justify-center text-xl font-bold uppercase border-2 rounded ${STATE_CLASSES[cell.state]}`}
                >
                  {cell.letter}
                </div>
              );
            }

            if (row.type === "current") {
              const letter = currentGuess[colIdx] ?? "";
              return (
                <div
                  key={colIdx}
                  style={shake ? { animation: "row-shake 0.4s ease-in-out" } : undefined}
                  className={`w-12 h-12 flex items-center justify-center text-xl font-bold uppercase border-2 rounded transition-all ${
                    letter
                      ? "border-zinc-400 bg-zinc-800 text-white scale-105"
                      : "border-zinc-600 bg-zinc-900 text-white"
                  }`}
                >
                  {letter}
                </div>
              );
            }

            return (
              <div
                key={colIdx}
                className="w-12 h-12 flex items-center justify-center border-2 border-zinc-700 rounded bg-zinc-900"
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

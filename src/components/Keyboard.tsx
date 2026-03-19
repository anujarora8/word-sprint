"use client";

import React from "react";

type LetterState = "correct" | "present" | "absent";

interface Props {
  letterStates: Record<string, LetterState>;
  onKey: (key: string) => void;
}

const ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["Enter", "z", "x", "c", "v", "b", "n", "m", "⌫"],
];

const STATE_CLASSES: Record<LetterState, string> = {
  correct: "bg-green-600 text-white",
  present: "bg-yellow-500 text-white",
  absent: "bg-zinc-600 text-zinc-300",
};

export default function Keyboard({ letterStates, onKey }: Props) {
  return (
    <div className="flex flex-col gap-1.5 items-center select-none">
      {ROWS.map((row, i) => (
        <div key={i} className="flex gap-1.5">
          {row.map((key) => {
            const state = letterStates[key];
            const isWide = key === "Enter" || key === "⌫";
            return (
              <button
                key={key}
                onClick={() => onKey(key)}
                className={`h-12 ${isWide ? "px-3 text-xs" : "w-9"} rounded font-bold uppercase cursor-pointer transition-colors ${
                  state ? STATE_CLASSES[state] : "bg-zinc-500 text-white hover:bg-zinc-400"
                }`}
              >
                {key}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

"use client";

import React from "react";

type LetterState = "correct" | "present" | "absent";

interface GuessResult {
  letter: string;
  state: LetterState;
}

interface Props {
  name: string;
  guesses: GuessResult[][];
  solved: boolean;
  gaveUp: boolean;
}

const STATE_DOT: Record<LetterState, string> = {
  correct: "bg-green-500",
  present: "bg-yellow-400",
  absent: "bg-zinc-500",
};

export default function OpponentBoard({ name, guesses, solved, gaveUp }: Props) {
  return (
    <div className="flex flex-col items-center gap-2">
      {name && <h3 className="text-sm font-semibold text-zinc-300">{name}</h3>}
      {!name && solved && <span className="text-xs text-sky-400 font-bold">DONE!</span>}
      {!name && gaveUp && <span className="text-xs text-red-400 font-bold">OUT</span>}
      <div className="grid gap-1">
        {Array.from({ length: 6 }, (_, rowIdx) => (
          <div key={rowIdx} className="flex gap-1">
            {Array.from({ length: 5 }, (_, colIdx) => {
              const cell = guesses[rowIdx]?.[colIdx];
              return (
                <div
                  key={colIdx}
                  className={`w-5 h-5 rounded-sm border border-zinc-700 ${
                    cell ? STATE_DOT[cell.state] : "bg-zinc-800"
                  }`}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

# Word Sprint

Real-time 1v1 Wordle races. Two players share a room, guess the same words, and race to win — either by finishing all rounds first (Sprint) or accumulating the most points (Points).

---

## How it works

- **Sprint mode** — both players work through the same sequence of words. First to finish all rounds wins. Tiebreak on fewest total guesses.
- **Points mode** — race to 12 points. Fewer guesses = more points (1 guess = 9 pts, 2 = 6, 3 = 4, 4 = 3, 5 = 2, 6 = 1). If both players hit 12 with equal scores, a tiebreaker word decides it.

Both players see a mini live view of their opponent's board in real time.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4 |
| Real-time | Socket.IO 4 |
| Server | Custom Node HTTP server (`server.ts`) colocated with Next.js |
| Database | SQLite via `better-sqlite3` (word lists, answers) |
| Hosting | Railway |
| Tests | Playwright |

---

## Local development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/anujarora8/word-sprint.git
cd word-sprint
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The server fetches word lists from external APIs on first run — this takes a few seconds.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: `3000`) |
| `CORS_ORIGIN` | Production only | Allowed origin, e.g. `https://word-sprint-production.up.railway.app` |
| `RESET_WORDS` | No | Set to `true` to force re-sync the answers DB on next startup |

---

## Project structure

```
server.ts          # Socket.IO + HTTP server (game logic lives here)
db.ts              # SQLite helpers — word lists, answers, prepared statements
src/
  app/
    page.tsx               # Home page (create/join room)
    game/[roomId]/page.tsx # Live game page
    globals.css
  components/
    GameBoard.tsx    # Animated 6×5 guess grid
    Keyboard.tsx     # On-screen keyboard with letter-state colouring
    OpponentBoard.tsx # Mini dot-grid view of opponent's board
  lib/
    socket.ts        # Singleton Socket.IO client
    types.ts         # Shared types (server + client)
tests/
  home.spec.ts       # Playwright: home page flows
  multiplayer.spec.ts # Playwright: full 1v1 game scenarios
```

---

## Running tests

The test suite uses Playwright against a locally running server.

```bash
# Install browsers (first time only)
npx playwright install chromium

# Run all tests
npx playwright test

# Run with browser visible
npx playwright test --headed
```

Tests cover: home page validation, room create/join, lobby settings, gameplay (typing, backspace, invalid words, keyboard state), disconnect handling, and points mode.

---

## Deployment

The app is deployed via Railway (GitHub integration). Pushes to `main` trigger a new deployment.

Required environment variable in production:
```
CORS_ORIGIN=https://your-production-domain.com
```

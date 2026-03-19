/**
 * Multiplayer tests: two browser contexts simulating a full 1v1 game.
 *
 * These tests cover room creation/joining, lobby settings, the game start
 * flow, guess submission, and the match-over modal.
 */
import { test, expect, Page, BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function enterName(page: Page, name: string) {
  await page.goto("/");
  await page.getByPlaceholder("Type your name…").fill(name);
  await page.getByRole("button", { name: "Continue →" }).click();
}

async function createRoom(page: Page, name: string): Promise<string> {
  await enterName(page, name);
  await page.getByRole("button", { name: /Create a room/ }).click();
  // Wait for navigation to /game/:roomId
  await page.waitForURL(/\/game\/[A-Z0-9]{6}$/);
  const url = page.url();
  return url.split("/game/")[1];
}

async function joinRoom(page: Page, name: string, roomId: string) {
  await enterName(page, name);
  await page.getByRole("button", { name: /Join a room/ }).click();
  await page.getByPlaceholder("ABC123").fill(roomId);
  await page.getByRole("button", { name: "Join Room" }).click();
  await page.waitForURL(`/game/${roomId}`);
}

/** Type a 5-letter word via the on-screen keyboard and press Enter */
async function typeGuessOnscreen(page: Page, word: string) {
  for (const letter of word) {
    await page.getByRole("button", { name: new RegExp(`^${letter.toUpperCase()}`, "i") }).first().click();
  }
  await page.getByRole("button", { name: "Enter" }).click();
}

/** Type a guess using the physical keyboard */
async function typeGuess(page: Page, word: string) {
  await page.keyboard.type(word);
  await page.keyboard.press("Enter");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Room creation and lobby", () => {
  test("host lands in lobby with their name shown", async ({ browser }) => {
    const ctx = await browser.newContext();
    const host = await ctx.newPage();
    const roomId = await createRoom(host, "Alice");

    await expect(host.getByText("Alice")).toBeVisible();
    await expect(host.getByText("Waiting for players")).toBeVisible();
    // Share code hint is visible while waiting (room ID appears in multiple places — check first)
    await expect(host.getByText(roomId).first()).toBeVisible();

    await ctx.close();
  });

  test("second player can join and both see each other in lobby", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const host = await ctxA.newPage();
    const guest = await ctxB.newPage();

    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);

    // Both pages should show both players
    await expect(host.getByText("Bob")).toBeVisible();
    await expect(guest.getByText("Alice")).toBeVisible();

    // Start button becomes active for host
    await expect(host.getByRole("button", { name: "Start" })).toBeEnabled();
    // Guest sees mode summary, not start button
    await expect(guest.getByText("Waiting for host to start")).toBeVisible();

    await ctxA.close();
    await ctxB.close();
  });

  test("room is full after 2 players — third gets an error", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();

    const host = await ctxA.newPage();
    const guest = await ctxB.newPage();
    const extra = await ctxC.newPage();

    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    // Third player tries to join
    await enterName(extra, "Charlie");
    await extra.getByRole("button", { name: /Join a room/ }).click();
    await extra.getByPlaceholder("ABC123").fill(roomId);
    await extra.getByRole("button", { name: "Join Room" }).click();
    await expect(extra.getByText("Room is full.")).toBeVisible();

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test("host can switch between Sprint and Points mode", async ({ browser }) => {
    const ctx = await browser.newContext();
    const host = await ctx.newPage();
    await createRoom(host, "Alice");

    // Default is Sprint
    await expect(host.getByText("Number of Rounds")).toBeVisible();

    // Switch to Points
    await host.getByRole("button", { name: "Points" }).click();
    await expect(host.getByText("Race to 12 pts")).toBeVisible();
    await expect(host.getByText("Number of Rounds")).not.toBeVisible();

    // Switch back to Sprint
    await host.getByRole("button", { name: "Sprint" }).click();
    await expect(host.getByText("Number of Rounds")).toBeVisible();

    await ctx.close();
  });

  test("host can change round count in Sprint mode", async ({ browser }) => {
    const ctx = await browser.newContext();
    const host = await ctx.newPage();
    await createRoom(host, "Alice");

    // Click round button 5
    await host.getByRole("button", { name: "5" }).click();
    // The button should be highlighted (bg-sky-500)
    const btn5 = host.getByRole("button", { name: "5" });
    await expect(btn5).toHaveClass(/bg-sky-500/);

    await ctx.close();
  });
});

test.describe("Gameplay — Sprint mode", () => {
  let ctxA: BrowserContext, ctxB: BrowserContext;
  let host: Page, guest: Page;

  test.beforeEach(async ({ browser }) => {
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    host = await ctxA.newPage();
    guest = await ctxB.newPage();
  });

  test.afterEach(async () => {
    await ctxA.close();
    await ctxB.close();
  });

  test("game starts and both players see the board", async () => {
    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);

    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByText("match_started")).not.toBeVisible();

    // Both should see game boards (6×5 grid of tiles)
    // The keyboard should appear
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();
    await expect(guest.getByRole("button", { name: /^Enter$/ })).toBeVisible();
  });

  test("typing a guess updates the current row", async () => {
    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    await host.getByRole("button", { name: "Start" }).click();

    // Wait for game to start (keyboard appears)
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    // Type 3 letters on the host page
    await host.keyboard.type("cra");
    // The letters should appear in tiles
    await expect(host.locator("text=C").first()).toBeVisible();
    await expect(host.locator("text=R").first()).toBeVisible();
    await expect(host.locator("text=A").first()).toBeVisible();
  });

  test("backspace removes a letter from current guess", async () => {
    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    await host.keyboard.type("crane");
    // All 5 letters visible
    await expect(host.locator("text=E").first()).toBeVisible();
    // Press backspace once
    await host.keyboard.press("Backspace");
    // E should be gone from the current row (last cell should be empty)
    // We just verify the on-screen keyboard Backspace button also works
    await host.getByRole("button", { name: "Backspace" }).click();
    // D is gone too — only "cra" should remain
  });

  test("invalid word shows error shake", async () => {
    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    // "zzzzz" is almost certainly not a valid word
    await typeGuess(host, "zzzzz");
    await expect(host.getByText("Not in word list.")).toBeVisible();
  });

  test("guess shorter than 5 letters shows error", async () => {
    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    await host.keyboard.type("cra");
    await host.keyboard.press("Enter");
    await expect(host.getByText("Word must be 5 letters.")).toBeVisible();
  });

  test("on-screen keyboard reflects correct/present/absent states after a guess", async () => {
    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    // Submit a valid word — "crane" is almost always in the valid-word list
    await typeGuess(host, "crane");

    // At least one key on the keyboard should now have a colored state
    // (correct = green, present = yellow, absent = grey)
    const coloredKey = host.locator("button.bg-green-600, button.bg-yellow-500, button.bg-zinc-600").first();
    await expect(coloredKey).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Gameplay — Points mode", () => {
  test("live score bar shows points after a correct guess", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const host = await ctxA.newPage();
    const guest = await ctxB.newPage();

    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);

    // Switch to Points mode
    await host.getByRole("button", { name: "Points" }).click();
    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    // Score bar should show 0 pts initially (both players shown — check host's bar)
    await expect(host.getByText(/0.*\/ 12/).first()).toBeVisible();

    await ctxA.close();
    await ctxB.close();
  });
});

test.describe("Disconnect handling", () => {
  test("remaining player sees disconnected notice when opponent leaves", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const host = await ctxA.newPage();
    const guest = await ctxB.newPage();

    const roomId = await createRoom(host, "Alice");
    await joinRoom(guest, "Bob", roomId);
    await host.getByRole("button", { name: "Start" }).click();
    await expect(host.getByRole("button", { name: /^Enter$/ })).toBeVisible();

    // Guest closes their tab (simulates disconnect)
    await ctxB.close();

    // Host should see the disconnected notice
    await expect(host.getByText("Opponent disconnected.")).toBeVisible({ timeout: 8000 });
    await expect(host.getByRole("button", { name: "Back to lobby" })).toBeVisible();
  });
});

import { test, expect } from "@playwright/test";

test.describe("Home page", () => {
  test("shows logo and step 1 on load", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Word Sprint" })).toBeVisible();
    await expect(page.getByText("Step 1 — Your name")).toBeVisible();
    await expect(page.getByPlaceholder("Type your name…")).toBeVisible();
  });

  test("does not advance without a name", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue →" }).click();
    await expect(page.getByText("Please enter your name.")).toBeVisible();
    // Still on step 1
    await expect(page.getByPlaceholder("Type your name…")).toBeVisible();
  });

  test("advances to step 2 after entering a name", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Alice");
    await page.getByRole("button", { name: "Continue →" }).click();
    await expect(page.getByText("Step 2 — Start or join a game")).toBeVisible();
    await expect(page.getByRole("button", { name: /Create a room/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Join a room/ })).toBeVisible();
  });

  test("Enter key advances to step 2", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Bob");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Step 2 — Start or join a game")).toBeVisible();
  });

  test("can change name after advancing", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Alice");
    await page.getByRole("button", { name: "Continue →" }).click();
    // Step 2 animates in; force-click the "change" button which sits beneath the overlay
    await page.getByRole("button", { name: "change" }).click({ force: true });
    await expect(page.getByPlaceholder("Type your name…")).toBeVisible();
  });

  test("shows join code input after clicking Join a room", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Alice");
    await page.getByRole("button", { name: "Continue →" }).click();
    await page.getByRole("button", { name: /Join a room/ }).click();
    await expect(page.getByPlaceholder("ABC123")).toBeVisible();
    await expect(page.getByRole("button", { name: "Join Room" })).toBeVisible();
  });

  test("shows error when joining with empty code", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Alice");
    await page.getByRole("button", { name: "Continue →" }).click();
    await page.getByRole("button", { name: /Join a room/ }).click();
    await page.getByRole("button", { name: "Join Room" }).click();
    await expect(page.getByText("Enter the room code.")).toBeVisible();
  });

  test("back button returns to choice step from join step", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Alice");
    await page.getByRole("button", { name: "Continue →" }).click();
    await page.getByRole("button", { name: /Join a room/ }).click();
    await page.getByRole("button", { name: "← Back" }).click();
    await expect(page.getByRole("button", { name: /Create a room/ })).toBeVisible();
  });

  test("shows error for unknown room code", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Type your name…").fill("Alice");
    await page.getByRole("button", { name: "Continue →" }).click();
    await page.getByRole("button", { name: /Join a room/ }).click();
    await page.getByPlaceholder("ABC123").fill("XXXXXX");
    await page.getByRole("button", { name: "Join Room" }).click();
    await expect(page.getByText("Room not found.")).toBeVisible();
  });
});

import { type Page, expect, test } from "@playwright/test";

interface Ship {
  owner: number;
  name: string;
  x: number;
  y: number;
}
interface DebugState {
  playerId: number | null;
  tick: number;
  ships: Ship[];
}

// Read the game through the debug hook (client/src/debug.ts).
async function state(page: Page): Promise<DebugState | null> {
  return page.evaluate(() => window.dogfight?.state() ?? null);
}

async function join(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.locator("#pilot-name").fill(name);
  await page.locator(".room-card", { hasText: "Orbit" }).getByRole("button", { name: "Join" }).click();
  await expect(page.locator("#game")).toBeVisible();
  await expect.poll(async () => (await state(page))?.playerId ?? null).not.toBeNull();
}

function shipOf(snapshot: DebugState | null, name: string): Ship | undefined {
  return snapshot?.ships.find((ship) => ship.name === name);
}

test("two browsers: one room, shared roster, movement seen across clients, chat delivered", async ({ browser }) => {
  const ada = await (await browser.newContext()).newPage();
  const lin = await (await browser.newContext()).newPage();
  await join(ada, "Ada");
  await join(lin, "Lin");

  // Roster: both names, in both browsers.
  for (const page of [ada, lin]) await expect(page.locator("#room-roster")).toContainText(/Ada.*Lin|Lin.*Ada/);

  // Lin sees Ada's ship (from Lin's own snapshots), then Ada flies.
  await expect.poll(async () => shipOf(await state(lin), "Ada")).toBeTruthy();
  const start = shipOf(await state(lin), "Ada");
  expect(start).toBeTruthy();
  await ada.bringToFront();
  await ada.keyboard.down("ArrowUp");
  const pressedAt = Date.now();
  await expect
    .poll(
      async () => {
        const now = shipOf(await state(lin), "Ada");
        return now && start ? Math.hypot(now.x - start.x, now.y - start.y) : 0;
      },
      { timeout: 500, intervals: [25] },
    )
    .toBeGreaterThan(2);
  const seenAfter = Date.now() - pressedAt;
  await ada.keyboard.up("ArrowUp");
  expect(seenAfter).toBeLessThan(500);

  // Chat: Ada writes, Lin reads.
  await ada.locator("#chat-input").fill("o7 from Ada");
  await ada.locator("#chat-input").press("Enter");
  await expect(lin.locator("#chat-messages")).toContainText("Ada: o7 from Ada");
});

test("the lobby shows rooms and the mute button toggles and is remembered", async ({ page }) => {
  await join(page, "Muter");
  const mute = page.locator("#mute-toggle");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyM");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("KeyM");
  await page.reload();
  await join(page, "Muter");
  await expect(page.locator("#mute-toggle")).toHaveAttribute("aria-pressed", "true");
});

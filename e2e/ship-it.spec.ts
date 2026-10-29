import { expect, test } from "@playwright/test";

// Regression: creating a room from the lobby failed in the browser with
// "Failed to execute 'fetch' on 'Window': Illegal invocation".
test("a pilot creates their own room, it shows up in the lobby, and they can play in it", async ({ page }) => {
  const name = `Den ${Date.now() % 100000}`;
  await page.goto("/");
  await page.locator("#pilot-name").fill("Host");
  await page.locator("#room-name").fill(name);
  await page.locator("#room-size").selectOption("large");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#lobby-status")).toHaveText(`Created ${name}`);

  const card = page.locator(".room-card", { hasText: name });
  await expect(card).toContainText("1280×720");
  await card.getByRole("button", { name: "Join" }).click();
  await expect(page.locator("#game")).toBeVisible();
  await expect(page.locator("#room-roster")).toContainText("Host");
});

test("PWA: the manifest is valid and the service worker takes control", async ({ page, request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  const body: unknown = await manifest.json();
  expect(body).toMatchObject({ name: expect.any(String), start_url: "/", display: "fullscreen" });
  for (const size of ["192", "512"]) expect((await request.get(`/icons/icon-${size}.png`)).ok()).toBe(true);

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? null))
    .toBe("activated");
});

test("production endpoints answer through the real server", async ({ request }) => {
  expect((await request.get("/health")).ok()).toBe(true);
  expect((await request.get("/ready")).ok()).toBe(true);
  expect(await (await request.get("/metrics")).text()).toContain("dogfight_build_info");
});

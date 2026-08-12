import { test, expect, type Page } from "@playwright/test";

/**
 * Support flow end-to-end.
 *
 * These tests exercise the honest parts of the flow — session creation, the
 * server-authoritative watch accounting, and the refusal to settle an
 * unsatisfied session — without pretending to watch a real YouTube video in CI.
 * The player itself is third-party and network-dependent, so watch progress is
 * driven through the heartbeat API exactly as the client does.
 *
 * Requires the dev seed (`npm run prisma:seed`).
 */

const SUPPORTER = { username: "creator_2", password: "MemberPass2026!" };

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/auth/login");
  await page.getByLabel("ایمیل یا نام کاربری").fill(username);
  await page.getByLabel("رمز عبور").fill(password);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/(explore|dashboard)/);
}

async function csrfToken(page: Page) {
  const cookies = await page.context().cookies();
  const cookie = cookies.find((entry) => entry.name === "academy_csrf");
  expect(cookie, "CSRF cookie must be present after sign-in").toBeTruthy();
  return decodeURIComponent(cookie!.value);
}

/** Picks a campaign the signed-in user does not own, via the public feed. */
async function pickForeignCampaign(page: Page, username: string) {
  const response = await page.request.get("/api/v1/explore?filter=new&limit=24");
  const body = await response.json();
  const items = body.data.items as { campaignId: string; creator: { username: string } }[];
  const item = items.find((entry) => entry.creator.username !== username);
  expect(item, "the seed must provide at least one campaign from another creator").toBeTruthy();
  return item!.campaignId;
}

test.describe("support session", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPPORTER.username, SUPPORTER.password);
  });

  test("opening the support flow starts a session and shows the honest verification labels", async ({ page }) => {
    await page.goto("/explore");
    // The first card belonging to another creator exposes a start button.
    const startButton = page.getByRole("button", { name: /حمایت/ }).first();
    await expect(startButton).toBeVisible();
    await startButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("پیشرفت تماشا")).toBeVisible();
    // The platform must not claim YouTube verified the watch.
    await expect(dialog.getByText("ثبت‌شده توسط پلتفرم").first()).toBeVisible();
    await expect(dialog.getByText("تأییدشده توسط یوتیوب")).toHaveCount(0);

    // Settlement is disabled until verification actually passes.
    await expect(dialog.getByRole("button", { name: "ثبت حمایت" })).toBeDisabled();

    // Escape closes the modal and focus returns to the page.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("a self-support attempt is refused by the server", async ({ page }) => {
    const own = await page.request.get("/api/v1/explore?filter=new&limit=24");
    const items = (await own.json()).data.items as { campaignId: string; creator: { username: string } }[];
    const mine = items.find((entry) => entry.creator.username === SUPPORTER.username);
    expect(mine, "the deterministic seed must expose this user's own campaign").toBeTruthy();

    const response = await page.request.post("/api/v1/support/sessions", {
      headers: { "x-csrf-token": await csrfToken(page) },
      data: { campaignId: mine!.campaignId },
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  test("seeking to the end credits no watch time", async ({ page }) => {
    const campaignId = await pickForeignCampaign(page, SUPPORTER.username);
    const token = await csrfToken(page);

    const started = await page.request.post("/api/v1/support/sessions", {
      headers: { "x-csrf-token": token },
      data: { campaignId },
    });
    expect(started.ok()).toBeTruthy();
    const session = (await started.json()).data as { sessionId: string; requiredWatchSeconds: number };

    // Claim a large jump immediately: physically impossible, so it earns nothing.
    const heartbeat = await page.request.post("/api/v1/support/heartbeat", {
      headers: { "x-csrf-token": token },
      data: { sessionId: session.sessionId, position: 600, playerState: "PLAYING", sequence: 1 },
    });
    expect(heartbeat.ok()).toBeTruthy();
    const watch = (await heartbeat.json()).data as { accumulatedSec: number; satisfied: boolean };
    expect(watch.accumulatedSec).toBe(0);
    expect(watch.satisfied).toBe(false);

    // And settlement is refused.
    const complete = await page.request.post("/api/v1/support/complete", {
      headers: { "x-csrf-token": token },
      data: { sessionId: session.sessionId },
    });
    expect(complete.ok()).toBeFalsy();
  });

  test("the heartbeat endpoint rejects another user's session", async ({ page, browser }) => {
    const campaignId = await pickForeignCampaign(page, SUPPORTER.username);
    const started = await page.request.post("/api/v1/support/sessions", {
      headers: { "x-csrf-token": await csrfToken(page) },
      data: { campaignId },
    });
    const session = (await started.json()).data as { sessionId: string };

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signIn(otherPage, "creator_3", "MemberPass2026!");
    const response = await otherPage.request.post("/api/v1/support/heartbeat", {
      headers: { "x-csrf-token": await csrfToken(otherPage) },
      data: { sessionId: session.sessionId, position: 10, playerState: "PLAYING", sequence: 1 },
    });
    // Ownership is checked server-side, not inferred from the client.
    expect([403, 404]).toContain(response.status());
    await otherContext.close();
  });

  test("the support history page renders the member's own sessions", async ({ page }) => {
    await page.goto("/support/history");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("تاریخچه حمایت");
    await expect(page.locator("pre")).toHaveCount(0);
  });
});

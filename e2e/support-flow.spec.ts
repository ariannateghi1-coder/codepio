import { test, expect, type Page } from "@playwright/test";

/**
 * Support flow end-to-end.
 *
 * These tests exercise the honest parts of the flow — session creation, the
 * server-authoritative watch timer, and the refusal to settle an unsatisfied
 * session — without pretending to watch a real YouTube video in CI.
 *
 * The video is watched on youtube.com, so there is no player to drive here. What
 * CAN be tested without leaving the app is the part that decides the reward: the
 * timer anchor lives on the server, so a session that was just opened must report
 * time remaining and must refuse to settle.
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
    await expect(dialog.getByRole("button", { name: /تماشا در یوتیوب/ })).toBeVisible();
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

  test("the watch timer cannot be short-circuited by the client", async ({ page }) => {
    const campaignId = await pickForeignCampaign(page, SUPPORTER.username);
    const token = await csrfToken(page);

    const started = await page.request.post("/api/v1/support/sessions", {
      headers: { "x-csrf-token": token },
      data: { campaignId },
    });
    expect(started.ok()).toBeTruthy();
    const session = (await started.json()).data as {
      sessionId: string;
      requiredWatchSeconds: number;
      openedAt: string | null;
    };
    expect(session.openedAt).toBeNull();

    // Open it, then immediately send every field a client might hope the server
    // trusts. The schema takes only sessionId, so all of this is discarded.
    const opened = await page.request.post("/api/v1/support/watch", {
      headers: { "x-csrf-token": token },
      data: {
        sessionId: session.sessionId,
        elapsedSec: 99_999,
        completed: true,
        requiredSec: 1,
        openedAt: "1999-01-01T00:00:00.000Z",
      },
    });
    expect(opened.ok()).toBeTruthy();
    const first = (await opened.json()).data as {
      requiredSec: number;
      remainingSec: number;
      satisfied: boolean;
      openedAt: string;
    };
    expect(first.satisfied).toBe(false);
    expect(first.requiredSec).toBe(session.requiredWatchSeconds);
    expect(first.remainingSec).toBeGreaterThan(0);

    // Opening again must reuse the same anchor: a refresh cannot restart the clock.
    const reopened = await page.request.post("/api/v1/support/watch", {
      headers: { "x-csrf-token": token },
      data: { sessionId: session.sessionId },
    });
    const second = (await reopened.json()).data as { openedAt: string; satisfied: boolean };
    expect(second.openedAt).toBe(first.openedAt);
    expect(second.satisfied).toBe(false);

    // Polling the status repeatedly credits nothing extra.
    for (let i = 0; i < 3; i += 1) {
      const status = await page.request.patch("/api/v1/support/watch", {
        headers: { "x-csrf-token": token },
        data: { sessionId: session.sessionId },
      });
      const body = (await status.json()).data as { satisfied: boolean; elapsedSec: number };
      expect(body.satisfied).toBe(false);
      expect(body.elapsedSec).toBeLessThan(session.requiredWatchSeconds);
    }

    // And settlement is refused while time remains.
    const complete = await page.request.post("/api/v1/support/complete", {
      headers: { "x-csrf-token": token },
      data: { sessionId: session.sessionId },
    });
    expect(complete.ok()).toBeFalsy();
  });

  test("the watch endpoint rejects another user's session", async ({ page, browser }) => {
    const campaignId = await pickForeignCampaign(page, SUPPORTER.username);
    const started = await page.request.post("/api/v1/support/sessions", {
      headers: { "x-csrf-token": await csrfToken(page) },
      data: { campaignId },
    });
    const session = (await started.json()).data as { sessionId: string };

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signIn(otherPage, "creator_3", "MemberPass2026!");
    const response = await otherPage.request.post("/api/v1/support/watch", {
      headers: { "x-csrf-token": await csrfToken(otherPage) },
      data: { sessionId: session.sessionId },
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

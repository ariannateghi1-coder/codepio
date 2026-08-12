import { test, expect } from "@playwright/test";

/**
 * Public smoke tests: the pages a first-time visitor can reach without an account.
 * These are deliberately shallow — they catch a broken build, a failed render or a
 * missing landmark, not business behaviour.
 */

test("the landing page renders its value proposition and entry points", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "شروع رایگان" })).toBeVisible();
  await expect(page.getByRole("link", { name: "دیدن کاوش" })).toBeVisible();
});

test("explore is publicly reachable and renders its filter control", async ({ page }) => {
  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "کاوش", level: 1 })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "فیلتر کاوش" })).toBeVisible();
  await expect(page.getByLabel("جست‌وجو در کاوش")).toBeVisible();
});

test("the leaderboard and member directory render for a guest", async ({ page }) => {
  await page.goto("/leaderboard");
  await expect(page.getByRole("heading", { name: "رتبه‌بندی", level: 1 })).toBeVisible();

  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "اعضا", level: 1 })).toBeVisible();
});

test("the badge catalogue renders", async ({ page }) => {
  await page.goto("/badges");
  await expect(page.getByRole("heading", { name: "نشان‌ها", level: 1 })).toBeVisible();
});

test("an unknown route returns the 404 page rather than an error", async ({ page }) => {
  await page.goto("/this-route-does-not-exist");
  await expect(page.getByRole("heading", { name: "این صفحه پیدا نشد" })).toBeVisible();
});

test("protected routes bounce a guest to login with a safe next parameter", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/auth\/login\?next=%2Fdashboard/);
});

test("the health endpoint reports database connectivity", async ({ request }) => {
  const response = await request.get("/api/v1/health");
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data).toHaveProperty("database");
});

test("every page exposes a skip link as the first tab stop", async ({ page }) => {
  await page.goto("/explore");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "پرش به محتوای اصلی" })).toBeFocused();
});

test("the API rejects an unauthenticated request with the standard envelope", async ({ request }) => {
  const response = await request.get("/api/v1/dashboard");
  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body.success).toBe(false);
  expect(body.error.code).toBe("UNAUTHORIZED");
  // The envelope carries a request id for correlation with the server log.
  expect(body).toHaveProperty("requestId");
});

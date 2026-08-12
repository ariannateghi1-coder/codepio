import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Admin end-to-end. Relies on the seeded super admin from prisma/seed.ts
 * (`npm run prisma:seed`).
 *
 * The primary assertion is the authorization boundary: a signed-in ordinary
 * member must not reach the admin tree, and the API must refuse it even when the
 * page guard is bypassed by calling the endpoint directly.
 */

const SUPER_ADMIN = { username: "admin", password: "AdminPass2026!" };
const MEMBER = { username: "creator_1", password: "MemberPass2026!" };

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/auth/login");
  await page.getByLabel("ایمیل یا نام کاربری").fill(username);
  await page.getByLabel("رمز عبور").fill(password);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/(explore|dashboard)/);
}

async function contextFor(browser: Browser, username: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, username, password);
  return { context, page };
}

test.describe("admin console", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SUPER_ADMIN.username, SUPER_ADMIN.password);
  });

  test("the overview renders real metrics as UI, not a JSON dump", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "کنسول مدیریت", level: 1 })).toBeVisible();
    // Regression guard: the old panel rendered raw JSON in a <pre>.
    await expect(page.locator("pre")).toHaveCount(0);
  });

  test("the users table renders rows with real controls", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "کاربران", level: 1 })).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("creator_1").first()).toBeVisible();
  });

  test("every admin section renders", async ({ page }) => {
    for (const [path, heading] of [
      ["/admin/supports", "حمایت‌ها"],
      ["/admin/campaigns", "کمپین‌ها"],
      ["/admin/reports", "گزارش‌ها"],
      ["/admin/audit", "گزارش عملیات"],
      ["/admin/notifications", "اعلان‌ها"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      await expect(page.locator("pre")).toHaveCount(0);
    }
  });

  test("the admin cannot act on their own account", async ({ page }) => {
    // Self-modification is refused by the authorization layer regardless of UI.
    const response = await page.request.get("/api/v1/auth/me");
    const me = await response.json();
    const selfId = me.data.user.id as string;

    const cookies = await page.context().cookies();
    const csrf = cookies.find((cookie) => cookie.name === "academy_csrf");
    const patch = await page.request.patch("/api/v1/admin/users", {
      headers: { "x-csrf-token": decodeURIComponent(csrf!.value) },
      data: { userId: selfId, status: "SUSPENDED" },
    });
    expect(patch.status()).toBe(403);
  });
});

test.describe("admin authorization boundary", () => {
  test("an ordinary member is redirected away from the admin tree", async ({ browser }) => {
    const member = await contextFor(browser, MEMBER.username, MEMBER.password);
    await member.page.goto("/admin/users");
    await expect(member.page).toHaveURL(/\/dashboard/);
    await member.context.close();
  });

  test("an ordinary member is refused by the admin API directly", async ({ browser }) => {
    const member = await contextFor(browser, MEMBER.username, MEMBER.password);
    const response = await member.page.request.get("/api/v1/admin/users");
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
    await member.context.close();
  });

  test("a guest is sent to login rather than shown the admin shell", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test("a write to an admin endpoint without CSRF is refused", async ({ browser }) => {
    const admin = await contextFor(browser, SUPER_ADMIN.username, SUPER_ADMIN.password);
    const response = await admin.page.request.patch("/api/v1/admin/users", {
      data: { userId: "someone", status: "SUSPENDED" },
    });
    expect(response.status()).toBe(403);
    await admin.context.close();
  });
});

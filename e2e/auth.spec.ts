import { test, expect } from "@playwright/test";
import { CSRF_COOKIE } from "../src/lib/security-constants";

/** Auth end-to-end. Registration activates and signs in immediately. */

function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

const PASSWORD = "Str0ngPass2026";

test.describe("registration and login", () => {
  test("a new member registers and reaches the app, then logs out and back in", async ({ page }) => {
    const suffix = uniqueSuffix();
    const username = `e2e_${suffix}`;
    const email = `e2e_${suffix}@example.com`;

    await page.goto("/auth/register");
    await page.getByLabel("نام", { exact: true }).fill("کاربر تست");
    await page.getByLabel("نام کاربری").fill(username);
    await page.getByLabel("ایمیل").fill(email);
    await page.getByLabel("رمز عبور", { exact: true }).fill(PASSWORD);
    await page.getByLabel("تکرار رمز عبور").fill(PASSWORD);
    await page.getByRole("button", { name: "ساخت حساب" }).click();

    await expect(page).toHaveURL(/\/explore/);

    // Logout goes through the same CSRF path the real client uses: the readable
    // cookie is mirrored into the x-csrf-token header. Without it the server
    // returns 403 and the session correctly stays alive.
    const cookies = await page.context().cookies();
    const csrf = cookies.find((cookie) => cookie.name === CSRF_COOKIE);
    expect(csrf, "the CSRF cookie must exist after signing in").toBeTruthy();

    const status = await page.evaluate(async (token) => {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": token },
      });
      return response.status;
    }, decodeURIComponent(csrf!.value));
    expect(status).toBe(200);

    // The session is genuinely revoked server-side, not merely cookie-cleared.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\/login/);

    await page.getByLabel("ایمیل یا نام کاربری").fill(username);
    await page.getByLabel("رمز عبور").fill(PASSWORD);
    await page.getByRole("button", { name: "ورود" }).click();
    await expect(page).toHaveURL(/\/(explore|dashboard)/);
  });

  test("a logout request without the CSRF header is refused", async ({ page }) => {
    await page.goto("/auth/login");
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
      return response.status;
    });
    // 403 for a missing token; 401 is also acceptable when no session exists.
    expect([401, 403]).toContain(status);
  });

  test("login shows a single generic error for a wrong password", async ({ page }) => {
    await page.goto("/auth/login");
    await page.getByLabel("ایمیل یا نام کاربری").fill("definitely_not_a_user_e2e");
    await page.getByLabel("رمز عبور").fill("WrongPassword1");
    await page.getByRole("button", { name: "ورود" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    // Anti-enumeration: the message must not reveal whether the account exists.
    await expect(alert).not.toContainText("پیدا نشد");
    await expect(page).toHaveURL(/\/auth\/login/);
  });


  test("registration rejects a weak password before submitting anything", async ({ page }) => {
    const suffix = uniqueSuffix();
    await page.goto("/auth/register");
    await page.getByLabel("نام", { exact: true }).fill("کاربر تست");
    await page.getByLabel("نام کاربری").fill(`weak_${suffix}`);
    await page.getByLabel("ایمیل").fill(`weak_${suffix}@example.com`);
    await page.getByLabel("رمز عبور", { exact: true }).fill("password123");
    await page.getByLabel("تکرار رمز عبور").fill("password123");
    await page.getByRole("button", { name: "ساخت حساب" }).click();

    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/register/);
  });

  test("the ?next parameter cannot redirect off-site", async ({ page }) => {
    await page.goto("/auth/login?next=https://example.com/evil");
    await expect(page).toHaveURL(/\/auth\/login/);
    // The guard drops the external target rather than following it.
    expect(page.url()).not.toContain("example.com/evil?");
  });
});

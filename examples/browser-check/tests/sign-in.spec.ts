import { expect, test } from "@playwright/test";

/**
 * Signs in the way a person would and checks that the page behind the sign-in shows what it should. Each test.step is
 * one name in the failure report, so keep them short and in the words of the people who use the site.
 *
 * Set in CI (as secrets): BASE_URL, LOGIN_EMAIL, LOGIN_PASSWORD. Optional: LOGIN_PATH (default /login), and
 * EXPECT_TEXT, a text the signed-in page always shows (default: the page simply leaves the sign-in form).
 */
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

test("sign in and reach the dashboard", async ({ page }) => {
  const email = need("LOGIN_EMAIL");
  const password = need("LOGIN_PASSWORD");
  need("BASE_URL");

  const loginPath = process.env.LOGIN_PATH ?? "/login";

  await test.step("Open the sign-in page", async () => {
    const res = await page.goto(loginPath);
    expect(res?.status(), "sign-in page status").toBeLessThan(400);
    await expect(page.getByLabel(/email/i)).toBeVisible();
  });

  await test.step("Sign in", async () => {
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    // still on the sign-in page after 15 s means it did not go through, even if every request returned 200.
    // (This waits on the address, not on the password field: a failed assertion on the field would print the typed value.)
    await page.waitForURL((u) => u.pathname !== loginPath, { timeout: 15_000 });
  });

  await test.step("See the signed-in page", async () => {
    if (process.env.EXPECT_TEXT) await expect(page.getByText(process.env.EXPECT_TEXT).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/something went wrong|internal server error/i)).toHaveCount(0);
  });
});

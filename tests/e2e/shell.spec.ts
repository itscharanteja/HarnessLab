import { expect, test } from "@playwright/test";

test("the local dashboard labels the fixture mode", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "HarnessLab", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fixture model", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Development only", { exact: true }).first(),
  ).toBeVisible();
});

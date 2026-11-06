import { expect, test } from "@playwright/test";

test("the local web shell identifies fixture mode", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "HarnessLab" })).toBeVisible();
  await expect(page.getByText("Fixture mode")).toBeVisible();
});

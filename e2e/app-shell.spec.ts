import { test, expect } from '@playwright/test';

test.describe('App Shell & Navigation', () => {
  test('loads clinical planning workspace with brand and 3D canvas', async ({ page }) => {
    await page.goto('/');

    // Check header brand
    await expect(page.locator('.brand')).toContainText('Platanus');
    await expect(page.locator('.brand')).toContainText('Implant planning');
    await expect(page.locator('.brand-mark img')).toBeVisible();

    // Check main actions
    await expect(page.locator('.patient-mode-toggle')).toHaveCount(0);
    await expect(page.locator('.theme-toggle')).toBeVisible();
    await expect(page.locator('button:has-text("Add files")')).toBeVisible();
    await expect(page.locator('.header-actions button:has-text("CBCT")')).toBeVisible();

    // Check 3D canvas viewport exists
    await expect(page.locator('.canvas-host canvas')).toBeVisible();
  });

  test('navigates to patient view via URL and back to doctor workspace', async ({ page }) => {
    // Patient view is accessible strictly via URL hash (#patient) or query param
    await page.goto('/#patient');

    // Verify Patient Medical Sheet mounted
    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toContainText('Informe para');
    expect(page.url()).toContain('#patient');

    // Switch back to Modo Doctor
    await page.click('button:has-text("Modo Doctor")');

    // Verify returned to Clinical Planning
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('.patient-mode-toggle')).toHaveCount(0);
  });

  test('toggles dark mode theme and sets data-theme attribute on root', async ({ page }) => {
    await page.goto('/');

    const themeToggle = page.locator('.theme-toggle');
    await expect(themeToggle).toBeVisible();

    // Toggle theme
    await themeToggle.click();

    // Verify root html has data-theme attribute set
    const html = page.locator('html');
    const themeAttr = await html.getAttribute('data-theme');
    expect(themeAttr).toMatch(/dark|light/);

    // Toggle back
    await themeToggle.click();
    const nextThemeAttr = await html.getAttribute('data-theme');
    expect(nextThemeAttr).not.toBe(themeAttr);
  });
});

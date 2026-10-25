import { test, expect } from '@playwright/test';

test.describe('App Shell & Navigation', () => {
  test('loads clinical planning workspace with brand and 3D canvas', async ({ page }) => {
    await page.goto('/');

    // Check header brand
    await expect(page.locator('.brand')).toContainText('Platanus');
    await expect(page.locator('.brand')).toContainText('Implant planning');

    // Check main actions
    await expect(page.locator('.patient-mode-toggle')).toBeVisible();
    await expect(page.locator('button:has-text("Add files")')).toBeVisible();
    await expect(page.locator('.header-actions button:has-text("CBCT")')).toBeVisible();

    // Check 3D canvas viewport exists
    await expect(page.locator('.canvas-host canvas')).toBeVisible();
  });

  test('switches from clinical planning to patient view and back', async ({ page }) => {
    await page.goto('/');

    // Click Vista Paciente
    await page.click('.patient-mode-toggle');

    // Verify Patient View mounted
    await expect(page.locator('.patient-container')).toBeVisible();
    await expect(page.locator('.patient-title-group h1')).toContainText('Plan de Tratamiento');
    expect(page.url()).toContain('#patient');

    // Switch back to Modo Especialista
    await page.click('button:has-text("Modo Especialista")');

    // Verify returned to Clinical Planning
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('.patient-mode-toggle')).toBeVisible();
  });
});

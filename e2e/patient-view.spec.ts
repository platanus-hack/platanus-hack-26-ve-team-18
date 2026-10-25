import { test, expect } from '@playwright/test';

test.describe('Patient Consultation View', () => {
  test('direct navigation via #patient hash renders patient portal', async ({ page }) => {
    await page.goto('/#patient');

    // Verify patient container is displayed immediately
    await expect(page.locator('.patient-container')).toBeVisible();
    await expect(page.locator('.stage-viewport-wrapper')).toBeVisible();
    await expect(page.locator('.odontogram-container')).toBeVisible();
  });

  test('odontogram renders all 32 FDI teeth and selecting updates consultation details', async ({ page }) => {
    await page.goto('/#patient');

    // Check odontogram rows (upper and lower)
    const upperRow = page.locator('.arch-row.row-upper');
    const lowerRow = page.locator('.arch-row.row-lower');
    await expect(upperRow).toBeVisible();
    await expect(lowerRow).toBeVisible();

    // Check that there are 32 tooth buttons
    const toothButtons = page.locator('.tooth-btn');
    await expect(toothButtons).toHaveCount(32);

    // Click tooth FDI 21 (Upper left central incisor)
    const tooth21 = page.locator('button[aria-label="Diente FDI 21"]');
    await tooth21.click();
    await expect(tooth21).toHaveClass(/selected/);

    // Verify consultation card updates
    const title = page.locator('.tooth-name-title');
    await expect(title).toContainText('FDI 21');
    await expect(title).toContainText('Incisivo Central');

    // Click tooth FDI 46 (Lower right first molar)
    const tooth46 = page.locator('button[aria-label="Diente FDI 46"]');
    await tooth46.click();
    await expect(tooth46).toHaveClass(/selected/);
    await expect(title).toContainText('FDI 46');
    await expect(title).toContainText('Primer Molar');
  });

  test('layer toggles allow switching visibility of arches, crowns, and implants', async ({ page }) => {
    await page.goto('/#patient');

    const archToggle = page.locator('label:has-text("Tus dientes") input[type="checkbox"]');
    const crownToggle = page.locator('label:has-text("Corona de circonio") input[type="checkbox"]');
    const implantToggle = page.locator('label:has-text("Implante de titanio") input[type="checkbox"]');

    await expect(archToggle).toBeChecked();
    await expect(crownToggle).toBeChecked();
    await expect(implantToggle).toBeChecked();

    // Toggle off arches
    await archToggle.uncheck();
    await expect(archToggle).not.toBeChecked();

    // Toggle back on
    await archToggle.check();
    await expect(archToggle).toBeChecked();
  });

  test('whatsapp and sharing buttons are configured', async ({ page }) => {
    await page.goto('/#patient');

    // Check WhatsApp link has wa.me scheme
    const waLink = page.locator('a.patient-btn-whatsapp').first();
    await expect(waLink).toBeVisible();
    const href = await waLink.getAttribute('href');
    expect(href).toContain('https://wa.me/?text=');

    // Check Share button
    const shareBtn = page.locator('button:has-text("Compartir Enlace")');
    await expect(shareBtn).toBeVisible();
  });
});

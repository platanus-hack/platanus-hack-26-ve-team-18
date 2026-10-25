import { test, expect } from '@playwright/test';

test.describe('Patient Consultation View', () => {
  test('direct navigation via #patient hash renders patient medical sheet with pre-loaded demo', async ({ page }) => {
    await page.goto('/#patient');

    // Verify patient medical sheet is displayed immediately
    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toContainText('Informe para Sofia M.');
    await expect(page.locator('.patient-viewport-box')).toBeVisible();
    await expect(page.locator('.odontogram-container')).toBeVisible();

    // Verify photos card is rendered
    await expect(page.locator('.patient-photos img')).toHaveCount(3);
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
    const title = page.locator('.tooth-detail strong');
    await expect(title).toContainText('FDI 21');
    await expect(title).toContainText('Incisivo Central');

    // Click tooth FDI 46 (Lower right first molar)
    const tooth46 = page.locator('button[aria-label="Diente FDI 46"]');
    await tooth46.click();
    await expect(tooth46).toHaveClass(/selected/);
    await expect(title).toContainText('FDI 46');
    await expect(title).toContainText('Primer Molar');
  });

  test('layer toggles allow switching visibility of dental arches', async ({ page }) => {
    await page.goto('/#patient');

    const archToggle = page.locator('label:has-text("Tus dientes") input[type="checkbox"]');
    await expect(archToggle).toBeChecked();

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
    const waLink = page.locator('a.whatsapp-btn').first();
    await expect(waLink).toBeVisible();
    const href = await waLink.getAttribute('href');
    expect(href).toContain('https://wa.me/?text=');

    // Check Share button
    const shareBtn = page.locator('button:has-text("Compartir")').first();
    await expect(shareBtn).toBeVisible();
  });

  test('navigates to patient view using query param ?view=patient', async ({ page }) => {
    await page.goto('/?view=patient');

    // Verify Patient Medical Sheet is mounted via query param
    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toContainText('Informe para Sofia M.');
    await expect(page.locator('.patient-viewport-box')).toBeVisible();
  });

  test('footer "Modo Especialista" button returns to doctor workspace', async ({ page }) => {
    await page.goto('/#patient');

    await expect(page.locator('.patient-shell')).toBeVisible();

    // Click Modo Especialista link in footer
    const specialistBtn = page.locator('.patient-footer button:has-text("Modo Especialista")');
    await specialistBtn.scrollIntoViewIfNeeded();
    await specialistBtn.click();

    // Verify back in clinical workspace
    await expect(page.locator('.workspace')).toBeVisible();
  });

  test('renders responsively and supports tooth interactions on mobile viewport', async ({ page }) => {
    // Set mobile viewport (iPhone 14 / modern smartphone)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#patient');

    // Verify header and 3D canvas on mobile
    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toBeVisible();
    await expect(page.locator('.patient-viewport-box canvas')).toBeVisible();

    // Verify odontogram is interactive on mobile
    const tooth11 = page.locator('button[aria-label="Diente FDI 11"]');
    await tooth11.scrollIntoViewIfNeeded();
    await tooth11.click();
    await expect(tooth11).toHaveClass(/selected/);

    // Verify tooth detail card shows Spanish naming
    const title = page.locator('.tooth-detail strong');
    await expect(title).toContainText('FDI 11');
    await expect(title).toContainText('Incisivo Central Superior Derecho');

    // Check photos card renders on mobile
    await expect(page.locator('.patient-photos')).toBeVisible();
  });
});

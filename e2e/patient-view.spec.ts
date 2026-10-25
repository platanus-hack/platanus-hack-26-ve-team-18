import { test, expect, type Page } from '@playwright/test';

function trackDemoRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/patient-demo/')) requests.push(request.url());
  });
  return requests;
}

async function expectNoDemoData(page: Page) {
  await expect(page.locator('.patient-photos img')).toHaveCount(0);
  await expect(page.locator('img[src*="/patient-demo/"]')).toHaveCount(0);
  await expect(page.getByText('Demostración · datos de ejemplo', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Diagnóstico Oclusal & Escaneo 3D', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Evaluación Periodontal & Estética', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Protocolo Preventivo & Mantenimiento', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Métricas de tu caso:|78\.4\s*mm|34\.2\s*mm/)).toHaveCount(0);
  await expect(page.getByText(/Ambas arcadas \(superior e inferior\) presentan adecuada alineación/)).toHaveCount(0);
  await expect(page.getByText(/Pieza dental natural en posición anatómica armónica/)).toHaveCount(0);
  await expect(page.locator('.tooth-btn.status-present')).toHaveCount(0);
}

test.describe('Patient Consultation View', () => {
  test('direct navigation via #patient starts empty without requesting demo assets', async ({ page }) => {
    const demoRequests = trackDemoRequests(page);
    await page.goto('/#patient');

    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toHaveText('Informe para Paciente');
    await expect(page.getByText('Sin escaneos importados')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cargar demostración', exact: true })).toBeVisible();
    await expect(page.locator('.patient-viewport-box')).toBeVisible();
    await expect(page.locator('.odontogram-container')).toBeVisible();

    await expectNoDemoData(page);
    expect(demoRequests).toEqual([]);
  });

  test('odontogram renders all 32 FDI teeth and selecting updates consultation details', async ({ page }) => {
    const demoRequests = trackDemoRequests(page);
    await page.goto('/#patient');
    await expect(page.locator('.patient-header h1')).toHaveText('Informe para Paciente');
    expect(demoRequests).toEqual([]);
    await page.getByRole('button', { name: 'Cargar demostración', exact: true }).click();
    await expect(page.getByText('Demostración · datos de ejemplo', { exact: true })).toBeVisible();
    await expect(page.locator('.patient-header h1')).toHaveText('Informe para Sofia M.');
    await expect(page.locator('.patient-photos img')).toHaveCount(3);
    await expect.poll(() => demoRequests.map(url => new URL(url).pathname)).toEqual(expect.arrayContaining([
      '/patient-demo/upper.ply',
      '/patient-demo/upper.jpg',
      '/patient-demo/lower.ply',
      '/patient-demo/lower.jpg',
    ]));

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

  test('layer toggles allow switching imported scan visibility without demo data', async ({ page }) => {
    const demoRequests = trackDemoRequests(page);
    await page.goto('/');
    await page.getByLabel('Import 3D files').setInputFiles({
      name: 'local-scan.obj',
      mimeType: 'text/plain',
      buffer: Buffer.from([
        'o local-scan',
        'v 0 0 0',
        'v 10 0 0',
        'v 0 10 0',
        'v 0 0 10',
        'f 1 3 2',
        'f 1 2 4',
        'f 2 3 4',
        'f 3 1 4',
      ].join('\n')),
    });
    await expect(page.locator('.part-name')).toHaveText('local-scan');

    // Keep the locally imported case in memory when entering patient view.
    await page.evaluate(() => { window.location.hash = 'patient'; });
    await expect(page.locator('.patient-header h1')).toHaveText('Informe para Paciente');
    await expect(page.getByRole('heading', { name: /Escaneos importados/ })).toBeVisible();
    await expect(page.getByText('Sin escaneos importados')).toHaveCount(0);
    await expect(page.locator('.patient-viewport-box canvas')).toBeVisible();
    await expectNoDemoData(page);

    const archToggle = page.locator('label:has-text("Tus dientes") input[type="checkbox"]');
    await expect(archToggle).toBeChecked();

    // Toggle off arches
    await archToggle.uncheck();
    await expect(archToggle).not.toBeChecked();

    // Toggle back on
    await archToggle.check();
    await expect(archToggle).toBeChecked();
    expect(demoRequests).toEqual([]);
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

  test('query param ?view=patient starts empty without requesting demo assets', async ({ page }) => {
    const demoRequests = trackDemoRequests(page);
    await page.goto('/?view=patient');

    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toHaveText('Informe para Paciente');
    await expect(page.getByText('Sin escaneos importados')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cargar demostración', exact: true })).toBeVisible();
    await expect(page.locator('.patient-viewport-box')).toBeVisible();
    await expectNoDemoData(page);
    expect(demoRequests).toEqual([]);
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
    await page.getByRole('button', { name: 'Cargar demostración', exact: true }).click();
    await expect(page.getByText('Demostración · datos de ejemplo', { exact: true })).toBeVisible();

    // Verify header and 3D canvas on mobile
    await expect(page.locator('.patient-shell')).toBeVisible();
    await expect(page.locator('.patient-header h1')).toHaveText('Informe para Sofia M.');
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
    await expect(page.locator('.patient-photos img')).toHaveCount(3);
  });
});

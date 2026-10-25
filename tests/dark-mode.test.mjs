import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('clinical titanium dark mode architecture is complete and loaded', () => {
  const rootDir = process.cwd();
  const darkModeCssPath = path.join(rootDir, 'src', 'dark-mode.css');
  const mainTsxPath = path.join(rootDir, 'src', 'main.tsx');
  const indexHtmlPath = path.join(rootDir, 'index.html');

  assert.ok(fs.existsSync(darkModeCssPath), 'src/dark-mode.css must exist');
  const darkModeCss = fs.readFileSync(darkModeCssPath, 'utf8');

  // Verify main.tsx imports dark-mode.css
  const mainTsx = fs.readFileSync(mainTsxPath, 'utf8');
  assert.ok(mainTsx.includes('./dark-mode.css'), 'src/main.tsx must import dark-mode.css');

  // Verify index.html dark theme-color and immediate inline script
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  assert.ok(indexHtml.includes('#0c1017'), 'index.html must set titanium dark theme-color');
  assert.ok(indexHtml.includes('ceflow-theme'), 'index.html must include zero-flash theme initialization script');

  // Verify core clinical components are covered in dark mode
  const requiredSelectors = [
    "[data-theme='dark'] .sidebar",
    "[data-theme='dark'] .viewport",
    "[data-theme='dark'] .planning-scene .viewport",
    "[data-theme='dark'] .workflow-steps",
    "[data-theme='dark'] .process-panel",
    "[data-theme='dark'] .tooth-panel",
    "[data-theme='dark'] .assistant-panel",
    "[data-theme='dark'] .auto-teeth-panel",
    "[data-theme='dark'] .restoration-panel",
    "[data-theme='dark'] .planning-panel",
    "[data-theme='dark'] .tomography-panel",
    "[data-theme='dark'] .cbct-overlay-controls",
    "[data-theme='dark'] .scene-visibility",
    "[data-theme='dark'] .compact-camera",
    "[data-theme='dark'] select",
    "[data-theme='dark'] textarea",
  ];

  for (const selector of requiredSelectors) {
    assert.ok(
      darkModeCss.includes(selector),
      `src/dark-mode.css must define dark styles for ${selector}`
    );
  }

  // Verify titanium palette variables
  assert.ok(darkModeCss.includes('--theme-paper: #0c1017;'), 'Dark theme must define titanium obsidian paper');
  assert.ok(darkModeCss.includes('--theme-surface: #131822;'), 'Dark theme must define surgical surface');
  assert.ok(darkModeCss.includes('--theme-surface-elevated: #1a2230;'), 'Dark theme must define elevated surface');
  assert.ok(darkModeCss.includes('--theme-border: #212c3d;'), 'Dark theme must define hairline border');
  assert.ok(darkModeCss.includes('--theme-ink: #f0f4f8;'), 'Dark theme must define platinum ink');
  assert.ok(darkModeCss.includes('--theme-blue: #2c6ee8;'), 'Dark theme must define diagnostic sapphire');
});

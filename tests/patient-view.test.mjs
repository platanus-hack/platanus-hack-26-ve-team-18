import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toothNameEs } from '../src/teeth.ts';

test('toothNameEs maps all 32 FDI tooth codes to correct Spanish anatomical names', () => {
  // Quadrant 1: Upper Right
  assert.equal(toothNameEs(11), 'Incisivo Central Superior Derecho');
  assert.equal(toothNameEs(12), 'Incisivo Lateral Superior Derecho');
  assert.equal(toothNameEs(13), 'Canino Superior Derecho');
  assert.equal(toothNameEs(14), 'Primer Premolar Superior Derecho');
  assert.equal(toothNameEs(15), 'Segundo Premolar Superior Derecho');
  assert.equal(toothNameEs(16), 'Primer Molar Superior Derecho');
  assert.equal(toothNameEs(17), 'Segundo Molar Superior Derecho');
  assert.equal(toothNameEs(18), 'Tercer Molar (Muela del Juicio) Superior Derecho');

  // Quadrant 2: Upper Left
  assert.equal(toothNameEs(21), 'Incisivo Central Superior Izquierdo');
  assert.equal(toothNameEs(22), 'Incisivo Lateral Superior Izquierdo');
  assert.equal(toothNameEs(23), 'Canino Superior Izquierdo');
  assert.equal(toothNameEs(24), 'Primer Premolar Superior Izquierdo');
  assert.equal(toothNameEs(25), 'Segundo Premolar Superior Izquierdo');
  assert.equal(toothNameEs(26), 'Primer Molar Superior Izquierdo');
  assert.equal(toothNameEs(27), 'Segundo Molar Superior Izquierdo');
  assert.equal(toothNameEs(28), 'Tercer Molar (Muela del Juicio) Superior Izquierdo');

  // Quadrant 3: Lower Left
  assert.equal(toothNameEs(31), 'Incisivo Central Inferior Izquierdo');
  assert.equal(toothNameEs(32), 'Incisivo Lateral Inferior Izquierdo');
  assert.equal(toothNameEs(33), 'Canino Inferior Izquierdo');
  assert.equal(toothNameEs(34), 'Primer Premolar Inferior Izquierdo');
  assert.equal(toothNameEs(35), 'Segundo Premolar Inferior Izquierdo');
  assert.equal(toothNameEs(36), 'Primer Molar Inferior Izquierdo');
  assert.equal(toothNameEs(37), 'Segundo Molar Inferior Izquierdo');
  assert.equal(toothNameEs(38), 'Tercer Molar (Muela del Juicio) Inferior Izquierdo');

  // Quadrant 4: Lower Right
  assert.equal(toothNameEs(41), 'Incisivo Central Inferior Derecho');
  assert.equal(toothNameEs(42), 'Incisivo Lateral Inferior Derecho');
  assert.equal(toothNameEs(43), 'Canino Inferior Derecho');
  assert.equal(toothNameEs(44), 'Primer Premolar Inferior Derecho');
  assert.equal(toothNameEs(45), 'Segundo Premolar Inferior Derecho');
  assert.equal(toothNameEs(46), 'Primer Molar Inferior Derecho');
  assert.equal(toothNameEs(47), 'Segundo Molar Inferior Derecho');
  assert.equal(toothNameEs(48), 'Tercer Molar (Muela del Juicio) Inferior Derecho');
});

test('hackathon project configuration is valid and branded for Céflow', () => {
  const configPath = path.resolve(process.cwd(), 'platanus-hack-project.jsonc');
  assert.ok(fs.existsSync(configPath), 'platanus-hack-project.jsonc must exist');

  const raw = fs.readFileSync(configPath, 'utf8');
  // Strip comment lines safely without breaking https:// inside strings
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  const data = JSON.parse(stripped);

  assert.equal(data['project-name'], 'Céflow');
  assert.ok(data['project-oneliner-spanish'].length > 10);
  assert.ok(data['project-description-spanish'].includes('Céflow'));
  assert.ok(data['project-description-spanish'].includes('80%'));
  assert.ok(data['deploy-url'].startsWith('https://'));
});

test('patient demo static assets exist for photorealistic arches', () => {
  const demoDir = path.resolve(process.cwd(), 'public/patient-demo');
  assert.ok(fs.existsSync(demoDir), 'public/patient-demo must exist');

  const files = fs.readdirSync(demoDir);
  assert.ok(files.includes('upper.ply'), 'upper.ply must exist in patient-demo');
  assert.ok(files.includes('upper.jpg'), 'upper.jpg must exist in patient-demo');
  assert.ok(files.includes('lower.ply'), 'lower.ply must exist in patient-demo');
  assert.ok(files.includes('lower.jpg'), 'lower.jpg must exist in patient-demo');
});

test('toothNameEs throws RangeError on invalid FDI codes', () => {
  for (const invalid of [0, 9, 10, 19, 20, 29, 30, 39, 40, 49, 50, 99, -1, 11.5]) {
    assert.throws(
      () => toothNameEs(invalid),
      RangeError,
      `Expected RangeError for invalid code: ${invalid}`
    );
  }
});

test('whatsapp consultation link formats patient name, case ID and Céflow branding correctly', () => {
  const patientName = 'Sofia M.';
  const caseId = 'PLT-2026-084';
  const rawMessage = `Hola, soy ${patientName} y estuve revisando mi informe dental 3D de Céflow Dental (Caso ${caseId}). Quisiera coordinar mi cita de control preventivo.`;
  const encoded = encodeURIComponent(rawMessage);

  assert.ok(encoded.includes('Sofia%20M.'));
  assert.ok(encoded.includes('PLT-2026-084'));
  assert.ok(encoded.includes('C%C3%A9flow%20Dental'));

  const fullUrl = `https://wa.me/?text=${encoded}`;
  assert.ok(fullUrl.startsWith('https://wa.me/?text='));
});


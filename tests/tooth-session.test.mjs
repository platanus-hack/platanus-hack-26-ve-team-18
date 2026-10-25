import test from 'node:test';
import assert from 'node:assert/strict';
import { createToothSession, emptyToothCase, geometrySignature, readToothSession, reconcileToothCase } from '../src/tooth-session.ts';

const makePart = (id = 'upper') => ({
  id, name: 'Upper scan', fileName: 'upper.stl', positions: new Float32Array([0,0,0, 2,0,0, 0,2,0, 2,0,0, 2,2,0, 0,2,0]), normals: new Float32Array(18),
  role: 'upper', triangles: 2, vertices: 4, closed: false, visible: true, offset: [0,0,0], dimensions: [2,2,0],
});
const identified = part => {
  const data = emptyToothCase();
  data.labels[part.id] = new Uint8Array([16,255]);
  data.teeth[16] = { status: 'present', restoration: 'crown', note: 'Review margin' };
  data.teeth[15] = { status: 'missing', restoration: 'implant', note: 'Dentist marked site', site: { partId: part.id, face: 1, point: [1,1,0] } };
  data.teeth[18] = { status: 'not-scanned', restoration: 'none', note: '' };
  return data;
};

test('identification round trip binds labels and site points to source geometry under a new part id and pose', async () => {
  const part = makePart();
  const original = identified(part);
  const file = await createToothSession([part], original);
  const reimport = { ...part, id: 'reimported', offset: [3,4,5], rotation: [0,0,90] };
  const loaded = await readToothSession(JSON.parse(JSON.stringify(file)), [reimport]);
  assert.deepEqual(loaded.labels.reimported, original.labels.upper);
  assert.equal(loaded.teeth[15].site.partId, 'reimported');
  assert.deepEqual(loaded.teeth[15].site.point, [1,1,0]);
  assert.equal(loaded.teeth[15].restoration, 'implant');
  assert.equal(loaded.teeth[18].status, 'not-scanned');
  assert.equal(loaded.teeth[17].status, 'unreviewed');
  assert.equal(file.units, 'file units (u)');
  assert.deepEqual(part.positions, makePart().positions);
});

test('same triangle count with different geometry or triangle order cannot receive saved labels', async () => {
  const part = makePart(), file = await createToothSession([part], identified(part));
  const changed = makePart(); changed.positions[0] = .5;
  await assert.rejects(readToothSession(file, [changed]), /geometry is missing/);
  const reordered = makePart(); reordered.positions.set([...part.positions.slice(9), ...part.positions.slice(0,9)]);
  await assert.rejects(readToothSession(file, [reordered]), /geometry is missing/);
  assert.notEqual(await geometrySignature(changed.positions), await geometrySignature(part.positions));
});

test('ambiguous duplicate scans and mismatched scan roles are rejected atomically', async () => {
  const part = makePart(), duplicate = makePart('duplicate');
  await assert.rejects(createToothSession([part,duplicate], identified(part)), /Duplicate identical arch scans/);
  const file = await createToothSession([part], identified(part));
  file.parts.push({ ...file.parts[0], key: 'scan-2' });
  await assert.rejects(readToothSession(file, [part,duplicate]), /ambiguous/);
  const single = await createToothSession([part], identified(part));
  await assert.rejects(readToothSession(single, [{ ...part, role: 'lower' }]), /geometry is missing/);
});

test('missing records do not imply implant intent and unreviewed positions never become missing', async () => {
  const part = makePart(), data = emptyToothCase();
  data.teeth[15].status = 'missing';
  const loaded = await readToothSession(await createToothSession([part], data), [part]);
  assert.equal(loaded.teeth[15].restoration, 'none');
  assert.equal(loaded.teeth[16].status, 'unreviewed');
  assert.equal(loaded.teeth[15].site, undefined);
});

test('conflicting missing/assigned status, incompatible intents, invalid FDI and off-surface anchors fail', async () => {
  const part = makePart();
  const fresh = () => createToothSession([part], identified(part));
  let file = await fresh(); file.teeth.find(t => t.fdi === 16).status = 'missing';
  await assert.rejects(readToothSession(file,[part]), /conflicting/);
  file = await fresh(); file.teeth.find(t => t.fdi === 15).status = 'present';
  await assert.rejects(readToothSession(file,[part]), /conflicting/);
  file = await fresh(); file.teeth[0].fdi = 19;
  await assert.rejects(readToothSession(file,[part]), /Invalid or duplicate FDI/);
  file = await fresh(); file.teeth.find(t => t.fdi === 15).site.point = [1,1,3];
  await assert.rejects(readToothSession(file,[part]), /not on its source triangle/);
  file = await fresh(); file.teeth.find(t => t.fdi === 15).site.point = [1e308,1e308,0];
  await assert.rejects(readToothSession(file,[part]), /not on its source triangle/);
  file = await fresh(); file.parts[0].labelsBase64 = btoa(String.fromCharCode(36,255));
  await assert.rejects(readToothSession(file,[part]), /wrong arch/);
  file = await fresh(); file.parts[0].labelsBase64 = btoa(String.fromCharCode(19,255));
  await assert.rejects(readToothSession(file,[part]), /invalid FDI triangle/);
});

test('records for an absent arch cannot be injected through a session file', async () => {
  const part = makePart(), file = await createToothSession([part], identified(part));
  file.teeth.find(t => t.fdi === 36).status = 'missing';
  await assert.rejects(readToothSession(file, [part]), /requires a matching lower scan/);
});

test('removing a labeled part resets the lost assignment even when another part of the same arch remains', () => {
  const part = makePart(), other = { ...makePart('other'), name: 'Other upper part' };
  const data = identified(part);
  const next = reconcileToothCase(data, [other]);
  assert.equal(next.teeth[16].status, 'unreviewed');
  assert.equal(next.teeth[16].restoration, 'none');
  assert.equal(next.teeth[15].status, 'missing');
  assert.equal(next.teeth[15].site, undefined);
});

test('removing an arch clears its labels, missing sites, and notes; rigid moves keep all annotations', () => {
  const part = makePart(), data = identified(part);
  assert.equal(reconcileToothCase(data, [{ ...part, offset: [100,0,0] }]), data);
  const removed = reconcileToothCase(data, []);
  assert.deepEqual(removed.labels, {});
  assert.equal(removed.teeth[15].status, 'unreviewed');
  assert.equal(removed.teeth[15].site, undefined);
  assert.equal(removed.teeth[15].note, '');
  assert.deepEqual(data.labels.upper, new Uint8Array([16,255]));
});

test('standalone identification preserves reviewed erasures and validates masks against rehashed source geometry', async () => {
  const part = makePart(), data = identified(part);
  data.labels[part.id][1] = 0;
  data.reviewedMask = { [part.id]: new Uint8Array([0,1]) };
  const file = await createToothSession([part], data);
  const restored = await readToothSession(JSON.parse(JSON.stringify(file)), [{ ...part, id: 'reopened' }]);
  assert.deepEqual(restored.reviewedMask.reopened, new Uint8Array([0,1]));
  assert.equal(restored.labels.reopened[1], 0);
  const legacy = JSON.parse(JSON.stringify(file)); delete legacy.parts[0].reviewedMaskBase64;
  assert.equal((await readToothSession(legacy, [part])).reviewedMask, undefined);
  for (const mask of [new Uint8Array([1]), new Uint8Array([0,255])]) {
    await assert.rejects(createToothSession([part], { ...data, reviewedMask: { [part.id]: mask } }), /mask/);
  }
  const changed = { ...part, positions: part.positions.slice() }; changed.positions[0] += .25;
  await assert.rejects(readToothSession(file, [changed]), /geometry is missing/);
});

test('mask-only reconciliation removes missing and non-arch dependencies without mutating the reviewed case', () => {
  const part = makePart(), data = emptyToothCase();
  data.reviewedMask = { lost: new Uint8Array([1,0]) };
  const reconciled = reconcileToothCase(data, [part]);
  assert.notEqual(reconciled, data);
  assert.deepEqual(reconciled.reviewedMask, {});
  assert.deepEqual(data.reviewedMask.lost, new Uint8Array([1,0]));
  data.reviewedMask = { [part.id]: new Uint8Array([1,0]) };
  assert.deepEqual(reconcileToothCase(data, [{ ...part, role: 'bite' }]).reviewedMask, {});
});

test('empty reviewed charts can persist before arch roles are assigned and writers reject lost reviewed anchors', async () => {
  const part = makePart(), unassigned = { ...part, role: 'model' };
  const file = await createToothSession([unassigned], emptyToothCase());
  assert.deepEqual(file.parts, []);
  assert.deepEqual(await readToothSession(file, [unassigned]), emptyToothCase());
  const data = identified(part); data.teeth[15].site.partId = 'missing-source';
  await assert.rejects(createToothSession([part], data), /matching arch scan/);
});

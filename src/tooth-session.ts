import { Triangle, Vector3 } from 'three';
import type { ModelPart } from './models';
import { partMatrix } from './pose.ts';
import type { SurfaceAnchor, ToothCase, ToothRecord } from './tooth-types';
import { FDI_TEETH as codes, isFdiTooth as isTooth, toothArch as arch, emptyToothRecord as defaultRecord } from './teeth.ts';

export const emptyToothCase = (): ToothCase => ({ labels: {}, teeth: Object.fromEntries(codes.map(code => [code, defaultRecord()])) });

/** Labels refer to immutable imported triangles, never to a posed/rendered subset. */
export function reconcileToothCase(current: ToothCase, parts: ModelPart[]): ToothCase {
  const labels: ToothCase['labels'] = {};
  let changed = false;
  for (const [id, values] of Object.entries(current.labels)) {
    const part = parts.find(item => item.id === id);
    if (!part || values.length !== part.triangles || !['upper', 'lower'].includes(part.role ?? '') || values.some(value => isTooth(value) && arch(value) !== part.role)) { changed = true; continue; }
    labels[id] = values;
  }
  const teeth = { ...current.teeth };
  const previousAssignments = new Set<number>(), retainedAssignments = new Set<number>();
  if (changed) {
    for (const values of Object.values(current.labels)) for (const value of values) if (isTooth(value)) previousAssignments.add(value);
    for (const values of Object.values(labels)) for (const value of values) if (isTooth(value)) retainedAssignments.add(value);
  }
  for (const code of codes) {
    const record = teeth[code];
    if (!parts.some(part => part.role === arch(code))) {
      if (record.status !== 'unreviewed' || record.restoration !== 'none' || record.note || record.site) { teeth[code] = defaultRecord(); changed = true; }
    } else if (record.site && !parts.some(part => part.id === record.site!.partId && part.role === arch(code))) {
      teeth[code] = { ...record, site: undefined }; changed = true;
    } else if (record.status === 'present' && previousAssignments.has(code) && !retainedAssignments.has(code)) {
      teeth[code] = { ...record, status: 'unreviewed', restoration: 'none' }; changed = true;
    }
  }
  const reviewedMask = current.reviewedMask ? Object.fromEntries(Object.entries(current.reviewedMask).filter(([id, mask]) => {
    const keep = parts.some(part => part.id === id && ['upper', 'lower'].includes(part.role ?? '') && part.triangles === mask.length)
      && mask.every(value => value === 0 || value === 1);
    if (!keep) changed = true;
    return keep;
  })) : undefined;
  return changed ? { labels, teeth, ...(reviewedMask ? { reviewedMask } : {}) } : current;
}

export async function geometrySignature(positions: Float32Array): Promise<string> {
  const bytes = new Uint8Array(positions.byteLength);
  bytes.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function encodeLabels(labels: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < labels.length; i += 16_384) chunks.push(String.fromCharCode(...labels.subarray(i, i + 16_384)));
  return btoa(chunks.join(''));
}

function decodeLabels(value: unknown, triangles: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== Math.ceil(triangles / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid triangle label data.');
  const binary = atob(value);
  if (binary.length !== triangles) throw new Error('The triangle labels do not match their scan.');
  const labels = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (labels.some(label => label !== 0 && label !== 255 && !isTooth(label))) throw new Error('Identification contains an invalid FDI triangle label.');
  return labels;
}

type SessionPart = { key: string; name: string; fileName: string; role: string; triangles: number; geometrySha256: string; labelsBase64: string; reviewedMaskBase64?: string; fileToWorkspace: number[] };
type SavedTooth = Omit<ToothRecord, 'site'> & { fdi: number; site?: Omit<SurfaceAnchor, 'partId'> & { partKey: string } };
export interface ToothSessionFile {
  format: 'platanus-tooth-identification';
  version: 1;
  numbering: 'FDI permanent';
  units: 'file units (u)';
  source: 'user-reviewed identification';
  createdAt: string;
  parts: SessionPart[];
  teeth: SavedTooth[];
}

export async function createToothSession(parts: ModelPart[], data: ToothCase): Promise<ToothSessionFile> {
  const arches = parts.filter(part => part.role === 'upper' || part.role === 'lower');
  const keys = new Map(arches.map((part, i) => [part.id, `scan-${i + 1}`]));
  if (data.reviewedMask && Object.keys(data.reviewedMask).some(id => !keys.has(id))) throw new Error('A reviewed correction mask requires a matching arch scan.');
  const savedParts = await Promise.all(arches.map(async part => ({
    key: keys.get(part.id)!, name: part.name, fileName: part.fileName, role: part.role!, triangles: part.triangles,
    geometrySha256: await geometrySignature(part.positions), labelsBase64: encodeLabels(data.labels[part.id] ?? new Uint8Array(part.triangles)),
    ...(data.reviewedMask?.[part.id] ? { reviewedMaskBase64: encodeLabels(data.reviewedMask[part.id]) } : {}),
    fileToWorkspace: partMatrix(part).toArray(),
  })));
  const identities = new Set<string>();
  for (const part of savedParts) {
    const identity = JSON.stringify([part.role, part.geometrySha256, part.name, part.fileName]);
    if (identities.has(identity)) throw new Error('Duplicate identical arch scans are ambiguous. Remove the duplicate before saving identification.');
    identities.add(identity);
  }
  const file: ToothSessionFile = {
    format: 'platanus-tooth-identification', version: 1, numbering: 'FDI permanent', units: 'file units (u)', source: 'user-reviewed identification', createdAt: new Date().toISOString(), parts: savedParts,
    teeth: codes.map(fdi => {
      const { site, ...record } = data.teeth[fdi];
      if (site && !keys.has(site.partId)) throw new Error('A reviewed surface point requires a matching arch scan.');
      return { fdi, ...record, ...(site ? { site: { partKey: keys.get(site.partId)!, face: site.face, point: [...site.point] as SurfaceAnchor['point'] } } : {}) };
    }),
  };
  // Validate the writer too: an editable case must never save a file it cannot reopen.
  await readToothSession(file, parts);
  return file;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid identification file.');
  return value as Record<string, unknown>;
}

function loadAnchor(value: unknown, partsByKey: Map<string, ModelPart>, code: number): SurfaceAnchor {
  const item = object(value);
  const part = typeof item.partKey === 'string' ? partsByKey.get(item.partKey) : undefined;
  const face = item.face;
  const point = item.point;
  if (!part || part.role !== arch(code) || !Number.isSafeInteger(face) || (face as number) < 0 || (face as number) >= part.triangles || !Array.isArray(point) || point.length !== 3 || point.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid surface point for FDI ${code}.`);
  const [a, b, c] = [0, 1, 2].map(corner => new Vector3().fromArray(part.positions, (face as number) * 9 + corner * 3));
  const target = new Vector3(...point as [number, number, number]);
  const nearest = new Triangle(a, b, c).closestPointToPoint(target, new Vector3());
  const scale = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
  const magnitude = Math.max(...point.map(Math.abs), ...a.toArray().map(Math.abs));
  const separation = nearest.distanceTo(target);
  if (!nearest.toArray().every(Number.isFinite) || !Number.isFinite(separation) || separation > Math.max(scale * 1e-5, magnitude * Number.EPSILON * 64)) throw new Error(`The saved point for FDI ${code} is not on its source triangle.`);
  return { partId: part.id, face: face as number, point: [...point] as SurfaceAnchor['point'] };
}

/** Atomic load: fully validate every label, record, and scan before returning anything. */
export async function readToothSession(value: unknown, parts: ModelPart[]): Promise<ToothCase> {
  const file = object(value);
  if (file.format !== 'platanus-tooth-identification' || file.version !== 1 || file.numbering !== 'FDI permanent' || file.units !== 'file units (u)' || !Array.isArray(file.parts) || !Array.isArray(file.teeth)) throw new Error('Choose a Platanus FDI identification file (version 1).');
  const arches = parts.filter(part => part.role === 'upper' || part.role === 'lower');
  if (file.parts.length !== arches.length) throw new Error('Load the same upper/lower scan parts and assign their scan roles before loading identification.');
  if (new Set(arches.map(part => part.id)).size !== arches.length) throw new Error('Duplicate imported arch scan identities.');
  const signatures = await Promise.all(arches.map(part => geometrySignature(part.positions)));
  const unused = new Set(arches.map(part => part.id));
  const partsByKey = new Map<string, ModelPart>();
  const result = emptyToothCase();
  for (const raw of file.parts) {
    const source = object(raw);
    if (typeof source.key !== 'string' || partsByKey.has(source.key) || typeof source.geometrySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.geometrySha256) || !['upper', 'lower'].includes(source.role as string)) throw new Error('Invalid or duplicate identification scan.');
    let candidates = arches.filter((part, i) => unused.has(part.id) && part.role === source.role && part.triangles === source.triangles && signatures[i] === source.geometrySha256);
    if (candidates.length > 1) candidates = candidates.filter(part => part.fileName === source.fileName && part.name === source.name);
    if (candidates.length !== 1) throw new Error('Scan geometry is missing or ambiguous. Identification requires the original triangle order and matching scan roles.');
    const part = candidates[0];
    const labels = decodeLabels(source.labelsBase64, part.triangles);
    if (labels.some(label => isTooth(label) && arch(label) !== part.role)) throw new Error('An FDI label is assigned to the wrong arch.');
    result.labels[part.id] = labels;
    if (source.reviewedMaskBase64 !== undefined) {
      if (typeof source.reviewedMaskBase64 !== 'string' || source.reviewedMaskBase64.length !== Math.ceil(part.triangles / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.reviewedMaskBase64)) throw new Error('Invalid reviewed correction mask.');
      const mask = Uint8Array.from(atob(source.reviewedMaskBase64), char => char.charCodeAt(0));
      if (mask.length !== part.triangles || mask.some(value => value !== 0 && value !== 1)) throw new Error('Reviewed correction masks must contain one 0/1 value per source triangle.');
      (result.reviewedMask ??= {})[part.id] = mask;
    }
    partsByKey.set(source.key, part); unused.delete(part.id);
  }
  if (file.teeth.length !== 32) throw new Error('The identification must contain all 32 permanent FDI positions.');
  const seen = new Set<number>();
  const assigned = new Set<number>();
  for (const labels of Object.values(result.labels)) for (const label of labels) if (isTooth(label)) assigned.add(label);
  for (const raw of file.teeth) {
    const record = object(raw), code = record.fdi as number;
    if (!isTooth(code) || seen.has(code) || !['unreviewed', 'present', 'missing', 'not-scanned'].includes(record.status as string) || !['none', 'crown', 'implant'].includes(record.restoration as string) || typeof record.note !== 'string' || record.note.length > 2000) throw new Error('Invalid or duplicate FDI record.');
    if (!arches.some(part => part.role === arch(code)) && (record.status !== 'unreviewed' || record.restoration !== 'none' || record.note || record.site !== undefined)) throw new Error(`FDI ${code} requires a matching ${arch(code)} scan.`);
    if ((assigned.has(code) && record.status !== 'present') || (record.restoration === 'implant' && record.status !== 'missing') || (record.restoration === 'crown' && record.status !== 'present') || (record.site !== undefined && record.status !== 'missing')) throw new Error(`FDI ${code} has conflicting surface, status, or restoration records.`);
    result.teeth[code] = { status: record.status as ToothRecord['status'], restoration: record.restoration as ToothRecord['restoration'], note: record.note, ...(record.site !== undefined ? { site: loadAnchor(record.site, partsByKey, code) } : {}) };
    seen.add(code);
  }
  return result;
}

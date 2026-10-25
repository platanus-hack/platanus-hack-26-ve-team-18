import test from 'node:test';
import assert from 'node:assert/strict';
import { detectToothRegions } from '../src/auto-tooth-geometry.ts';

const settings = { direction: 'auto', sensitivity: 1 };
const mesh = faces => new Float32Array(faces.flat(2));
// A continuous gum/palate sheet with a semicircular row of smooth, distinct
// crown-height protrusions. Connectivity comes only from exact shared edges.
function arch(count, { missing = -1, sign = 1, cusps = false, noise = 0, step = 0.24 } = {}) {
  const radius = Math.max(3, count * 1.12), centers = Array.from({ length: count }, (_, i) => {
    const theta = count === 1 ? Math.PI / 2 : 0.12 + (Math.PI - 0.24) * i / (count - 1);
    return [radius * Math.cos(theta), radius * Math.sin(theta), 2.3 + 0.13 * Math.sin(i * 1.9)];
  });
  const xmin = -radius - 2, xmax = radius + 2, ymin = -2, ymax = radius + 2;
  const nx = Math.ceil((xmax - xmin) / step), ny = Math.ceil((ymax - ymin) / step);
  const points = Array.from({ length: ny + 1 }, (_, y) => Array.from({ length: nx + 1 }, (_, x) => {
    const px = xmin + x * (xmax - xmin) / nx, py = ymin + y * (ymax - ymin) / ny;
    let h = noise * Math.sin(x * 7.31 + y * 9.73);
    centers.forEach(([cx, cy, height], i) => {
      if (i === missing) return;
      const r = Math.hypot(px - cx, py - cy) / 1.43;
      if (r < 1) {
        let bump = height * (0.5 + 0.5 * Math.cos(Math.PI * r));
        if (cusps) bump += 0.18 * Math.exp(-((px - cx - 0.42) ** 2 + (py - cy) ** 2) / 0.055);
        h = Math.max(h, bump);
      }
    });
    return [px, py, sign * h];
  }));
  const faces = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = points[y][x], b = points[y][x + 1], c = points[y + 1][x + 1], d = points[y + 1][x];
    faces.push([a, b, d], [b, c, d]);
  }
  return { positions: mesh(faces), centers: centers.map(([x, y, h]) => [x, y, sign * h]) };
}
const centroid = (positions, f) => [0, 1, 2].map(k => (positions[f * 9 + k] + positions[f * 9 + 3 + k] + positions[f * 9 + 6 + k]) / 3);
function validate(scan, positions) {
  const seen = new Set(), edgeCount = new Map(), edgeFaces = new Map(), faceEdges = [];
  for (let f = 0; f < positions.length / 9; f++) {
    const points = [0, 1, 2].map(j => [...positions.subarray(f * 9 + j * 3, f * 9 + j * 3 + 3)].join(','));
    faceEdges[f] = [0, 1, 2].map(j => [points[j], points[(j + 1) % 3]].sort().join('|'));
    for (const edge of faceEdges[f]) {
      edgeCount.set(edge, (edgeCount.get(edge) ?? 0) + 1);
      if (!edgeFaces.has(edge)) edgeFaces.set(edge, []);
      edgeFaces.get(edge).push(f);
    }
  }
  assert.ok(scan.candidates.length <= 32);
  for (const candidate of scan.candidates) {
    assert.equal(candidate.id, candidate.seed.face + 1);
    assert.ok(candidate.faces instanceof Uint32Array);
    assert.ok(candidate.faces.includes(candidate.seed.face));
    assert.deepEqual(candidate.seed.point, centroid(positions, candidate.seed.face));
    assert.ok(candidate.area > 0 && candidate.height > 0);
    assert.ok(candidate.evidence.shoulderProjectedArea > 0);
    assert.ok(candidate.evidence.shoulderTissueCost >= 0 && candidate.evidence.shoulderTissueCost <= 1);
    assert.ok(['merge-saddle', 'estimated-base'].includes(candidate.evidence.reliefReference));
    assert.ok(candidate.centroid.every(Number.isFinite));
    assert.ok(candidate.warnings.length);
    assert.ok(!('fdi' in candidate));
    for (const f of candidate.faces) { assert.ok(f < positions.length / 9); assert.ok(!seen.has(f)); seen.add(f); assert.ok(faceEdges[f].every(edge => edgeCount.get(edge) === 2), 'open and non-manifold edge faces stay unassigned'); }
    const members = new Set(candidate.faces), reached = new Set([candidate.seed.face]), queue = [candidate.seed.face];
    for (let head = 0; head < queue.length; head++) for (const edge of faceEdges[queue[head]]) {
      for (const next of edgeFaces.get(edge)) if (members.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
    }
    assert.equal(reached.size, members.size, 'every original output face connects to its seed through exact manifold edges');
  }
  assert.equal(scan.unassignedTriangles, positions.length / 9 - seen.size);
  const { up, u, v } = scan.frame;
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  for (const a of [up, u, v]) assert.ok(Math.abs(dot(a, a) - 1) < 1e-8);
  for (const [a, b] of [[up, u], [up, v], [u, v]]) assert.ok(Math.abs(dot(a, b)) < 1e-8);
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  assert.ok(dot(cross, up) > 0.999999);
}

test('automatically proposes 3, 7 and 14 whole-arch crowns on connected gum', () => {
  for (const count of [3, 7, 14]) {
    const { positions, centers } = arch(count), original = positions.slice();
    const scan = detectToothRegions(positions, settings);
    assert.equal(scan.candidates.length, count, `arch ${count}: ${scan.candidates.length}`);
    validate(scan, positions);
    assert.deepEqual(positions, original);
    for (const center of centers) assert.equal(scan.candidates.filter(c => Math.hypot(c.seed.point[0] - center[0], c.seed.point[1] - center[1]) < 0.5).length, 1);
    const faces = scan.candidates.flatMap(c => [...c.faces]);
    assert.ok(faces.every(f => centroid(positions, f)[2] > 0.2), 'flat gum/palate is excluded');
  }
});

test('a missing tooth leaves a gap and does not rank-renumber the remaining proposals', () => {
  const complete = arch(7), gap = arch(7, { missing: 3 });
  const before = detectToothRegions(complete.positions, settings), after = detectToothRegions(gap.positions, settings);
  assert.equal(after.candidates.length, 6);
  assert.ok(after.candidates.every(c => before.candidates.some(b => b.id === c.id)));
  const center = gap.centers[3];
  assert.ok(after.candidates.every(c => [...c.faces].every(f => {
    const p = centroid(gap.positions, f); return Math.hypot(p[0] - center[0], p[1] - center[1]) > 1.2;
  })));
});

test('shallow nearby cusp maxima stay in one crown; sensitivity remains bounded', () => {
  const { positions } = arch(7, { cusps: true });
  assert.equal(detectToothRegions(positions, settings).candidates.length, 7);
  const low = detectToothRegions(positions, { ...settings, sensitivity: 0.5 });
  const high = detectToothRegions(positions, { ...settings, sensitivity: 1.5 });
  assert.ok(high.candidates.length >= low.candidates.length);
  assert.ok(high.candidates.reduce((sum, c) => sum + c.faces.length, 0) / high.candidates.length <= low.candidates.reduce((sum, c) => sum + c.faces.length, 0) / low.candidates.length);
  assert.deepEqual(detectToothRegions(positions, { ...settings, sensitivity: 99 }), high);
  assert.deepEqual(detectToothRegions(positions, { ...settings, sensitivity: NaN }), detectToothRegions(positions, settings));
});

test('auto evaluates both occlusal signs and explicit direction overrides', () => {
  for (const sign of [1, -1]) {
    const { positions } = arch(3, { sign });
    const automatic = detectToothRegions(positions, settings);
    assert.equal(automatic.candidates.length, 3);
    assert.ok(automatic.frame.up[2] * sign > 0.98);
    const manual = detectToothRegions(positions, { ...settings, direction: sign > 0 ? '+z' : '-z' });
    assert.equal(manual.candidates.length, 3);
    assert.equal(detectToothRegions(positions, { ...settings, direction: sign > 0 ? '-z' : '+z' }).candidates.length, 0);
  }
});

const rotation = [
  [0.36, -0.48, 0.8],
  [0.8, 0.6, 0],
  [-0.48, 0.64, 0.6],
];
function transform(positions, scale, offset, rotate = true) {
  const result = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) result[i + k] = offset[k] + scale * (rotate ? rotation[k].reduce((sum, x, j) => sum + x * positions[i + j], 0) : positions[i + k]);
  return result;
}

// Deliberately unequal protrusions above a sloped, curved sheet and a deep
// central palate. Slot indices belong only to this fixture, never anatomy.
function unevenArch({ step = 0.22, missing = [], noCrowns = false, steep = false } = {}) {
  const heights = [0.65, 1.15, 2.8, 0.9, 1.8, 0.75, 2.5, 1.25, 2.1], radius = 10.08;
  const base = (x, y) => (steep ? 0.12 : 0.04) * x - (steep ? 0.10 : 0.06) * y
    + (steep ? 0.018 : 0.012) * (x * x + (y - radius * 0.32) ** 2)
    - (steep ? 5 : 3.5) * Math.exp(-(x * x + (y - radius * 0.42) ** 2) / (radius * 0.55) ** 2)
    + 0.4 * Math.exp(-((Math.hypot(x, y) - radius) ** 2) / 2.8) + 0.35 * Math.sin(x * 0.48) + 0.22 * Math.cos(y * 0.61);
  const centers = heights.map((height, i) => {
    const angle = 0.12 + (Math.PI - 0.24) * i / (heights.length - 1), x = radius * Math.cos(angle), y = radius * Math.sin(angle);
    return { point: [x, y, base(x, y) + height], height, width: 1.25 + 0.15 * (i % 3), present: !noCrowns && !missing.includes(i) };
  });
  const sample = (x, y) => {
    let bump = 0, ratio = Infinity;
    for (const c of centers) {
      if (!c.present) continue;
      const r = Math.hypot(x - c.point[0], y - c.point[1]) / c.width;
      const h = r < 1 ? c.height * (0.5 + 0.5 * Math.cos(Math.PI * r)) : 0;
      if (h > bump) { bump = h; ratio = r; }
    }
    return { height: base(x, y) + bump, ratio };
  };
  const nx = Math.ceil((2 * radius + 4) / step), ny = Math.ceil((radius + 4) / step);
  const points = Array.from({ length: ny + 1 }, (_, y) => Array.from({ length: nx + 1 }, (_, x) => {
    const px = -radius - 2 + x * (2 * radius + 4) / nx, py = -2 + y * (radius + 4) / ny;
    return [px, py, sample(px, py).height];
  }));
  const positions = new Float32Array(nx * ny * 18), tissueScores = new Float32Array(nx * ny * 2);
  let f = 0;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = points[y][x], b = points[y][x + 1], c = points[y + 1][x + 1], d = points[y + 1][x];
    for (const triangle of [[a, b, d], [b, c, d]]) {
      triangle.forEach((p, j) => positions.set(p, f * 9 + j * 3));
      const p = centroid(positions, f);
      tissueScores[f++] = sample(p[0], p[1]).ratio > 0.45 ? 1 : -1;
    }
  }
  return { positions, centers, tissueScores };
}

function recoveredCenters(scan, centers) {
  const recovered = new Set();
  for (const c of scan.candidates) {
    const near = centers.map((center, i) => ({ center, i, d: Math.hypot(c.seed.point[0] - center.point[0], c.seed.point[1] - center.point[1]) })).sort((a, b) => a.d - b.d)[0];
    assert.ok(near.center.present && near.d < near.center.width * 0.55, 'every seed has a planted local crown, including at gap edges');
    assert.ok(!recovered.has(near.i), 'a cusp duplicate is not counted as another recovered crown');
    recovered.add(near.i);
  }
  return recovered;
}

test('local basin support recovers unequal crowns above a deep palate at different resolutions', () => {
  for (const step of [0.18, 0.30]) {
    const { positions, centers } = unevenArch({ step }), scan = detectToothRegions(positions, { ...settings, direction: '+z' });
    // These intentionally difficult fixtures retain known misses; this checks
    // per-feature recovery rather than equating the proposal count with teeth.
    assert.ok(recoveredCenters(scan, centers).size >= 6, 'coarser meshes can retain additional shallow-crown misses');
    assert.match(scan.warnings.join(' '), /local basin support/i);
    validate(scan, positions);
  }
});

test('bounded direction evidence favors independent crowns over one broad palate basin', () => {
  for (const options of [{}, { missing: [2, 6] }, { steep: true }]) {
    const { positions, centers } = unevenArch(options), scan = detectToothRegions(positions, settings);
    assert.ok(scan.frame.up[2] > 0.97, 'the deep palate cannot win only through its area and height');
    assert.ok(recoveredCenters(scan, centers).size >= (options.missing ? 5 : 6));
    validate(scan, positions);
  }
});

test('unequal-crown proposals preserve file coordinates under rotation and large unit changes', () => {
  const { positions } = unevenArch(), baseline = detectToothRegions(positions, settings);
  for (const [scale, offset] of [[0.001, [12, -31, 9]], [1000, [100000, -21000, 4400]]]) {
    const moved = transform(positions, scale, offset), scan = detectToothRegions(moved, settings);
    assert.deepEqual(scan.candidates.map(c => c.id), baseline.candidates.map(c => c.id));
    validate(scan, moved);
    for (let i = 0; i < scan.candidates.length; i++) {
      // Float32 rounding at a tiny scale far from the origin can move a few
      // marginal watershed faces, while seeds and source coordinates persist.
      assert.ok(Math.abs(scan.candidates[i].area / (baseline.candidates[i].area * scale ** 2) - 1) < 0.06);
      assert.ok(Math.abs(scan.candidates[i].height / (baseline.candidates[i].height * scale) - 1) < 0.02);
    }
  }
});

test('local proposals keep unknown evidence neutral and report misleading color conservatively', () => {
  const { positions, centers, tissueScores } = unevenArch(), baseline = detectToothRegions(positions, settings);
  for (const score of [-1, 0, 0.4]) assert.deepEqual(detectToothRegions(positions, settings, new Float32Array(tissueScores.length).fill(score)), baseline);
  const colored = detectToothRegions(positions, settings, tissueScores);
  assert.ok(recoveredCenters(colored, centers).size >= 5);
  assert.match(colored.warnings.join(' '), /color is not a tissue diagnosis/);
  validate(colored, positions);
  const bare = unevenArch({ noCrowns: true });
  assert.equal(detectToothRegions(bare.positions, { ...settings, direction: '+z' }, bare.tissueScores).candidates.length, 0);
  // The inverse of a smooth deep bowl can resemble a single dome. Keep the
  // ambiguity visible instead of asserting geometry can diagnose tissue.
  const ambiguous = detectToothRegions(bare.positions, settings);
  assert.ok(ambiguous.warnings.some(w => /cannot be distinguished reliably|no sufficiently prominent/i.test(w)));
});

test('rotation, scale and shared file origins preserve proposals and file coordinates', () => {
  const { positions } = arch(7), baseline = detectToothRegions(positions, settings);
  for (const [scale, offset] of [[0.04, [12, -31, 9]], [800, [100000, -21000, 4400]]]) {
    const moved = transform(positions, scale, offset), scan = detectToothRegions(moved, settings);
    assert.equal(scan.candidates.length, 7);
    validate(scan, moved);
    assert.deepEqual(scan.candidates.map(c => c.id), baseline.candidates.map(c => c.id));
    for (let i = 0; i < scan.candidates.length; i++) {
      assert.ok(Math.abs(scan.candidates[i].area / (baseline.candidates[i].area * scale ** 2) - 1) < 0.015);
      assert.ok(Math.abs(scan.candidates[i].height / (baseline.candidates[i].height * scale) - 1) < 0.015);
    }
    const expectedOrigin = transform(new Float32Array(baseline.frame.origin), scale, offset);
    assert.ok(Math.hypot(...scan.frame.origin.map((x, k) => x - expectedOrigin[k])) < scale * 0.001);
  }
});

test('axis overrides work in all six directions and tessellation does not create crowns', () => {
  const { positions } = arch(3);
  for (const axis of [0, 1, 2]) for (const sign of [1, -1]) {
    const rotated = positions.slice();
    for (let i = 0; i < rotated.length; i += 3) {
      rotated[i + axis] = sign * positions[i + 2];
      rotated[i + 2] = sign * positions[i + axis];
    }
    if (axis === 2) for (let i = 2; i < rotated.length; i += 3) rotated[i] = sign * positions[i];
    const direction = `${sign > 0 ? '+' : '-'}${'xyz'[axis]}`;
    assert.equal(detectToothRegions(rotated, { ...settings, direction }).candidates.length, 3, direction);
  }
  for (const step of [0.16, 0.36]) assert.equal(detectToothRegions(arch(7, { step }).positions, settings).candidates.length, 7);
});

test('flat planes, sloped planes, low random-looking noise and cut edges invent no teeth', () => {
  const { positions } = arch(3, { missing: 0 });
  for (const kind of ['flat', 'slope', 'noise']) {
    const flat = positions.slice();
    for (let i = 0; i < flat.length; i += 3) flat[i + 2] = kind === 'slope' ? flat[i] * 0.13 + flat[i + 1] * 0.19 : kind === 'noise' ? 0.008 * Math.sin(flat[i] * 19.7 + flat[i + 1] * 23.1) : 0;
    const scan = detectToothRegions(flat, settings);
    assert.equal(scan.candidates.length, 0, kind);
    assert.ok(scan.warnings.some(w => /no sufficiently prominent/i.test(w)));
  }
});

function dome(offset = [0, 0, 0]) {
  const n = 28, points = Array.from({ length: n + 1 }, (_, y) => Array.from({ length: n + 1 }, (_, x) => {
    const px = -1.6 + 3.2 * x / n, py = -1.6 + 3.2 * y / n, r = Math.hypot(px, py) / 1.4;
    return [offset[0] + px, offset[1] + py, offset[2] + (r < 1 ? 1.6 * (0.5 + 0.5 * Math.cos(Math.PI * r)) : 0)];
  }));
  const faces = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = points[y][x], b = points[y][x + 1], c = points[y + 1][x + 1], d = points[y + 1][x];
    faces.push([a, b, d], [b, c, d]);
  }
  return mesh(faces);
}

test('partial single crowns and arbitrarily close disconnected surfaces stay separate', () => {
  const first = dome(), second = dome([0, 0, 2 ** -18]);
  assert.equal(detectToothRegions(first, settings).candidates.length, 1);
  const combined = new Float32Array([...first, ...second]), scan = detectToothRegions(combined, settings), n = first.length / 9;
  assert.equal(scan.candidates.length, 2);
  validate(scan, combined);
  assert.ok(scan.candidates.every(c => [...c.faces].every(f => f < n) || [...c.faces].every(f => f >= n)));
});

test('vertex contact and non-manifold shared edges never connect separate crowns', () => {
  const first = dome(), touching = dome([3.2, 3.2, 0]), n = first.length / 9;
  const together = new Float32Array([...first, ...touching]), scan = detectToothRegions(together, settings);
  assert.equal(scan.candidates.length, 2);
  assert.ok(scan.candidates.every(c => [...c.faces].every(f => f < n) || [...c.faces].every(f => f >= n)));
  const seed = detectToothRegions(first, settings).candidates[0].seed.face;
  const nonManifold = new Float32Array([...first, ...first.slice(seed * 9, seed * 9 + 9)]);
  const blocked = detectToothRegions(nonManifold, settings);
  assert.ok(blocked.warnings.some(w => /non-manifold/i.test(w)));
  assert.ok(blocked.candidates.every(c => !c.faces.includes(n)));
  validate(blocked, nonManifold);
});

test('smooth edentulous ridges and unsupported crop maxima produce no proposals', () => {
  const { positions } = arch(7);
  for (const cropped of [false, true]) {
    const ridge = positions.slice();
    for (let i = 0; i < ridge.length; i += 3) {
      const x = ridge[i], y = ridge[i + 1];
      ridge[i + 2] = cropped ? 0.5 * x * x / 100 : 0.22 * Math.exp(-((Math.hypot(x, y) - 7.84) ** 2) / 2);
    }
    assert.equal(detectToothRegions(ridge, settings).candidates.length, 0);
  }
});

test('broad curved tissue cannot become a compact cap through the distance cutoff', () => {
  const n = 60, faces = [];
  const point = (x, y) => { const px = -20 + 40 * x / n, py = -20 + 40 * y / n; return [px, py, 0.005 * (px * px + py * py)]; };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) faces.push([point(x, y), point(x + 1, y), point(x, y + 1)], [point(x + 1, y), point(x + 1, y + 1), point(x, y + 1)]);
  assert.equal(detectToothRegions(mesh(faces), settings).candidates.length, 0);
  const curved = arch(3).positions;
  for (let i = 0; i < curved.length; i += 3) curved[i + 2] += 0.08 * (curved[i] ** 2 + curved[i + 1] ** 2);
  assert.equal(detectToothRegions(curved, settings).candidates.length, 3);
});

test('a high cropped ridge cannot gain a supported boundary from the growth cutoff', () => {
  const nx = 90, ny = 70, faces = [];
  const point = (i, j) => {
    const x = -5 + 13 * i / nx, y = -5 + 10 * j / ny;
    const shoulder = (1.25 + 0.01 * x) * Math.exp(-y * y / 0.65) * (x < 0 ? Math.exp(-x * x / 2) : 1);
    return [x, y, shoulder + 0.35 * Math.exp(-(x * x + y * y) / 0.3)];
  };
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    faces.push([point(x, y), point(x + 1, y), point(x, y + 1)], [point(x + 1, y), point(x + 1, y + 1), point(x, y + 1)]);
  }
  const positions = mesh(faces), scan = detectToothRegions(positions, { ...settings, direction: '+z' });
  assert.equal(scan.candidates.length, 0, 'the full shoulder reaches an elevated open scan border beyond the growth radius');
  validate(scan, positions);
});

function tallCrown() {
  const faces = [], around = 40, levels = 36;
  const point = (i, j) => {
    const t = i / levels, r = i === levels ? 0 : 0.3 * (1 - t) + 0.9 * Math.sin(Math.PI * t), theta = (j % around) * 2 * Math.PI / around;
    return [r * Math.cos(theta), r * Math.sin(theta), 4 * t];
  };
  for (let i = 0; i < levels; i++) for (let j = 0; j < around; j++) faces.push([point(i, j), point(i, j + 1), point(i + 1, j)], [point(i, j + 1), point(i + 1, j + 1), point(i + 1, j)]);
  return mesh(faces);
}

test('tall and narrow partial crowns compare axes despite sidewall caps or tiny fragments', () => {
  const tall = tallCrown(), narrow = dome();
  for (let i = 0; i < narrow.length; i += 3) { narrow[i] *= 0.32; narrow[i + 2] *= 2.5; }
  for (const positions of [tall, narrow]) {
    const scan = detectToothRegions(positions, settings);
    assert.equal(scan.candidates.length, 1);
    assert.ok(scan.frame.up[2] > 0.95, `up: ${scan.frame.up}`);
    assert.ok(scan.candidates[0].seed.point[2] > 3);
  }
  const tallDome = dome();
  for (let i = 2; i < tallDome.length; i += 3) tallDome[i] *= 2.5;
  for (const count of [31, 32, 40]) {
    const fragments = Array.from({ length: count }, (_, i) => { const x = 1.8 + i * 0.01; return [[x, 0, 0], [x + 0.001, 0, 0], [x, 0.001, 0]]; });
    const positions = new Float32Array([...tallDome, ...mesh(fragments)]);
    assert.equal(detectToothRegions(positions, settings).candidates.length, 1);
  }
});

test('internal time budget aborts rather than returning a partial proposal', () => {
  const previous = globalThis.performance;
  let clock = 0;
  try {
    globalThis.performance = { now: () => (clock++ ? 9000 : 0) };
    assert.throws(() => detectToothRegions(arch(3).positions, settings), /8 second limit/i);
  } finally { globalThis.performance = previous; }
});

test('proposal count is capped at 32 and discarded shell triangles remain unassigned', () => {
  const parts = Array.from({ length: 40 }, (_, i) => dome([i * 4, 0, 0]));
  const positions = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) { positions.set(part, offset); offset += part.length; }
  const scan = detectToothRegions(positions, settings);
  assert.equal(scan.candidates.length, 32);
  assert.ok(scan.warnings.some(w => /only the 32 strongest/i.test(w)));
  validate(scan, positions);
});

test('malformed, nonfinite and over-cap inputs fail clearly; degenerates stay unassigned', () => {
  assert.throws(() => detectToothRegions(new Float32Array(10), settings), /complete/i);
  assert.throws(() => detectToothRegions(mesh([[[0, 0, 0], [1, 0, 0], [0, NaN, 0]]]), settings), /finite/i);
  assert.throws(() => detectToothRegions(new Float32Array(1_000_001 * 9), settings), /at most 1,000,000/i);
  assert.equal(detectToothRegions(new Float32Array(), settings).candidates.length, 0);
  const { positions } = arch(3), appended = new Float32Array([...positions, ...new Array(9).fill(0)]), scan = detectToothRegions(appended, settings);
  assert.equal(scan.candidates.length, 3);
  assert.ok(scan.candidates.every(c => !c.faces.includes(appended.length / 9 - 1)));
  assert.ok(scan.warnings.some(w => /degenerate/i.test(w)));
  assert.throws(() => detectToothRegions(positions, { ...settings, direction: 'sideways' }), /axis/i);
});

test('unknown, neutral and weak color cues preserve the exact geometry-only fallback', () => {
  const { positions } = arch(3), baseline = detectToothRegions(positions, settings);
  for (const score of [-1, 0, 0.4]) {
    const cues = new Float32Array(positions.length / 9).fill(score), original = cues.slice();
    assert.deepEqual(detectToothRegions(positions, settings, cues), baseline);
    assert.deepEqual(cues, original, 'detection never edits source cues');
  }
});

test('strong gingiva cues conservatively restrict crown shoulders without inventing seeds', () => {
  const { positions } = arch(3), explicit = { ...settings, direction: '+z' };
  const baseline = detectToothRegions(positions, explicit);
  const cues = Float32Array.from({ length: positions.length / 9 }, (_, f) => centroid(positions, f)[2] < 1.8 ? 1 : -1);
  const original = cues.slice(), scan = detectToothRegions(positions, explicit, cues);
  validate(scan, positions);
  assert.deepEqual(scan.candidates.map(c => c.id), baseline.candidates.map(c => c.id));
  let removed = 0;
  for (const candidate of scan.candidates) {
    const before = baseline.candidates.find(c => c.id === candidate.id), originalFaces = new Set(before.faces);
    assert.ok([...candidate.faces].every(f => originalFaces.has(f)), 'cues cannot grow a baseline region on these separated crowns');
    removed += before.faces.length - candidate.faces.length;
  }
  assert.ok(removed > 0, 'strong tissue costs reduce growth across the pink shoulders');
  assert.ok(scan.unassignedTriangles > baseline.unassignedTriangles);
  assert.match(scan.warnings.join(' '), /color is not a tissue diagnosis/i);
  assert.deepEqual(scan, detectToothRegions(positions, explicit, cues));
  assert.deepEqual(cues, original);
  const flat = positions.slice();
  for (let i = 2; i < flat.length; i += 3) flat[i] = 0;
  assert.equal(detectToothRegions(flat, explicit, cues).candidates.length, 0, 'color never creates a geometric crown');
});

test('gingiva costs at a geometric seed are soft penalties and keep a supported crown', () => {
  const positions = dome(), explicit = { ...settings, direction: '+z' };
  const baseline = detectToothRegions(positions, explicit), seed = baseline.candidates[0].seed.face;
  const cues = new Float32Array(positions.length / 9).fill(-1); cues[seed] = 1;
  const scan = detectToothRegions(positions, explicit, cues);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].seed.face, seed);
  assert.ok(scan.candidates[0].faces.length <= baseline.candidates[0].faces.length, 'a seed penalty cannot expand this isolated crown');
  validate(scan, positions);
});

test('a broad tissue-colored shoulder is judged before color can trim it into a cap', () => {
  const positions = dome(), explicit = { ...settings, direction: '+z' };
  for (let i = 2; i < positions.length; i += 3) positions[i] *= 0.6;
  const baseline = detectToothRegions(positions, explicit);
  assert.equal(baseline.candidates.length, 1, 'without color this dome is an ambiguous crown hypothesis');
  assert.equal(baseline.candidates[0].evidence.reliefReference, 'estimated-base');
  const colored = detectToothRegions(positions, explicit, new Float32Array(positions.length / 9).fill(1));
  assert.equal(colored.candidates.length, 0, 'whole-shoulder color support is not erased by the restricted growth front');
  assert.match(colored.warnings.join(' '), /color is not a tissue diagnosis/i);
  validate(colored, positions);
});

test('local shoulder evidence scales as file area without changing a source or identifying a tooth', () => {
  const positions = dome(), explicit = { ...settings, direction: '+z' };
  const baseline = detectToothRegions(positions, explicit).candidates[0];
  const scaled = detectToothRegions(transform(positions, 8, [0, 0, 0], false), explicit).candidates[0];
  assert.equal(scaled.id, baseline.id);
  assert.ok(Math.abs(scaled.evidence.shoulderProjectedArea / baseline.evidence.shoulderProjectedArea - 64) < 0.001);
  assert.equal(scaled.evidence.shoulderTissueCost, 0, 'unknown/neutral color is not evidence of enamel');
  assert.equal(scaled.evidence.reliefReference, baseline.evidence.reliefReference);
  assert.ok(!('fdi' in scaled) && !('confidence' in scaled.evidence));
});

test('malformed color cue arrays fail clearly instead of silently misaligning faces', () => {
  const positions = dome(), count = positions.length / 9;
  for (const cues of [[], new Float64Array(count), new Float32Array(count - 1)]) {
    assert.throws(() => detectToothRegions(positions, settings, cues), /one Float32Array score per face/i);
  }
  for (const value of [NaN, Infinity, -Infinity, -0.1, -2, 1.01]) {
    const cues = new Float32Array(count).fill(-1); cues[count - 1] = value;
    assert.throws(() => detectToothRegions(positions, settings, cues), /unknown.*finite scores from 0 to 1/i);
  }
});

test('worker echoes request IDs, transfers only result face arrays, and reports errors', async () => {
  const previousMessage = globalThis.onmessage, previousPost = globalThis.postMessage, messages = [];
  try {
    globalThis.postMessage = (message, transfer) => messages.push({ message, transfer });
    await import('../src/auto-tooth.worker.ts');
    const { positions } = arch(3), original = positions.slice();
    globalThis.onmessage({ data: { id: 42, positions, settings } });
    assert.equal(messages[0].message.id, 42);
    assert.equal(messages[0].message.scan.candidates.length, 3);
    assert.deepEqual(messages[0].transfer, messages[0].message.scan.candidates.map(c => c.faces.buffer));
    assert.ok(!messages[0].transfer.includes(positions.buffer));
    assert.deepEqual(positions, original);
    globalThis.onmessage({ data: { id: 43, positions: new Float32Array(2), settings } });
    assert.equal(messages[1].message.id, 43);
    assert.match(messages[1].message.error, /complete/i);
    globalThis.onmessage({ data: { id: 1.5, positions, settings } });
    assert.match(messages[2].message.error, /safe integer/i);
    const tissueScores = Float32Array.from({ length: positions.length / 9 }, (_, f) => centroid(positions, f)[2] < 1.8 ? 1 : -1), originalCues = tissueScores.slice();
    globalThis.onmessage({ data: { id: 44, positions, settings, tissueScores } });
    assert.equal(messages[3].message.id, 44);
    assert.deepEqual(messages[3].message.scan, detectToothRegions(positions, settings, tissueScores));
    assert.ok(!messages[3].transfer.includes(tissueScores.buffer));
    assert.deepEqual(tissueScores, originalCues);
    globalThis.onmessage({ data: { id: 45, positions, settings, tissueScores: new Float32Array(1) } });
    assert.match(messages[4].message.error, /per face/i);
  } finally { globalThis.onmessage = previousMessage; globalThis.postMessage = previousPost; }
});

// Exercise the hook's asynchronous ownership without a DOM, network or new test
// dependencies. The small hook host runs effects after render, including the
// interval in which a stale asynchronous result can arrive before those effects.
function hookHost(useAutoTeeth, initialPart) {
  const slots = [];
  let cursor = 0, dirty = false, pending = [], part = initialPart, view;
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(create, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: create() };
      return slots[i].value;
    },
    useEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (changed(previous?.deps, deps)) {
        const slot = { deps, cleanup: previous?.cleanup }; slots[i] = slot;
        pending.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
  };
  return {
    render(next = part, effects = true) {
      part = next;
      for (let pass = 0; pass < 20; pass++) {
        globalThis.__autoToothTestHooks = hooks;
        cursor = 0; dirty = false; view = useAutoTeeth([part], part.id, false);
        if (!effects) return view;
        const queued = pending; pending = []; queued.forEach(effect => effect());
        if (!dirty) return view;
      }
      throw new Error('The hook did not settle.');
    },
    dispose() { slots.forEach(slot => slot.cleanup?.()); },
  };
}

test('scan input replacement invalidates cached views, transfers cloned cues and cancels stale identification', async () => {
  const { registerHooks } = await import('node:module');
  const url = new URL('../src/useAutoTeeth.ts?geometry-input-tests', import.meta.url).href;
  const dataModule = code => `data:text/javascript,${encodeURIComponent(code)}`;
  const react = dataModule(['useState', 'useRef', 'useMemo', 'useEffect'].map(name => `export const ${name} = (...args) => globalThis.__autoToothTestHooks.${name}(...args);`).join('\n'));
  const views = dataModule('export const renderToothViews = (...args) => globalThis.__autoToothTestViews ? globalThis.__autoToothTestViews(...args) : [{label:"local",mediaType:"image/jpeg",base64:"AA=="}];');
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === url) {
      if (specifier === 'react') return { url: react, shortCircuit: true };
      if (specifier === './auto-tooth-views') return { url: views, shortCircuit: true };
      if (specifier.startsWith('./')) return next(new URL(`${specifier}.ts`, url).href, context);
    }
    return next(specifier, context);
  } });
  let useAutoTeeth;
  try { ({ useAutoTeeth } = await import(url)); } finally { loader.deregister(); }
  const previous = { Worker: globalThis.Worker, fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame, hooks: globalThis.__autoToothTestHooks, views: globalThis.__autoToothTestViews };
  const workers = [], requests = [];
  let host;
  try {
    globalThis.Worker = class {
      terminated = false;
      constructor() { workers.push(this); }
      postMessage(message, transfer) { this.message = structuredClone(message, { transfer }); }
      terminate() { this.terminated = true; }
      reply(scan) { this.onmessage({ data: { id: this.message.id, scan } }); }
    };
    globalThis.fetch = (path, options) => {
      if (path === '/api/teeth/status') return Promise.resolve({ ok: true, json: async () => ({ configured: true }) });
      assert.equal(path, '/api/teeth/identify');
      return new Promise(resolve => requests.push({ signal: options.signal, payload: JSON.parse(options.body), resolve }));
    };
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    const positions = dome(), scan = detectToothRegions(positions, settings), n = positions.length / 9;
    let part = {
      id: 'same-arch', role: 'upper', positions, normals: positions.slice(),
      uvs: new Float32Array(n * 6), colors: new Float32Array(n * 9), tissueScores: new Float32Array(n).fill(-1),
      texture: { fileName: 'scan.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }, textureStatus: 'mapped',
    };
    host = hookHost(useAutoTeeth, part);
    let view = host.render();
    await new Promise(resolve => setImmediate(resolve)); view = host.render();
    assert.equal(view.configured, true);
    assert.notEqual(workers[0].message.positions.buffer, part.positions.buffer);
    assert.notEqual(workers[0].message.tissueScores.buffer, part.tissueScores.buffer);
    assert.deepEqual(workers[0].message.tissueScores, part.tissueScores);
    assert.equal(part.tissueScores.byteLength, n * 4, 'worker transfer never detaches imported cues');
    workers[0].reply(scan); view = host.render();
    assert.equal(view.proposal.scan.candidates.length, 1);

    for (const replace of [
      source => ({ ...source, uvs: source.uvs.slice() }),
      source => ({ ...source, colors: source.colors.slice() }),
      source => ({ ...source, tissueScores: source.tissueScores.slice() }),
      source => ({ ...source, texture: { ...source.texture, bytes: source.texture.bytes.slice() } }),
      source => ({ ...source, textureStatus: 'unmapped' }),
    ]) {
      await view.prepareViews(); view = host.render();
      assert.equal(view.proposal.views.length, 1);
      const count = workers.length, stale = workers.at(-1);
      part = replace(part); view = host.render(part);
      assert.equal(workers.length, count + 1, 'same-id scan input replacement starts a new local scan');
      assert.equal(view.proposal, null, 'cached regions and images are invalidated');
      stale.reply(scan); view = host.render();
      assert.equal(view.proposal, null, 'an old worker cannot restore the old proposal');
      workers.at(-1).reply(scan); view = host.render();
    }
    const beforeMove = view.proposal, count = workers.length;
    part = { ...part, offset: [1, 2, 3] }; view = host.render(part);
    assert.equal(workers.length, count, 'presentation transforms do not rerun local geometry');
    assert.equal(view.proposal, beforeMove);

    let finishViews, viewSignal;
    globalThis.__autoToothTestViews = (_part, _scan, signal) => new Promise(resolve => { finishViews = resolve; viewSignal = signal; });
    const staleViews = view.prepareViews();
    await Promise.resolve(); view = host.render();
    part = { ...part, colors: part.colors.slice() }; view = host.render(part);
    assert.equal(viewSignal.aborted, true, 'input replacement cancels pending image decoding');
    finishViews([{ label: 'stale', mediaType: 'image/jpeg', base64: 'AA==' }]);
    await staleViews; view = host.render();
    assert.equal(view.proposal, null, 'cancelled views cannot attach to the replacement scan');
    globalThis.__autoToothTestViews = undefined;
    workers.at(-1).reply(scan); view = host.render();

    const ready = async () => {
      await view.prepareViews(); view = host.render();
      view.setPatientRight('image-left'); view = host.render();
      view.mapCandidate(1, 18); view = host.render();
    };
    const response = () => ({ ok: true, json: async () => ({ model: 'test-model', mappings: [{ candidateId: 1, fdi: 16, needsReview: false, reason: 'Suggestion' }], possibleMissing: [], warnings: [] }) });
    await ready();
    const staleIdentification = view.identify(); view = host.render();
    assert.equal(requests.length, 1);
    part = { ...part, texture: { ...part.texture, bytes: new Uint8Array([4, 5, 6]) } };
    view = host.render(part, false);
    requests[0].resolve(response()); await staleIdentification;
    view = host.render(part, false);
    assert.equal(view.proposal.model, null, 'a changed input rejects results even before invalidation effects run');
    assert.equal(view.proposal.mappings[0].fdi, 18);
    view = host.render();
    assert.equal(requests[0].signal.aborted, true, 'input invalidation aborts the in-flight identification');
    assert.equal(view.proposal, null);

    workers.at(-1).reply(scan); view = host.render(); await ready();
    view.setModel('claude-opus-5-5'); view = host.render();
    const currentIdentification = view.identify();
    view = host.render();
    assert.equal(requests[1].payload.model, 'claude-opus-5-5', 'the selected model is sent with the rendered scan request');
    view.setModel('claude-haiku-5-5'); view = host.render();
    assert.equal(view.model, 'claude-opus-5-5', 'model selection is locked while identification is running');
    requests[1].resolve(response()); await currentIdentification; view = host.render();
    assert.equal(view.proposal.model, 'test-model');
    assert.equal(view.proposal.mappings[0].fdi, 18, 'the corrected mapping merge stays authoritative');
    assert.equal(view.proposal.mappings[0].source, 'user');
  } finally {
    host?.dispose();
    globalThis.Worker = previous.Worker; globalThis.fetch = previous.fetch;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame; globalThis.__autoToothTestHooks = previous.hooks; globalThis.__autoToothTestViews = previous.views;
  }
});

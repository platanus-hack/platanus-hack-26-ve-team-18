import * as THREE from 'three';
import type { ModelPart, Vec3 } from './models';
import type { AutoToothScan, AutoToothView } from './auto-tooth-types';
import { createSurfaceTexture, hasSurfaceTexture, surfaceColor, type SurfaceTexture } from './viewer.ts';

const WIDTH = 960;
const HEIGHT = 720;
const FOV_DEGREES = 35;
const JPEG_QUALITY = 0.88;
/** Keeps all bounding-box corners inside this fraction of the half-viewport. */
const FIT_LIMIT = 0.92;
const NEUTRAL_HEX = '#cdd5df';

interface ViewSpec {
  label: string;
  direction: THREE.Vector3;
  up: THREE.Vector3;
  /** Flips the image horizontally so screen right is always +u. */
  mirror: boolean;
}

function unitVector(value: Vec3, name: string): THREE.Vector3 {
  const vector = new THREE.Vector3(...value);
  const length = vector.length();
  if (!Number.isFinite(length) || length === 0) throw new Error(`The scan frame ${name} is not a usable direction.`);
  return vector.divideScalar(length);
}

/**
 * Four fixed views. Overview looks down the frame up axis with v on screen up and u on screen right.
 * A left-handed frame cannot satisfy both with that view side, so the overview is mirrored instead.
 */
function viewSpecs(scan: AutoToothScan): ViewSpec[] {
  const up = unitVector(scan.frame.up, 'up');
  const u = unitVector(scan.frame.u, 'u');
  const v = unitVector(scan.frame.v, 'v');
  const mirror = new THREE.Vector3().crossVectors(v, up).dot(u) < 0;
  const oblique = (lateral: THREE.Vector3, sign: number) => up.clone().addScaledVector(lateral, 0.8 * sign).normalize();
  return [
    { label: 'Occlusal overview', direction: up.clone(), up: v.clone(), mirror },
    { label: 'Oblique +u', direction: oblique(u, 1), up: v.clone(), mirror: false },
    { label: 'Oblique -u', direction: oblique(u, -1), up: v.clone(), mirror: false },
    { label: 'Oblique +v', direction: oblique(v, 1), up: u.clone(), mirror: false },
  ];
}

/** Blue shades step through 32 values coprime with the step, so neighbouring candidates differ. */
function candidateShade(index: number): THREE.Color {
  const step = ((index * 7) % 32) / 31;
  return new THREE.Color().setHSL(0.6, 0.8, 0.42 + 0.36 * step, THREE.SRGBColorSpace);
}

function bounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  if (positions.length < 9) throw new Error('The scan has no triangles to show.');
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}

/**
 * Smallest distance at which all eight bounding-box corners fit the frame.
 * Corners are a superset of the geometry, so the whole mesh and its annotations fit.
 */
function fitDistance(corners: THREE.Vector3[], spec: ViewSpec, radius: number): number {
  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, WIDTH / HEIGHT, radius * 0.01, radius * 100);
  const fits = (distance: number) => {
    camera.position.copy(spec.direction).multiplyScalar(distance);
    camera.up.copy(spec.up);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return corners.every(corner => {
      const point = corner.clone().project(camera);
      return Math.abs(point.x) <= FIT_LIMIT && Math.abs(point.y) <= FIT_LIMIT && point.z >= -1 && point.z <= 1;
    });
  };
  // At 8 radii the sphere enclosing the box subtends under 8 degrees, which always fits.
  let near = 0, far = radius * 8;
  if (!fits(far)) throw new Error('The scan could not be framed for identification images.');
  for (let step = 0; step < 40; step++) {
    const middle = (near + far) / 2;
    if (fits(middle)) far = middle; else near = middle;
  }
  return far;
}

function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.setClearColor(0xffffff, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    return renderer;
  } catch {
    throw new Error('WebGL could not start, so identification images cannot be prepared. Enable hardware acceleration or use another browser, then retry.');
  }
}

function drawLabel(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  context.font = '600 22px system-ui, -apple-system, Segoe UI, sans-serif';
  const width = context.measureText(text).width + 12;
  const height = 28;
  const left = Math.min(Math.max(x - width / 2, 2), WIDTH - width - 2);
  const top = Math.min(Math.max(y - height / 2, 2), HEIGHT - height - 2);
  context.fillStyle = 'rgba(255, 255, 255, 0.94)';
  context.fillRect(left, top, width, height);
  context.strokeStyle = '#1e3a5f';
  context.lineWidth = 1.5;
  context.strokeRect(left, top, width, height);
  context.fillStyle = '#0f172a';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, left + width / 2, top + height / 2 + 1);
}

/**
 * Renders a natural-color overview followed by three candidate-colored oblique views, all with
 * visible C<id> labels at seeds and fixed lighting. The geometry is recentred only in the presentation mesh, so the user's
 * viewport, pose, and part data are never changed. Candidate ids in the labels match the request.
 */
export async function renderToothViews(part: ModelPart, scan: AutoToothScan, signal?: AbortSignal): Promise<AutoToothView[]> {
  signal?.throwIfAborted();
  if (typeof document === 'undefined') throw new Error('Tooth identification images can only be prepared in a browser.');
  // An edentulous, partial or flat source is still useful case evidence.
  // An empty candidate list supplies no tooth identities, but must remain renderable.
  const { min, max } = bounds(part.positions);
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const halfExtent = new THREE.Vector3(max[0] - center[0], max[1] - center[1], max[2] - center[2]);
  const radius = halfExtent.length();
  if (!(radius > 0)) throw new Error('The scan has no volume to frame.');
  const corners = [-1, 1].flatMap(sx => [-1, 1].flatMap(sy => [-1, 1].map(sz =>
    new THREE.Vector3(sx * halfExtent.x, sy * halfExtent.y, sz * halfExtent.z))));
  const triangles = part.positions.length / 9;
  const specs = viewSpecs(scan);

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const frame = document.createElement('canvas');
  frame.width = WIDTH;
  frame.height = HEIGHT;
  const context = frame.getContext('2d');
  if (!context) throw new Error('This browser cannot draw identification images.');

  // Decode before opening the disposable WebGL context; every path releases the image as well.
  let renderer: THREE.WebGLRenderer | undefined;
  let surface: SurfaceTexture | undefined;
  const cancelTexture = () => surface?.dispose();
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  try {
    if (hasSurfaceTexture(part)) {
      surface = createSurfaceTexture(part.texture!);
      signal?.addEventListener('abort', cancelTexture, { once: true });
      try { await surface.ready; }
      catch { signal?.throwIfAborted(); throw new Error('The local texture image could not be decoded. Reattach a usable JPEG/PNG before preparing views.'); }
      signal?.throwIfAborted();
      geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs!, 2));
    }
    renderer = createRenderer(canvas);
    const displayPositions = new Float32Array(part.positions.length);
    for (let i = 0; i < part.positions.length; i++) displayPositions[i] = part.positions[i] - center[i % 3];
    geometry.setAttribute('position', new THREE.BufferAttribute(displayPositions, 3));
    if (part.normals.length === part.positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
    else geometry.computeVertexNormals();

    const neutral = new THREE.Color(NEUTRAL_HEX);
    const colors = new Float32Array(part.positions.length);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = neutral.r; colors[i + 1] = neutral.g; colors[i + 2] = neutral.b; }
    const naturalColors = new Float32Array(part.positions.length);
    const naturalColor = new THREE.Color();
    for (let corner = 0; corner < naturalColors.length / 3; corner++) {
      surfaceColor(part, corner, !!surface, naturalColor).toArray(naturalColors, corner * 3);
    }
    const candidateAt = new Uint32Array(triangles);
    scan.candidates.forEach((candidate, index) => {
      const shade = candidateShade(index);
      for (const face of candidate.faces) {
        if (!Number.isInteger(face) || face < 0 || face >= triangles) throw new Error('Candidate triangles do not match the scan geometry.');
        candidateAt[face] = index + 1;
        for (let corner = 0; corner < 3; corner++) {
          const offset = face * 9 + corner * 3;
          colors[offset] = shade.r; colors[offset + 1] = shade.g; colors[offset + 2] = shade.b;
        }
      }
    });
    const candidateColors = new THREE.BufferAttribute(colors, 3);
    const naturalAttribute = new THREE.BufferAttribute(naturalColors, 3);
    geometry.setAttribute('color', naturalAttribute);

    // Presentation-only: the mesh is shifted so its bounding-box centre sits at the origin.
    const mesh = new THREE.Mesh(geometry, material);
    const scene = new THREE.Scene();
    scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.5, 1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1, -0.5, -1);
    scene.add(key, fill);

    return specs.map((spec, viewIndex) => {
      signal?.throwIfAborted();
      // The first image preserves enamel/gingiva cues. Later images expose region boundaries.
      const natural = viewIndex === 0;
      const attribute = geometry.getAttribute('color') as THREE.BufferAttribute;
      attribute.copyArray(natural ? naturalAttribute.array : candidateColors.array);
      attribute.needsUpdate = true;
      material.map = natural && surface ? surface.texture : null;
      material.needsUpdate = true;
      const distance = fitDistance(corners, spec, radius);
      const camera = new THREE.PerspectiveCamera(FOV_DEGREES, WIDTH / HEIGHT, radius * 0.01, radius * 100);
      camera.position.copy(spec.direction).multiplyScalar(distance);
      camera.up.copy(spec.up);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      renderer!.render(scene, camera);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.save();
      if (spec.mirror) { context.translate(WIDTH, 0); context.scale(-1, 1); }
      context.drawImage(canvas, 0, 0, WIDTH, HEIGHT);
      context.restore();

      const ray = new THREE.Raycaster();
      scan.candidates.forEach((candidate, index) => {
        const seed = candidate.seed.point;
        const projected = new THREE.Vector3(seed[0] - center[0], seed[1] - center[1], seed[2] - center[2]).project(camera);
        if (projected.z < -1 || projected.z > 1) return;
        // A hidden crown must not borrow the visible surface's label in an oblique view.
        ray.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
        const hit = ray.intersectObject(mesh, false)[0];
        if (!hit || hit.faceIndex == null || candidateAt[hit.faceIndex] !== index + 1) return;
        const x = (projected.x + 1) / 2 * WIDTH;
        const y = (1 - projected.y) / 2 * HEIGHT;
        drawLabel(context, `C${candidate.id}`, spec.mirror ? WIDTH - x : x, y);
      });
      const dataUrl = frame.toDataURL('image/jpeg', JPEG_QUALITY);
      return { label: spec.label, mediaType: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
    });
  } finally {
    // Runs on success and on errors. Releasing the context matters: browsers cap live WebGL contexts.
    geometry.dispose();
    material.dispose();
    signal?.removeEventListener('abort', cancelTexture);
    surface?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}

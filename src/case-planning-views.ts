import * as THREE from 'three';
import type { ModelPart } from './models';
import type { AutoToothView } from './auto-tooth-types';
import { partMatrix, posedPositions } from './pose.ts';
import { createSurfaceTexture, hasSurfaceTexture, type SurfaceTexture } from './viewer.ts';

const WIDTH = 960;
const HEIGHT = 720;
const FOV_DEGREES = 35;
const FIT_LIMIT = 0.92;
const JPEG_QUALITY = 0.88;

interface ViewSpec {
  label: string;
  /** Camera side in workspace coordinates, looking toward the shared centre. */
  direction: THREE.Vector3;
  up: THREE.Vector3;
}

function viewSpecs(): ViewSpec[] {
  // These axes are geometric conventions, not anatomical directions.
  return [
    { label: '3D', direction: new THREE.Vector3(1, -1, 0.8).normalize(), up: new THREE.Vector3(0, 0, 1) },
    { label: '+X', direction: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
    { label: '-Y', direction: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
    { label: '+Z', direction: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  ];
}

function cameraFor(spec: ViewSpec, corners: THREE.Vector3[], radius: number): THREE.PerspectiveCamera {
  const right = new THREE.Vector3().crossVectors(spec.up, spec.direction).normalize();
  const up = new THREE.Vector3().crossVectors(spec.direction, right);
  const tanY = Math.tan(FOV_DEGREES * Math.PI / 360) * FIT_LIMIT;
  const tanX = tanY * WIDTH / HEIGHT;
  // Each corner must fit horizontally and vertically at its own camera depth.
  // Starting beyond the enclosing sphere also keeps every corner past the near plane.
  let distance = radius * 1.02;
  for (const corner of corners) {
    const depth = corner.dot(spec.direction);
    distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanX, depth + Math.abs(corner.dot(up)) / tanY);
  }
  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, WIDTH / HEIGHT, radius * 0.01, radius * 100);
  camera.position.copy(spec.direction).multiplyScalar(distance);
  camera.up.copy(up);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/**
 * Whole-arch evidence in the current static pose. All arch components are included,
 * even when hidden in the interactive viewport; roles, never filenames, select them.
 * One common presentation translation preserves the upper/lower relationship.
 */
export async function renderCasePlanningViews(parts: ModelPart[], signal?: AbortSignal): Promise<AutoToothView[]> {
  signal?.throwIfAborted();
  if (typeof document === 'undefined') throw new Error('Case planning images can only be prepared in a browser.');
  const arches = parts.filter(part => part.role === 'upper' || part.role === 'lower');
  if (!arches.length) throw new Error('Assign an upper or lower arch before preparing case planning images.');

  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  const sources = arches.map(part => {
    if (part.positions.length < 9 || part.positions.length % 9 !== 0) throw new Error('An arch has no usable triangle geometry.');
    if (part.colors && (part.colors.length !== part.positions.length || part.colors.some(value => !Number.isFinite(value)))) {
      throw new Error('Arch vertex colors do not match the geometry.');
    }
    const positions = posedPositions(part);
    for (let i = 0; i < positions.length; i += 3) {
      point.fromArray(positions, i);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
        throw new Error('An arch has non-finite coordinates in its current pose.');
      }
      bounds.expandByPoint(point);
    }
    return { part, positions };
  });
  const center = bounds.getCenter(new THREE.Vector3());
  const halfExtent = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const radius = halfExtent.length();
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('The arches have no usable extent to frame.');
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z =>
    new THREE.Vector3(x * halfExtent.x, y * halfExtent.y, z * halfExtent.z))));

  const canvas = document.createElement('canvas');
  const scene = new THREE.Scene();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const surfaces: SurfaceTexture[] = [];
  let textureMapFailed = false;
  let context: WebGL2RenderingContext | null = null;
  let renderer: THREE.WebGLRenderer | undefined;
  const cancelTextures = () => { for (const surface of surfaces) surface.dispose(); };
  signal?.addEventListener('abort', cancelTextures, { once: true });
  try {
    for (const { part, positions } of sources) {
      signal?.throwIfAborted();
      let surface: SurfaceTexture | undefined;
      if (hasSurfaceTexture(part) && part.uvs!.every(Number.isFinite)) {
        surface = createSurfaceTexture(part.texture!);
        surfaces.push(surface);
        // Decode local bytes before opening the disposable WebGL context.
        try { await surface.ready; }
        catch {
          signal?.throwIfAborted();
          surface.dispose();
          surface = undefined;
          textureMapFailed = true;
        }
        signal?.throwIfAborted();
      } else if (part.textureStatus === 'mapped' && !part.presentationColor) {
        textureMapFailed = true;
      }
      const geometry = new THREE.BufferGeometry();
      geometries.push(geometry);
      const displayPositions = new Float32Array(positions.length);
      // Subtract in double precision before creating GPU positions. A mesh transform
      // after Float32 conversion would lose detail at large workspace translations.
      for (let i = 0; i < positions.length; i += 3) {
        displayPositions[i] = positions[i] - center.x;
        displayPositions[i + 1] = positions[i + 1] - center.y;
        displayPositions[i + 2] = positions[i + 2] - center.z;
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(displayPositions, 3));
      if (part.normals.length === positions.length && part.normals.every(Number.isFinite)) {
        const normals = new THREE.BufferAttribute(new Float32Array(part.normals), 3);
        normals.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(partMatrix(part)));
        geometry.setAttribute('normal', normals);
      } else {
        geometry.computeVertexNormals();
      }
      if (surface) geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs!, 2));
      // A map carries the albedo itself; sampled colors would multiply and darken it.
      // Without a usable map, ModelPart colors remain the linear RGB fallback.
      const useColors = !surface && !!part.colors;
      if (useColors) geometry.setAttribute('color', new THREE.BufferAttribute(part.colors!, 3));
      const material = new THREE.MeshStandardMaterial({
        map: surface?.texture ?? null,
        color: surface || useColors ? 0xffffff : '#cdd5df', vertexColors: useColors,
        roughness: 0.7, metalness: 0, side: THREE.DoubleSide,
      });
      materials.push(material);
      scene.add(new THREE.Mesh(geometry, material));
    }
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.5, 2);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1, 1, -1);
    scene.add(key, fill);

    try {
      // Retain the context separately so constructor failures can release it too.
      context = canvas.getContext('webgl2', { alpha: false, antialias: true, preserveDrawingBuffer: true });
      if (!context) throw new Error('WebGL2 is unavailable.');
      renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch {
      throw new Error('WebGL could not start, so case planning images cannot be prepared. Enable hardware acceleration or use another browser, then retry.');
    }
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.setClearColor(0xffffff, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    return viewSpecs().map(spec => {
      signal?.throwIfAborted();
      if (context!.isContextLost()) throw new Error('WebGL was interrupted while preparing case planning images. Retry the request.');
      renderer!.render(scene, cameraFor(spec, corners, radius));
      if (context!.isContextLost()) throw new Error('WebGL was interrupted while preparing case planning images. Retry the request.');
      // No overlays, filenames, anatomical labels, or other text enter the pixels.
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      const prefix = 'data:image/jpeg;base64,';
      if (!dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) throw new Error('The browser could not export case planning images.');
      const label = textureMapFailed ? `${spec.label} (geometry only: texture map unavailable)` : spec.label;
      return { label, mediaType: 'image/jpeg', base64: dataUrl.slice(prefix.length) };
    });
  } finally {
    signal?.removeEventListener('abort', cancelTextures);
    try {
      try {
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
        scene.clear();
      } finally {
        for (const surface of surfaces) surface.dispose();
      }
    } finally {
      try {
        renderer?.dispose();
      } finally {
        try {
          if (renderer) renderer.forceContextLoss();
          else context?.getExtension('WEBGL_lose_context')?.loseContext();
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }
  }
}

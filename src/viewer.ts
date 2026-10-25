import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ModelPart, Vec3 } from './models';
import type { CollisionReport } from './collision';
import { collisionSampleState } from './presentation.ts';
import { partMatrix } from './pose.ts';
import { fitCameraToBounds, InspectionCamera } from './camera.ts';
import type { SurfaceAnchor, ToothEditEvent, ToothTool } from './tooth-types';
import { candidateToothDisplay, toothDisplay, type ToothDisplayViewState } from './tooth-display.ts';
import { buildCrownMesh, templateShape } from './crown-anatomy.ts';
import { displayNormals, restorationAppearance } from './restoration-appearance.ts';
import { crownEnamel } from './crown-enamel.ts';
import { projectMeshBounds, type ProjectionTarget, type ScreenBounds } from './viewport-projection.ts';
import { resolveMeasurement, type Measurement, type MeasurementAnchor, type RulerState } from './measurement.ts';

export interface Probe {
  id: string;
  face: number;
  vertex: number;
  position: Vec3;
  distance: number | null;
  intersecting: boolean;
}
export type View = 'perspective' | 'front' | 'top' | 'right';
export interface ViewerCapture {
  dataUrl: string;
  width: number;
  height: number;
  camera: { position: Vec3; target: Vec3; up: Vec3; verticalFovDegrees: number; aspect: number; near: number; far: number; workspaceToCamera: number[]; projectionMatrix: number[] };
}
export type NavigationMode = 'orbit' | 'pan';
const zDirections: Record<View, Vec3> = { perspective: [1, -1.6, 0.6], front: [0, -1, 0], top: [0, -0.001, 1], right: [1, 0, 0] };
const directions: Record<View, Vec3> = { perspective: [1, 0.65, 1.4], front: [0, 0, 1], top: [0, 1, 0.001], right: [1, 0, 0] };
const neutral = new THREE.Color('#b5c9df');
const near = new THREE.Color('#e8ac44');
const contact = new THREE.Color('#d84d45');
const deep = new THREE.Color('#8e2438');
const toothSelected = new THREE.Color('#3987df');
const toothAssigned = new THREE.Color('#91b3d4');
const toothExcluded = new THREE.Color('#64748b');
const toothDraft = new THREE.Color('#22d3ee');

/** A detached image without a complete UV attribute must never become a surface map. */
export function hasSurfaceTexture(part: ModelPart): boolean {
  return !part.presentationColor && !!part.texture?.bytes.length && !!part.uvs
    && part.uvs.length === part.positions.length / 3 * 2
    && part.textureStatus !== 'unmapped' && part.textureStatus !== 'vertex-colors';
}

export function surfaceColor(part: ModelPart, corner: number, mapped: boolean, target: THREE.Color): THREE.Color {
  const enamel = crownEnamel(part);
  if (enamel) return target.fromArray(enamel.colors, corner * 3);
  if (part.presentationColor) return target.set(part.presentationColor);
  if (mapped) return target.setRGB(1, 1, 1);
  if (part.colors?.length === part.positions.length) return target.fromArray(part.colors, corner * 3);
  return target.set(part.role === 'bite' ? '#6598c8' : part.role === 'lower' ? '#9fb5cd' : neutral);
}

export interface SurfaceTexture {
  texture: THREE.Texture;
  ready: Promise<void>;
  dispose: () => void;
}

/** Decodes only locally supplied bytes. Closing a pending load prevents a later GPU upload. */
export function createSurfaceTexture(source: NonNullable<ModelPart['texture']>): SurfaceTexture {
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  let disposed = false;
  let bitmap: ImageBitmap | undefined;
  let image: HTMLImageElement | undefined;
  let url: string | undefined;
  let cancelImage: (() => void) | undefined;
  const revoke = () => { if (url) { URL.revokeObjectURL(url); url = undefined; } };
  const ready = (async () => {
    const blob = new Blob([source.bytes.slice()], { type: source.mimeType });
    if (typeof createImageBitmap === 'function') {
      // ImageBitmap ignores Texture.flipY; decode in the orientation used by OBJ/PLY UVs.
      const decoded = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (disposed) { decoded.close(); return; }
      bitmap = decoded;
      texture.image = decoded;
      texture.flipY = false;
    } else {
      await new Promise<void>((resolve, reject) => {
        image = new Image();
        const clear = () => { if (image) { image.onload = null; image.onerror = null; } cancelImage = undefined; };
        cancelImage = () => { clear(); image?.removeAttribute('src'); reject(new Error('Local texture decoding was cancelled.')); };
        image.onload = () => { texture.image = image; clear(); resolve(); };
        image.onerror = () => { clear(); reject(new Error('The local texture image could not be decoded.')); };
        url = URL.createObjectURL(blob);
        image.src = url;
      });
    }
    if (!disposed) texture.needsUpdate = true;
  })().finally(revoke);
  return {
    texture, ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelImage?.(); revoke(); bitmap?.close(); texture.dispose();
    },
  };
}

/** Composite inspection colors after surface lighting so texture/shading cannot hide them. */
export function createInspectionMaterial(): THREE.MeshStandardMaterial {
  return withInspectionOverlay(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide }));
}

/**
 * Generated concept components get a display-only finish selected solely by
 * restoration metadata. The inspection overlay still replaces all lighting,
 * clearcoat and reflections wherever a collision or label color applies.
 */
export function createPartMaterial(part: ModelPart, environment: THREE.Texture | null = null): THREE.MeshStandardMaterial {
  const look = restorationAppearance(part);
  if (!look) return createInspectionMaterial();
  const enamel = crownEnamel(part);
  const material = withInspectionOverlay(new THREE.MeshPhysicalMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: look.roughness, metalness: look.metalness,
    clearcoat: look.clearcoat, clearcoatRoughness: look.clearcoatRoughness, envMap: environment, envMapIntensity: look.envMapIntensity,
  }), !!enamel, enamel?.variation);
  material.userData.presentation = { source: 'restoration-metadata', component: look.component, finish: look.finish, displayOnly: true,
    ...(enamel ? { colorSource: enamel.source, colorSamples: enamel.samples, interpretation: 'Illustrative scan colour approximation; not a calibrated dental shade.' } : {}) };
  return material;
}

function withInspectionOverlay<T extends THREE.MeshStandardMaterial>(material: T, enamel = false, variation = 0.065): T {
  const enamelVariation = { value: variation };
  if (enamel) material.userData.enamelVariation = enamelVariation;
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 inspectionOverlay;\nvarying vec4 vInspectionOverlay;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInspectionOverlay = inspectionOverlay;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vInspectionOverlay;')
      .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, vInspectionOverlay.rgb, vInspectionOverlay.a);\ndiffuseColor.a = mix(diffuseColor.a, opacity, vInspectionOverlay.a);\n#include <opaque_fragment>');
    if (enamel) {
      shader.uniforms = { ...shader.uniforms, enamelVariation };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 enamelCoordinate;\nvarying vec3 vEnamelCoordinate;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEnamelCoordinate = enamelCoordinate;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vEnamelCoordinate;
          uniform float enamelVariation;
          float enamelHash(vec3 p) {
            p = fract(p * 0.1031);
            p += dot(p, p.yzx + 33.33);
            return fract((p.x + p.y) * p.z);
          }
          float enamelNoise(vec3 p) {
            vec3 cell = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return 2.0 * mix(
              mix(mix(enamelHash(cell), enamelHash(cell + vec3(1,0,0)), f.x),
                  mix(enamelHash(cell + vec3(0,1,0)), enamelHash(cell + vec3(1,1,0)), f.x), f.y),
              mix(mix(enamelHash(cell + vec3(0,0,1)), enamelHash(cell + vec3(1,0,1)), f.x),
                  mix(enamelHash(cell + vec3(0,1,1)), enamelHash(cell + vec3(1,1,1)), f.x), f.y), f.z) - 1.0;
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Dimensionless local detail stays attached through pose/offset edits.
          vec3 enamelP = vEnamelCoordinate + vec3(7.2, 2.6, 4.1);
          float enamelMottle = clamp(1.8 * (0.72 * enamelNoise(enamelP * 3.2)
            + 0.28 * enamelNoise(enamelP * 8.5)), -1.0, 1.0);
          float enamelWarmth = enamelNoise(enamelP * 4.7 + vec3(3.1, 1.7, 5.4));
          float enamelGrain = enamelNoise(enamelP * 83.0);
          float enamelStriae = sin(vEnamelCoordinate.z * 205.0 + sin(vEnamelCoordinate.x * 19.0) + sin(vEnamelCoordinate.y * 23.0));
          // Yellow/blue temperature shifts keep green between red and blue,
          // avoiding a copied pink tissue tint. Bound noise to ten percent.
          vec3 enamelTint = enamelVariation * (vec3(enamelMottle) + vec3(0.16, 0.0, -0.38) * enamelWarmth);
          enamelTint += vec3(0.01 * enamelGrain + 0.003 * enamelStriae);
          diffuseColor.rgb *= vec3(1.0) + clamp(enamelTint, vec3(-0.1), vec3(0.1));`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + 0.035 * enamelMottle + 0.018 * enamelGrain + 0.006 * enamelStriae, 0.0, 1.0);');
    }
  };
  material.customProgramCacheKey = () => `platanus-inspection-overlay-v4${enamel ? '-enamel' : ''}`;
  return material;
}

const appearanceKey = (part: ModelPart) => restorationAppearance(part)?.key ?? 'scan';

interface PartTexture {
  bytes: Uint8Array;
  mimeType: string;
  load: SurfaceTexture;
}

export class MeshViewer {
  private scene = new THREE.Scene();
  private root = new THREE.Group();
  private camera = new InspectionCamera(40, 1, 0.01, 10000);
  private renderer: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private observer: ResizeObserver;
  private meshes = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>();
  private sources = new Map<string, ModelPart>();
  private textures = new Map<string, PartTexture>();
  private report: CollisionReport | null = null;
  private tolerance = 0.5;
  private heatmap = true;
  private wireframe = false;
  /** Generated once, only after a concept component is shown; never sampled per frame. */
  private environment: THREE.WebGLRenderTarget | null = null;
  private opacities: Readonly<Record<string, number>> = {};
  private selected: string | null = null;
  private navigationMode: NavigationMode = 'orbit';
  private bounds = new THREE.Box3();
  private radius = 1;
  private upAxis: 'y' | 'z' = 'z';
  private frame = 0;
  private disposed = false;
  private events = new AbortController();
  private toothView: ToothDisplayViewState | null = null;
  private editablePartIds = new Set<string>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private annotations = new THREE.Group();
  private markerGeometry = new THREE.SphereGeometry(1, 12, 8);
  private cancelGesture = () => {};
  private onNavigationMode: (mode: NavigationMode) => void;
  private onToothEdit: ((event: ToothEditEvent) => void) | undefined;
  private autoRegionLabels: Uint8Array | null = null;
  private fittedBounds: THREE.Box3 | null = null;
  private projectionTarget: { partIds: readonly string[]; onChange: (bounds: ScreenBounds | null) => void } | null = null;
  private rulerEnabled = false;
  private rulerAnchors: MeasurementAnchor[] = [];
  private measurement: Measurement = { points: [], distance: null };
  private rulerCleared = false;
  private rulerSnapshot = '';
  private onRulerChange?: (state: RulerState) => void;

  constructor(host: HTMLDivElement, onProbe: (probe: Probe) => void, onError: (message: string) => void, onNavigationMode: (mode: NavigationMode) => void = () => {}, onToothEdit?: (event: ToothEditEvent) => void, onRulerChange?: (state: RulerState) => void) {
    this.onNavigationMode = onNavigationMode;
    this.onToothEdit = onToothEdit;
    this.onRulerChange = onRulerChange;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', 'Interactive 3D mesh viewer. Orbit or pan with the toolbar, scroll to zoom, click to inspect, double-click to set the orbit pivot. With this canvas focused: F fits all, Shift+F focuses the selected model, Escape returns to orbit.');
    canvas.setAttribute('role', 'img');
    canvas.tabIndex = 0;
    host.append(canvas);
    this.scene.add(this.root, this.camera, new THREE.HemisphereLight(0xffffff, 0x71869d, 2.4));
    this.root.add(this.annotations);
    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(3, 5, 6);
    const fill = new THREE.DirectionalLight(0xe6f0ff, 1.1);
    fill.position.set(-4, 0, -3);
    this.camera.add(key, fill);
    // OrbitControls caches this axis at construction time.
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(...zDirections.perspective).normalize().multiplyScalar(3);
    this.camera.aimAt(new THREE.Vector3());
    this.replaceControls(new THREE.Vector3());
    this.observer = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect();
      this.renderer.setSize(Math.max(width, 1), Math.max(height, 1));
      this.camera.aspect = Math.max(width, 1) / Math.max(height, 1);
      this.camera.updateProjectionMatrix();
      // Keep a fitted model framed when expanding or narrowing the canvas.
      // A user orbit/pan/zoom clears this framing preference.
      if (this.fittedBounds) this.fitBounds(this.fittedBounds);
      this.draw();
    });
    this.observer.observe(host);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      onError('The graphics context was lost. Restart the 3D view to reload your meshes.');
    }, { signal: this.events.signal });
    const pointers = new Set<number>();
    let down: { id: number; x: number; y: number; moved: boolean; modified: boolean; tool: ToothTool | null; hits: SurfaceAnchor[]; faces: Set<string>; lastCast: number; lastX: number; lastY: number } | null = null;
    let pivotClick = false;
    this.cancelGesture = () => { down = null; pivotClick = false; };
    const modified = (event: MouseEvent | PointerEvent) => event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
    const collect = (event: PointerEvent, force = false) => {
      if (!down || down.hits.length >= 256 || modified(event)) return;
      // Nonindexed dense scans require a full triangle raycast. Sample at most
      // 30 times/second and skip stationary events; retain the final endpoint.
      if (!force && (event.timeStamp - down.lastCast < 33 || Math.hypot(event.clientX - down.lastX, event.clientY - down.lastY) < 3)) return;
      down.lastCast = event.timeStamp; down.lastX = event.clientX; down.lastY = event.clientY;
      const hit = this.hitSurface(event, true);
      if (!hit) return;
      const anchor = this.surfaceAnchor(hit);
      if (!anchor) return;
      const key = `${anchor.partId}:${anchor.face}`;
      if (!down.faces.has(key)) { down.faces.add(key); down.hits.push(anchor); }
    };
    canvas.addEventListener('pointerdown', event => {
      // In this Three version touch cursor zoom uses page coordinates, and
      // middle-drag supplies the wrong Y coordinate. Keep those dolly gestures centred.
      this.controls.zoomToCursor = event.pointerType !== 'touch' && event.button !== 1;
      canvas.focus({ preventScroll: true });
      pointers.add(event.pointerId);
      if (pointers.size > 1) { this.cancelGesture(); return; }
      pivotClick = false;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, modified: event.button !== 0 || modified(event), tool: this.editing ? this.toothView!.tool : null, hits: [], faces: new Set(), lastCast: -Infinity, lastX: event.clientX, lastY: event.clientY };
      if (!down.modified && down.tool && ['paint', 'erase', 'exclude'].includes(down.tool)) collect(event, true);
    }, { capture: true, signal: this.events.signal });
    canvas.addEventListener('wheel', () => { this.controls.zoomToCursor = true; }, { capture: true, passive: true, signal: this.events.signal });
    canvas.ownerDocument.addEventListener('pointermove', event => {
      if (down?.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) down.moved = true;
      if (modified(event)) down.modified = true;
      if (!down.modified && down.tool && ['paint', 'erase', 'exclude'].includes(down.tool)) collect(event);
    }, { signal: this.events.signal });
    canvas.ownerDocument.addEventListener('pointercancel', event => {
      pointers.delete(event.pointerId);
      this.cancelGesture();
    }, { signal: this.events.signal });
    canvas.addEventListener('lostpointercapture', event => {
      pointers.delete(event.pointerId);
      if (down?.id === event.pointerId) this.cancelGesture();
    }, { signal: this.events.signal });
    canvas.ownerDocument.defaultView?.addEventListener('blur', () => {
      this.cancelGesture();
      for (const id of pointers) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      pointers.clear();
      this.replaceControls(this.controls.target.clone());
    }, { signal: this.events.signal });
    canvas.ownerDocument.addEventListener('pointerup', event => {
      pointers.delete(event.pointerId);
      if (!down || down.id !== event.pointerId) return;
      const inspect = !down.moved && !down.modified && !modified(event) && event.button === 0 && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4;
      if (down.tool) {
        const tool = down.tool;
        if (!down.modified && !modified(event) && event.button === 0 && this.editing && tool === this.toothView!.tool) {
          if (['paint', 'erase', 'exclude'].includes(tool)) {
            collect(event, true);
            const hits = down.hits;
            down = null;
            if (hits.length) this.onToothEdit?.({ kind: 'stroke', tool, hits });
          } else if (inspect && canvas.contains(event.target as Node)) {
            const hit = this.hitSurface(event, true);
            const anchor = hit && this.surfaceAnchor(hit);
            down = null;
            if (anchor) this.onToothEdit?.({ kind: 'pick', tool, hit: anchor });
          }
        }
        this.cancelGesture();
        return;
      }
      down = null;
      pivotClick = inspect;
      if (!inspect || !canvas.contains(event.target as Node)) return;
      const hit = this.hitSurface(event);
      if (!hit || hit.faceIndex == null) return;
      if (this.rulerEnabled) {
        const anchor = this.surfaceAnchor(hit);
        if (anchor) {
          if (this.rulerAnchors.length === 2) this.rulerAnchors = [];
          this.rulerAnchors.push({ ...anchor, sourcePositions: this.sources.get(anchor.partId)!.positions });
          this.rulerCleared = false;
          this.refreshMeasurement();
          this.draw();
        }
        return;
      }
      const face = this.originalFace(hit);
      const id = hit.object.userData.id as string;
      const part = this.sources.get(id)!;
      const local = hit.object.worldToLocal(hit.point.clone());
      const first = face * 3;
      let vertex = first;
      let distance = Infinity;
      for (let v = first; v < first + 3; v++) {
        const d = local.distanceToSquared(new THREE.Vector3().fromArray(part.positions, v * 3));
        if (d < distance) { distance = d; vertex = v; }
      }
      const analysis = this.report?.parts.find(item => item.id === id);
      const signed = analysis?.distances[vertex];
      const position = new THREE.Vector3().fromArray(part.positions, vertex * 3).applyMatrix4(partMatrix(part)).toArray() as Vec3;
      onProbe({ id, face, vertex, position, distance: signed !== undefined && Number.isFinite(signed) ? signed : null, intersecting: !!analysis?.intersecting[face] });
    }, { signal: this.events.signal });
    canvas.addEventListener('dblclick', event => {
      if (this.editing || this.rulerEnabled || !pivotClick || event.button !== 0 || modified(event)) return;
      const hit = this.hitSurface(event);
      if (!hit) return;
      event.preventDefault();
      this.camera.preservePoseAtPivot(hit.point);
      this.replaceControls(hit.point);
      this.draw();
    }, { signal: this.events.signal });
    canvas.addEventListener('keydown', event => {
      if (event.target !== canvas || canvas.ownerDocument.activeElement !== canvas || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (event.shiftKey) this.focusSelected(); else this.fit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (this.rulerEnabled) { this.setRulerEnabled(false); event.stopPropagation(); }
        this.setNavigationMode('orbit');
      }
    }, { signal: this.events.signal });
  }

  private get editing() { return !!this.toothView?.enabled && this.toothView.tool !== 'inspect'; }

  private isEditable(id: string) {
    return this.editablePartIds.has(id) && this.sources.get(id)?.role !== 'bite';
  }

  private hasToothSurface(id: string) {
    const role = this.sources.get(id)?.role;
    return role === 'upper' || role === 'lower';
  }

  private hitSurface(event: MouseEvent | PointerEvent, editable = false) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    this.scene.updateMatrixWorld(true);
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.meshes.values()]
      .filter(mesh => mesh.visible && mesh.material.opacity > 0 && !this.sources.get(mesh.userData.id as string)?.reference), false)[0];
    return hit && (!editable || this.isEditable(hit.object.userData.id as string)) ? hit : undefined;
  }

  private originalFace(hit: THREE.Intersection) {
    const geometry = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry;
    // Isolation indexes original corners without moving any attributes. Three's
    // compact faceIndex must be converted back before reading labels/report data.
    return geometry.index ? Math.floor(geometry.index.getX(hit.faceIndex! * 3) / 3) : hit.faceIndex!;
  }

  private surfaceAnchor(hit: THREE.Intersection): SurfaceAnchor | undefined {
    if (hit.faceIndex == null) return;
    return { partId: hit.object.userData.id as string, face: this.originalFace(hit), point: hit.object.worldToLocal(hit.point.clone()).toArray() as Vec3 };
  }

  setToothCallback(callback?: (event: ToothEditEvent) => void) { this.onToothEdit = callback; }

  setRulerEnabled(enabled: boolean) {
    this.cancelGesture();
    if (enabled && this.editing) this.setToothView({ ...this.toothView!, tool: 'inspect' });
    this.rulerEnabled = enabled;
    this.configureNavigation();
    this.draw();
  }

  clearMeasurement() {
    this.cancelGesture();
    this.rulerAnchors = [];
    this.rulerCleared = false;
    this.refreshMeasurement();
    this.draw();
  }

  private refreshMeasurement() {
    if (!this.rulerAnchors) return;
    const resolved = resolveMeasurement(this.rulerAnchors, this.sources);
    if (!resolved) { this.rulerAnchors = []; this.rulerCleared = true; }
    this.measurement = resolved ?? { points: [], distance: null };
    if (![...this.sources.values()].some(part => !part.reference && part.role !== 'bite')) this.rulerEnabled = false;
  }

  /** Project only for presentation; distance always comes from workspace coordinates. */
  private updateRuler() {
    if (!this.onRulerChange) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    const screenPoints = this.measurement.points.map(point => {
      const mesh = this.meshes.get(point.partId);
      if (!mesh?.visible || mesh.material.opacity <= 0) return null;
      if (this.toothView?.isolate && this.toothView.labels[point.partId]?.[point.face] !== this.toothView.activeTooth
        && !(this.toothView.draft?.partId === point.partId && this.toothView.draft.faces.includes(point.face))) return null;
      const projected = new THREE.Vector3(...point.position).applyMatrix4(this.root.matrixWorld).project(this.camera);
      if (![projected.x, projected.y, projected.z].every(Number.isFinite) || projected.z < -1 || projected.z > 1) return null;
      return [(projected.x + 1) * size.x / 2, (1 - projected.y) * size.y / 2] as [number, number];
    });
    const state: RulerState = { ...this.measurement, enabled: this.rulerEnabled, cleared: this.rulerCleared, screenPoints };
    const snapshot = JSON.stringify(state);
    if (snapshot !== this.rulerSnapshot) { this.rulerSnapshot = snapshot; this.onRulerChange(state); }
  }

  /** DOM overlays subscribe to the existing draw path; captures remain canvas-only. */
  setProjectionTarget(partIds: readonly string[], onChange: ((bounds: ScreenBounds | null) => void) | null) {
    this.projectionTarget = onChange ? { partIds: [...partIds], onChange } : null;
    if (onChange) this.draw();
  }

  private updateProjectionTarget() {
    if (!this.projectionTarget) return;
    const targets: ProjectionTarget[] = [];
    for (const id of this.projectionTarget.partIds) {
      const mesh = this.meshes.get(id);
      if (!mesh?.visible || mesh.material.opacity <= 0) continue;
      const bounds = mesh.userData.displayBounds as THREE.Box3 | undefined ?? mesh.geometry.boundingBox;
      if (bounds) targets.push({ bounds, matrixWorld: mesh.matrixWorld });
    }
    const size = this.renderer.getSize(new THREE.Vector2());
    this.projectionTarget.onChange(projectMeshBounds(targets, this.camera, size.x, size.y));
  }

  /** Read pixels immediately after rendering; no preserveDrawingBuffer or patient labels. */
  capture(): ViewerCapture {
    if (this.disposed || this.renderer.getContext().isContextLost()) throw new Error('Restart the 3D view before capturing it.');
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const factor = Math.min(1, 960 / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * factor)); canvas.height = Math.max(1, Math.round(source.height * factor));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not capture the 3D view.');
    context.fillStyle = '#f1f5f9'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const inverseRoot = this.root.matrixWorld.clone().invert();
    return { dataUrl: canvas.toDataURL('image/jpeg', .86), width: canvas.width, height: canvas.height, camera: {
      position: this.camera.position.clone().applyMatrix4(inverseRoot).toArray(), target: this.controls.target.clone().applyMatrix4(inverseRoot).toArray(), up: this.camera.up.toArray(),
      verticalFovDegrees: this.camera.getEffectiveFOV(), aspect: this.camera.aspect, near: this.camera.near, far: this.camera.far,
      workspaceToCamera: this.camera.matrixWorldInverse.clone().multiply(this.root.matrixWorld).toArray(), projectionMatrix: this.camera.projectionMatrix.toArray(),
    } };
  }

  setToothView(state: ToothDisplayViewState | null) {
    const wasEditing = this.editing;
    const previous = this.toothView;
    if (previous?.autoOverlay?.candidates !== state?.autoOverlay?.candidates || previous?.autoOverlay?.partId !== state?.autoOverlay?.partId) {
      const overlay = state?.autoOverlay;
      const source = overlay && this.sources.get(overlay.partId);
      this.autoRegionLabels = source ? new Uint8Array(source.triangles) : null;
      if (this.autoRegionLabels && overlay) for (const candidate of overlay.candidates) for (const face of candidate.faces) if (face < this.autoRegionLabels.length) this.autoRegionLabels[face] = candidate.id;
    }
    if (previous?.tool !== state?.tool || previous?.activeTooth !== state?.activeTooth || previous?.enabled !== state?.enabled || previous?.isolate !== state?.isolate || previous?.editablePartIds.join('|') !== state?.editablePartIds.join('|')) this.cancelGesture();
    this.toothView = state;
    if (this.editing) this.rulerEnabled = false;
    this.editablePartIds = new Set(state?.editablePartIds);
    if (wasEditing !== this.editing) this.replaceControls(this.controls.target.clone());
    else this.configureNavigation();
    this.applyIsolation();
    this.rebuildAnnotations();
    this.updateBounds();
    this.paint();
    if (state?.focusedPlanningSiteId && previous?.focusedPlanningSiteId !== state.focusedPlanningSiteId) this.focusPlanningSite(state.focusedPlanningSiteId);
  }

  private focusPlanningSite(id: string) {
    const site = this.toothView?.planningSites?.find(site => site.id === id), source = site && this.sources.get(site.partId);
    if (!site?.frame || !source) return;
    const centre = new THREE.Vector3(...site.frame.origin), up = new THREE.Vector3(...site.frame.up);
    const size = Math.max(site.space.mesiodistal.value ?? 0, site.space.buccolingual.value ?? 0, site.space.crownHeight.value ?? 0);
    if (!(size > 0)) return;
    centre.addScaledVector(up, size * .3).applyMatrix4(partMatrix(source));
    this.root.updateMatrixWorld(true); centre.applyMatrix4(this.root.matrixWorld);
    const extent = new THREE.Vector3(size * 2.8, size * 2.8, size * 2.8);
    this.fitBounds(new THREE.Box3().setFromCenterAndSize(centre, extent));
  }

  /** Recreating controls clears pending inertia and refreshes their cached up axis. */
  private replaceControls(target: THREE.Vector3) {
    const position = this.camera.position.clone();
    const orientation = this.camera.quaternion.clone();
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera);
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.camera.quaternion.copy(orientation);
    this.camera.preservePoseAtPivot(target);
    this.controls.enableDamping = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.7;
    this.controls.panSpeed = 0.85;
    this.controls.zoomSpeed = 0.8;
    this.setNavigationMode(this.navigationMode);
    this.updateLimits();
    this.controls.connect(this.renderer.domElement);
    this.controls.listenToKeyEvents(this.renderer.domElement);
    this.controls.addEventListener('change', this.controlsChanged);
    this.controls.addEventListener('start', () => { this.fittedBounds = null; });
    this.controls.update();
    this.camera.updateMatrixWorld(true);
  }

  private controlsChanged = () => {
    // Cursor zoom can move the target onto the optical axis after lookAt().
    this.camera.preservePoseAtPivot(this.controls.target);
    this.updateClipping();
    this.draw();
  };

  setNavigationMode(mode: NavigationMode) {
    this.navigationMode = mode;
    this.configureNavigation();
    this.onNavigationMode(mode);
  }

  private configureNavigation() {
    const pan = this.navigationMode === 'pan';
    // Keep controls tracking pointers even for a drawing finger, so a second
    // finger can cancel the stroke and start the normal pan/zoom gesture.
    this.controls.mouseButtons = { LEFT: this.editing ? null : pan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: this.editing ? null : pan ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.renderer.domElement.style.cursor = this.editing || this.rulerEnabled ? 'crosshair' : pan ? 'move' : 'grab';
    this.renderer.domElement.setAttribute('aria-label', this.rulerEnabled
      ? 'Interactive 3D mesh viewer. Ruler: click or tap two surface points to measure a straight-line distance using the scan scale shown in the ruler. Drag to navigate, scroll to zoom. Escape stops measuring.'
      : this.editing
      ? `Interactive 3D mesh viewer. Tooth ${this.toothView!.activeTooth}, ${this.toothView!.tool} tool. Paint, erase and exclude use left drag or one finger; boundary, seed and site use a click or tap. Right drag pans; scroll zooms; two fingers pan and zoom. F fits the displayed region; Shift+F focuses it.`
      : 'Interactive 3D mesh viewer. Orbit or pan with the toolbar, scroll to zoom, click to inspect, double-click to set the orbit pivot. With this canvas focused: F fits all, Shift+F focuses the selected model, Escape returns to orbit.');
  }

  private updateLimits() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.controls.minDistance = Math.min(this.radius * 0.0005, distance * 0.5);
    this.controls.maxDistance = Math.max(this.radius * 12, distance * 1.1);
    this.updateClipping();
  }

  private updateClipping() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(Math.min(this.radius * 0.0001, distance * 0.01), this.radius * 1e-7);
    const center = this.bounds.isEmpty() ? this.controls.target : this.bounds.getCenter(new THREE.Vector3());
    this.camera.far = Math.max(this.camera.position.distanceTo(center) + this.radius * 1.2, this.camera.near * 1000);
    this.camera.updateProjectionMatrix();
  }

  private draw = () => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      try {
        const changed = this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.updateProjectionTarget();
        this.updateRuler();
        if (changed) this.draw();
      } catch { /* Context loss is reported by the canvas event. */ }
    });
  };

  setParts(parts: ModelPart[]) {
    // Registration references stay local but allocate no scene geometry/materials.
    parts = parts.filter(part => part.role !== 'bite');
    this.cancelGesture();
    let added = false;
    const ids = new Set(parts.map(part => part.id));
    for (const [id, mesh] of this.meshes) {
      if (ids.has(id)) continue;
      this.releaseTexture(id, mesh);
      mesh.geometry.dispose(); mesh.material.dispose(); this.root.remove(mesh); this.meshes.delete(id); this.sources.delete(id);
    }
    for (const part of parts) {
      let mesh = this.meshes.get(part.id);
      const shading = displayNormals(part);
      if (!mesh || mesh.geometry.getAttribute('position').array !== part.positions || mesh.userData.sourceNormals !== part.normals || mesh.geometry.userData.normals !== shading.mode) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
        // Smoothed concept normals are a separate display array; source normals stay untouched for export.
        geometry.setAttribute('normal', new THREE.BufferAttribute(shading.normals, 3));
        geometry.userData.normals = shading.mode;
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(part.positions.length), 3));
        geometry.setAttribute('inspectionOverlay', new THREE.BufferAttribute(new Float32Array(part.positions.length / 3 * 4), 4));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (mesh) { mesh.geometry.dispose(); mesh.geometry = geometry; }
        else {
          mesh = new THREE.Mesh(geometry, createInspectionMaterial());
          mesh.userData.id = part.id;
          mesh.userData.appearance = 'scan';
          this.meshes.set(part.id, mesh); this.root.add(mesh);
        }
        mesh.userData.sourceNormals = part.normals;
        added = true;
      }
      const look = appearanceKey(part);
      if (mesh.userData.appearance !== look) {
        this.releaseTexture(part.id, mesh);
        mesh.material.dispose();
        mesh.material = createPartMaterial(part, look === 'scan' ? null : this.restorationEnvironment());
        mesh.material.wireframe = this.wireframe;
        mesh.material.emissive.set(part.id === this.selected ? '#16212d' : '#000000');
        mesh.userData.appearance = look;
      }
      // Appearance can change without changing the id or the source position/normal arrays.
      const uv = part.uvs?.length === part.positions.length / 3 * 2 ? part.uvs : undefined;
      const oldUv = mesh.geometry.getAttribute('uv');
      if ((uv && oldUv?.array !== uv) || (!uv && oldUv)) {
        // Release an uploaded old UV buffer before replacing it; preserve position arrays and pose.
        mesh.geometry.dispose();
        if (uv) mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        else mesh.geometry.deleteAttribute('uv');
      }
      const enamel = crownEnamel(part);
      const oldEnamel = mesh.geometry.getAttribute('enamelCoordinate');
      if (enamel ? oldEnamel?.array !== enamel.coordinates : !!oldEnamel) {
        mesh.geometry.dispose();
        if (enamel) mesh.geometry.setAttribute('enamelCoordinate', new THREE.BufferAttribute(enamel.coordinates, 3));
        else mesh.geometry.deleteAttribute('enamelCoordinate');
      }
      if (enamel) {
        Object.assign(mesh.material.userData.presentation, { colorSource: enamel.source, colorSamples: enamel.samples });
        mesh.material.userData.enamelVariation.value = enamel.variation;
      }
      mesh.visible = part.visible;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(partMatrix(part));
      mesh.matrixWorldNeedsUpdate = true;
      this.sources.set(part.id, part);
      this.refreshTexture(part, mesh);
      this.applyOpacity(part.id, mesh);
    }
    if (added) {
      this.root.position.set(0, 0, 0);
      this.root.updateMatrixWorld(true);
      const bounds = new THREE.Box3();
      for (const mesh of this.meshes.values()) bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
      if (!bounds.isEmpty()) this.root.position.copy(bounds.getCenter(new THREE.Vector3()).negate());
    }
    this.applyIsolation();
    this.rebuildAnnotations();
    this.updateBounds();
    this.refreshMeasurement();
    if (added) this.fit();
    this.paint();
  }

  private restorationEnvironment() {
    if (!this.environment && this.renderer) {
      const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer);
      this.environment = pmrem.fromScene(room, 0.04);
      room.dispose(); pmrem.dispose();
    }
    return this.environment?.texture ?? null;
  }

  private releaseTexture(id: string, mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>) {
    this.textures.get(id)?.load.dispose();
    this.textures.delete(id);
    if (mesh.material.map) { mesh.material.map = null; mesh.material.needsUpdate = true; }
  }

  private refreshTexture(part: ModelPart, mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>) {
    const cached = this.textures.get(part.id);
    if (!hasSurfaceTexture(part)) { this.releaseTexture(part.id, mesh); return; }
    const source = part.texture!;
    if (cached?.bytes === source.bytes && cached.mimeType === source.mimeType) return;
    this.releaseTexture(part.id, mesh);
    const entry = { bytes: source.bytes, mimeType: source.mimeType, load: createSurfaceTexture(source) };
    this.textures.set(part.id, entry);
    entry.load.ready.then(() => {
      if (this.disposed || this.textures.get(part.id) !== entry || this.meshes.get(part.id) !== mesh) return;
      mesh.material.map = entry.load.texture;
      mesh.material.needsUpdate = true;
      this.paint();
    }).catch(() => {
      // Keep the mesh inspectable with its vertex colors/fallback if an image cannot decode.
      if (this.textures.get(part.id) === entry) this.releaseTexture(part.id, mesh);
    });
  }

  private applyIsolation() {
    const state = this.toothView;
    for (const [id, mesh] of this.meshes) {
      const part = this.sources.get(id)!;
      if (!state?.isolate) {
        this.setDisplayIndex(mesh.geometry, null);
        delete mesh.userData.displayBounds;
        mesh.visible = part.visible;
        continue;
      }
      const corners: number[] = [];
      const bounds = new THREE.Box3();
      if (this.hasToothSurface(id)) {
        const labels = state.labels[id];
        const draft = new Set(state.draft?.partId === id ? state.draft.faces : []);
        const point = new THREE.Vector3();
        for (let face = 0; face < part.triangles; face++) {
          if (labels?.[face] !== state.activeTooth && !draft.has(face)) continue;
          for (let corner = face * 3; corner < face * 3 + 3; corner++) {
            corners.push(corner);
            bounds.expandByPoint(point.fromArray(part.positions, corner * 3));
          }
        }
      }
      this.setDisplayIndex(mesh.geometry, corners);
      mesh.userData.displayBounds = bounds;
      mesh.visible = part.visible && corners.length > 0;
    }
  }

  private setDisplayIndex(geometry: THREE.BufferGeometry, corners: number[] | null) {
    const index = geometry.index;
    if (corners && index?.count === corners.length) {
      if (corners.some((corner, i) => index.getX(i) !== corner)) {
        (index.array as Uint32Array).set(corners);
        index.needsUpdate = true;
      }
      return;
    }
    if (!corners && !index) return;
    // Release the old GPU index and cached wireframe before changing its size
    // or switching indexed/nonindexed rendering. Attributes retain their arrays.
    geometry.dispose();
    geometry.setIndex(corners ? new THREE.BufferAttribute(new Uint32Array(corners), 1) : null);
  }

  private meshBounds(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>) {
    const local = mesh.userData.displayBounds as THREE.Box3 | undefined;
    return (local ?? mesh.geometry.boundingBox!).clone().applyMatrix4(mesh.matrixWorld);
  }

  private updateBounds() {
    this.root.updateMatrixWorld(true);
    this.bounds.makeEmpty();
    for (const mesh of this.meshes.values()) if (mesh.visible && mesh.material.opacity > 0) this.bounds.union(this.meshBounds(mesh));
    if (!this.bounds.isEmpty()) this.radius = Math.max(this.bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-6);
    this.updateLimits();
  }

  setOpacities(opacities: Readonly<Record<string, number>>) {
    this.cancelGesture();
    this.opacities = opacities;
    for (const [id, mesh] of this.meshes) this.applyOpacity(id, mesh);
    this.updateAnnotationTransforms();
    this.updateBounds();
    this.draw();
  }

  private applyOpacity(id: string, mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>) {
    const fallback = this.sources.get(id)?.role === 'bite' ? 0 : 1;
    const value = this.opacities[id] ?? fallback;
    const opacity = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
    const transparent = opacity < 1;
    if (mesh.material.transparent !== transparent) {
      mesh.material.transparent = transparent;
      mesh.material.needsUpdate = true;
    }
    mesh.material.opacity = opacity;
    mesh.material.depthWrite = !transparent;
  }

  private clearAnnotations() {
    this.annotations.traverse(object => {
      const drawable = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      if (!(object instanceof THREE.Sprite) && drawable.geometry && drawable.geometry !== this.markerGeometry) drawable.geometry.dispose();
      if (!drawable.material) return;
      for (const material of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) {
        if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
        material.dispose();
      }
    });
    this.annotations.clear();
  }

  private rebuildAnnotations() {
    this.clearAnnotations();
    const state = this.toothView;
    if (!state?.enabled) return;
    const groups = new Map<string, THREE.Group>();
    const groupFor = (id: string) => {
      if (!this.hasToothSurface(id) || !this.meshes.has(id)) return;
      let group = groups.get(id);
      if (!group) {
        group = new THREE.Group();
        group.userData.id = id;
        group.matrixAutoUpdate = false;
        groups.set(id, group);
        this.annotations.add(group);
      }
      return group;
    };
    const addMarker = (anchor: SurfaceAnchor, color: string, size: number, tooth?: number | string, note = '') => {
      const group = groupFor(anchor.partId);
      const mesh = this.meshes.get(anchor.partId);
      if (!group || !mesh || anchor.face < 0 || anchor.face >= this.sources.get(anchor.partId)!.triangles || !anchor.point.every(Number.isFinite)) return;
      const scale = Math.max(mesh.geometry.boundingSphere!.radius * 0.012, 1e-6);
      const marker = new THREE.Mesh(this.markerGeometry, new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
      marker.position.set(...anchor.point);
      marker.scale.setScalar(scale * size);
      marker.renderOrder = 10;
      group.add(marker);
      if (tooth !== undefined) {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = note ? 96 : 64;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.fillStyle = color;
        context.fillRect(4, 4, canvas.width - 8, canvas.height - 8);
        context.fillStyle = '#ffffff';
        context.font = 'bold 36px sans-serif';
        context.textAlign = 'center'; context.textBaseline = 'middle';
        context.fillText(String(tooth), canvas.width / 2, 34);
        if (note) {
          context.font = '600 22px sans-serif';
          context.fillText(note, canvas.width / 2, 72);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
        sprite.position.copy(marker.position).add(new THREE.Vector3(0, 0, scale * 3));
        sprite.scale.set(scale * 7, scale * 7 * canvas.height / canvas.width, 1);
        sprite.renderOrder = 11;
        group.add(sprite);
      }
    };
    const overlay = state.autoOverlay;
    if (overlay && !state.isolate) for (const candidate of overlay.candidates) {
      const role = this.sources.get(overlay.partId)?.role;
      const display = candidateToothDisplay(candidate, {
        labels: state.labels[overlay.partId], recordedLabels: state.recordedLabels?.[overlay.partId],
        arch: role === 'upper' || role === 'lower' ? role : null,
      });
      addMarker({ partId: overlay.partId, face: candidate.faces[0] ?? 0, point: candidate.centroid }, candidate.id === overlay.selectedCandidate ? '#087c91' : '#4775a6', .65, display.marker, display.note);
    }
    for (const site of state.sites) {
      if (state.isolate && site.tooth !== state.activeTooth) continue;
      const active = site.tooth === state.activeTooth;
      addMarker(site.anchor, active ? '#2563eb' : '#7188a3', active ? 1.4 : 1, site.tooth);
    }
    const planningSites = state.planningSites ?? [];
    const activeSite = planningSites.find(site => site.id === state.focusedPlanningSiteId) ?? planningSites.find(site => site.fdi === state.activeTooth);
    for (const site of planningSites) {
      if (!site.anchor || !site.frame || site.status === 'not-scanned') continue;
      const display = toothDisplay({ fdi: site.draftIdentity ? null : site.fdi, status: site.status === 'dentist-confirmed-missing' ? 'recorded' : 'uncertain' }, '?', site.arch);
      addMarker(site.anchor, site === activeSite ? '#2563eb' : '#64748b', .75, display.marker, display.note);
      if (site !== activeSite) continue;
      const group = groupFor(site.partId), source = this.sources.get(site.partId);
      if (!group || !source) continue;
      const patch = site.patchFaces.filter(face => face < source.triangles);
      if (patch.length) {
        const points = new Float32Array(patch.length * 9);
        patch.forEach((face, index) => points.set(source.positions.subarray(face * 9, face * 9 + 9), index * 9));
        const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(points, 3));
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#e3a008', side: THREE.DoubleSide, transparent: true, opacity: .52, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
        group.add(mesh);
      }
      const origin = new THREE.Vector3(...site.frame.origin), up = new THREE.Vector3(...site.frame.up);
      const width = site.space.mesiodistal.value, depth = site.space.buccolingual.value, height = site.space.crownHeight.value;
      const size = Math.max(width ?? 1, depth ?? 1, height ?? 1);
      const axes = new THREE.Matrix4().makeBasis(new THREE.Vector3(...site.frame.u), new THREE.Vector3(...site.frame.v), up);
      const axisPoints = [origin.clone().addScaledVector(up, -size * .6), origin.clone().addScaledVector(up, size * 1.4)];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(axisPoints), new THREE.LineBasicMaterial({ color: '#2563eb', depthTest: false })));
      if (width && depth && height) {
        // A tooth-class hypothesis is a presentation envelope, not a fitted part.
        const shape = site.fdi === null ? null : buildCrownMesh(templateShape(site.arch, site.fdi % 10), [1, 1, 1]);
        const geometry = shape ? new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(shape.vertices, 3)).setIndex(new THREE.BufferAttribute(shape.indices, 1)) : new THREE.SphereGeometry(.5, 24, 12);
        const envelope = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#60a5fa', side: THREE.DoubleSide, transparent: true, opacity: .2, depthWrite: false }));
        envelope.quaternion.setFromRotationMatrix(axes); envelope.scale.set(width * .92 * (shape ? site.mesialSign : 1), depth * .94 * (shape ? site.buccalSign : 1), height * .78); envelope.position.copy(origin).addScaledVector(up, height * (shape ? .22 : .6)); group.add(envelope);
        for (const z of [0, height * .22]) {
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.25, depth * 1.25), new THREE.MeshBasicMaterial({ color: z ? '#64748b' : '#2563eb', side: THREE.DoubleSide, transparent: true, opacity: .12, depthWrite: false }));
          plane.quaternion.setFromRotationMatrix(axes); plane.position.copy(origin).addScaledVector(up, z); group.add(plane);
        }
      }
    }
    for (const anchor of state.boundary) addMarker(anchor, '#0891b2', 0.8);
    if (state.seed) addMarker(state.seed, '#f59e0b', 1.2);
    if (state.boundaryPath?.positions.length) {
      const group = groupFor(state.boundaryPath.partId);
      if (group) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(state.boundaryPath.positions, 3));
        const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#0891b2', depthTest: false, depthWrite: false }));
        line.renderOrder = 9;
        group.add(line);
      }
    }
    this.updateAnnotationTransforms();
  }

  private updateAnnotationTransforms() {
    for (const group of this.annotations.children) {
      const id = group.userData.id as string;
      const mesh = this.meshes.get(id);
      group.visible = !!this.toothView?.enabled && this.hasToothSurface(id) && !!mesh?.visible && mesh.material.opacity > 0;
      if (mesh) { group.matrix.copy(mesh.matrix); group.matrixWorldNeedsUpdate = true; }
    }
  }

  setAnalysis(report: CollisionReport | null, tolerance: number) { this.report = report; this.tolerance = tolerance; this.paint(); }
  setAppearance(heatmap: boolean, wireframe: boolean, selected: string | null) {
    this.heatmap = heatmap;
    this.wireframe = wireframe;
    this.selected = selected;
    for (const [id, mesh] of this.meshes) {
      mesh.material.wireframe = wireframe;
      mesh.material.emissive.set(id === selected ? '#16212d' : '#000000');
    }
    this.paint();
  }
  private paint() {
    const color = new THREE.Color();
    for (const [id, mesh] of this.meshes) {
      const part = this.sources.get(id)!;
      const analysis = this.heatmap ? this.report?.parts.find(item => item.id === id) : undefined;
      const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const overlay = mesh.geometry.getAttribute('inspectionOverlay') as THREE.BufferAttribute;
      const state = this.toothView?.enabled && this.hasToothSurface(id) ? this.toothView : null;
      const labels = state?.labels[id];
      const draft = new Set(state?.draft?.partId === id ? state.draft.faces : []);
      for (let v = 0; v < attr.count; v++) {
        surfaceColor(part, v, !!mesh.material.map, color);
        attr.setXYZ(v, color.r, color.g, color.b);
        const face = Math.floor(v / 3);
        const d = analysis?.distances[v] ?? Infinity;
        let marked = false;
        if (state) {
          const candidate = state.autoOverlay?.partId === id ? this.autoRegionLabels?.[face] : 0;
          if (candidate && !labels?.[face]) { color.copy(candidate === state.autoOverlay?.selectedCandidate ? toothDraft : toothAssigned); marked = true; }
          if (draft.has(face)) { color.copy(toothDraft); marked = true; }
          else if (labels?.[face] === 255) { color.copy(toothExcluded); marked = true; }
          else if (labels?.[face] === state.activeTooth) { color.copy(toothSelected); marked = true; }
          else if (labels?.[face]) { color.copy(toothAssigned); marked = true; }
        }
        // Keep active label editing readable; inspection puts contacts above labels.
        if (!marked || !this.editing) {
          const sampleState = collisionSampleState(!!(analysis?.crossing ?? analysis?.intersecting)?.[face], d, this.tolerance, !!analysis?.intersecting[face]);
          if ((analysis?.crossing ?? analysis?.intersecting)?.[face]) { color.copy(contact); marked = true; }
          else if (d < 0) { color.copy(contact).lerp(deep, Math.min(-d / Math.max(analysis?.maxDepth ?? 1, 1e-12), 1)); marked = true; }
          else if (sampleState === 'near') { color.copy(near); marked = true; }
        }
        overlay.setXYZW(v, color.r, color.g, color.b, marked ? 1 : 0);
      }
      attr.needsUpdate = true;
      overlay.needsUpdate = true;
    }
    this.draw();
  }
  fit() {
    this.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    for (const mesh of this.meshes.values()) if (mesh.visible && mesh.material.opacity > 0) bounds.union(this.meshBounds(mesh));
    this.fitBounds(bounds);
  }

  focusSelected() {
    if (this.toothView?.isolate) { this.fit(); return; }
    const mesh = this.selected ? this.meshes.get(this.selected) : undefined;
    if (!mesh?.visible || mesh.material.opacity === 0) return;
    this.root.updateMatrixWorld(true);
    this.fitBounds(this.meshBounds(mesh));
  }

  private fitBounds(bounds: THREE.Box3) {
    const fit = fitCameraToBounds(this.camera, bounds);
    if (!fit) return;
    this.fittedBounds = bounds.clone();
    this.replaceControls(fit.target);
    this.draw();
  }

  zoom(direction: 'in' | 'out') {
    this.fittedBounds = null;
    if (direction === 'in') this.controls.dollyIn(0.8);
    else this.controls.dollyOut(0.8);
    this.draw();
  }

  setUpAxis(axis: 'y' | 'z') {
    if (axis === this.upAxis) return;
    this.upAxis = axis;
    this.camera.up.set(0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    this.camera.aimAt(this.controls.target);
    this.replaceControls(this.controls.target.clone());
    this.draw();
  }

  setView(view: View) {
    const distance = Math.max(this.camera.position.distanceTo(this.controls.target), this.controls.minDistance);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...(this.upAxis === 'z' ? zDirections : directions)[view]).normalize().multiplyScalar(distance));
    this.camera.aimAt(this.controls.target);
    this.replaceControls(this.controls.target.clone());
    this.draw();
  }
  dispose() {
    this.disposed = true;
    this.projectionTarget = null;
    this.onRulerChange = undefined;
    this.cancelGesture();
    cancelAnimationFrame(this.frame); this.events.abort(); this.observer.disconnect(); this.controls.dispose();
    this.clearAnnotations(); this.markerGeometry.dispose();
    for (const [id, mesh] of this.meshes) { this.releaseTexture(id, mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    this.environment?.dispose(); this.environment = null;
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}

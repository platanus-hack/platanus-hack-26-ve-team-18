import { useMemo, useRef, type MutableRefObject } from 'react';
import { Matrix4, Vector3 } from 'three';
import type { ModelPart, Vec3 } from './models.ts';
import { partMatrix } from './pose.ts';
import type { TomographyVolume, TomographyViewSpec, TomographySurface } from './tomography-types.ts';
import { volumeCenter } from './tomography-geometry.ts';
import { renderTomographyView, pixelToPatient, type OverlayRegistration } from './tomography-views.ts';
import { buildTomographySummary, captureTomographyCanvas, stripCanvasJpegMetadata, tomographyCaptureSchema, type AssistantTomographySource, type TomographyCapture } from './tomography-evidence.ts';
import type { ViewerCapture } from './viewer.ts';

interface Options {
  volume: TomographyVolume | null;
  surface: TomographySurface | null;
  parts: ModelPart[];
  sceneParts: ModelPart[];
  registrations: OverlayRegistration[];
  mmPerUnit: number | null;
  views: TomographyViewSpec[];
  capture3d: MutableRefObject<(() => ViewerCapture) | null>;
  sceneRevision: string;
}

/** Local renderer adapter. No source names, DICOM UIDs or voxel buffers cross this boundary. */
export function useTomographyAssistantSource({ volume, surface, parts, sceneParts, registrations, mmPerUnit, views, capture3d, sceneRevision }: Options): AssistantTomographySource | undefined {
  const bufferIds = useRef(new WeakMap<object, number>()), nextBufferId = useRef(0);
  const bufferId = (buffer: object | undefined) => {
    if (!buffer) return 0;
    let id = bufferIds.current.get(buffer);
    if (!id) { id = ++nextBufferId.current; bufferIds.current.set(buffer, id); }
    return id;
  };
  const geometryRevision = parts.map(part => [bufferId(part.positions), bufferId(part.normals), bufferId(part.colors), bufferId(part.texture?.bytes)].join(':')).join('|');
  const sceneGeometryRevision = sceneParts.map(part => [part.id, bufferId(part.positions), part.visible, partMatrix(part).toArray()]);
  return useMemo(() => {
    if (!volume) return undefined;
    const confirmed = ['upper', 'lower'].filter(arch => parts.some(part => part.role === arch)).every(arch => registrations.some(record => record.arch === arch && record.reviewed));
    const registration = mmPerUnit && registrations.length ? { patientToWorkspace: new Matrix4().makeScale(1 / mmPerUnit, 1 / mmPerUnit, 1 / mmPerUnit).toArray(), confirmed } : null;
    const summary = buildTomographySummary(volume, registration);
    const aliases = new Map(parts.filter(part => !part.restoration).map((part, i) => [part.id, `scan-${i + 1}`]));
    let restoration = 0;
    for (const part of parts.filter(part => part.restoration)) aliases.set(part.id, `restoration-${++restoration}`);
    const component = (part: ModelPart) => ({ id: part.reference ? 'volume-1' : aliases.get(part.id)!, kind: part.reference ? 'threshold-surface' as const : part.restoration ? 'restoration' as const : 'mesh' as const, localToWorkspace: partMatrix(part).toArray(), ...(part.reference && surface ? { thresholdSurface: { method: surface.method, threshold: surface.threshold, stride: surface.stride, effectiveSpacingMm: surface.effectiveSpacing } } : {}) });
    const initialViews = views.length ? views.slice(0, 4) : (['axial', 'coronal', 'sagittal'] as const).map(plane => ({ plane, center: volumeCenter(volume), widthMm: Math.max(...volume.dimensions.map((n, i) => n * volume.spacing[i])), heightMm: Math.max(...volume.dimensions.map((n, i) => n * volume.spacing[i])), windowCenter: (volume.range[0] + volume.range[1]) / 2, windowWidth: volume.range[1] - volume.range[0] || 1 }));
    return {
      revision: JSON.stringify([volume.id, surface ? [surface.threshold, surface.stride] : null, views, registrations.map(({ arch, rmsMm, reviewed }) => ({ arch, rmsMm, reviewed })), mmPerUnit, sceneRevision, geometryRevision, sceneGeometryRevision, parts.map(part => [part.id, part.pose, part.offset, part.rotation, part.visible])]), summary, initialViews,
      async capture(spec, signal) {
        signal?.throwIfAborted();
        const { canvas, metadata } = renderTomographyView(volume, spec, { width: 640, height: 640, annotations: true, crosshair: false, signal, overlays: { parts, mmPerUnit, registrations, scans: true, restorations: true } });
        signal?.throwIfAborted();
        const frame = metadata.frame;
        return captureTomographyCanvas(canvas, {
          id: 'view-1', volumeId: 'volume-1', kind: 'slice', projection: 'orthographic', spec,
          pixelOriginLpsMm: pixelToPatient(frame, 0, 0, canvas.width, canvas.height),
          pixelRightLpsMm: frame.right.map(v => v * frame.widthMm / canvas.width) as Vec3,
          pixelDownLpsMm: frame.up.map(v => -v * frame.heightMm / canvas.height) as Vec3,
          sampling: metadata.sampling, unavailablePixels: metadata.unavailablePixels,
          overlay: { registration: summary.registration, components: parts.filter(part => metadata.overlays.partIds.includes(part.id)).map(component) },
        });
      },
      async capture3d(_view, signal): Promise<TomographyCapture> {
        signal?.throwIfAborted();
        if (!capture3d.current) throw new Error('Restart the 3D view before sharing a capture.');
        const image = capture3d.current();
        const cameraToWorkspace = new Matrix4().fromArray(image.camera.workspaceToCamera).invert();
        const right = new Vector3().setFromMatrixColumn(cameraToWorkspace, 0).normalize();
        const up = new Vector3().setFromMatrixColumn(cameraToWorkspace, 1).normalize();
        const back = new Vector3().setFromMatrixColumn(cameraToWorkspace, 2).normalize();
        const position = new Vector3(...image.camera.position), pivot = new Vector3(...image.camera.target);
        const depth = position.clone().sub(pivot).dot(back);
        if (!(depth > 0)) throw new Error('Frame the anatomy in front of the camera before capturing.');
        const center = position.clone().addScaledVector(back, -depth);
        const height = 2 * depth * Math.tan(image.camera.verticalFovDegrees * Math.PI / 360), width = height * image.camera.aspect;
        const pixelRight = right.clone().multiplyScalar(width / image.width), pixelDown = up.clone().multiplyScalar(-height / image.height);
        const origin = center.clone().addScaledVector(right, -width / 2).addScaledVector(up, height / 2).addScaledVector(pixelRight, .5).addScaledVector(pixelDown, .5);
        signal?.throwIfAborted();
        return tomographyCaptureSchema.parse({ id: 'view-1', volumeId: 'volume-1', kind: '3d', projection: 'perspective', coordinateSystem: 'workspace file units', dataUrl: stripCanvasJpegMetadata(image.dataUrl), pixelWidth: image.width, pixelHeight: image.height,
          camera: { position: image.camera.position, target: center.toArray(), up: up.toArray(), near: image.camera.near, far: image.camera.far, verticalFovDegrees: image.camera.verticalFovDegrees, aspect: image.camera.aspect, workspaceToCamera: image.camera.workspaceToCamera, projectionMatrix: image.camera.projectionMatrix },
          referencePlane: { origin: origin.toArray(), pixelRight: pixelRight.toArray(), pixelDown: pixelDown.toArray(), units: 'file units' },
          overlay: { registration: summary.registration, components: sceneParts.filter(part => part.visible && part.role !== 'bite').map(component) },
        });
      },
    };
  }, [volume, surface, parts, sceneParts, registrations, mmPerUnit, views, capture3d, sceneRevision, geometryRevision]);
}

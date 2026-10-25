import { getSliceFrame, pixelToPatient } from '../src/tomography-views.ts';

// Real 2 x 2 canvas-compatible JPEG containers; no identifying labels or metadata.
export const jpegUrls = ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwKiiigD//2Q==', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1OiiigD//2Q=='];
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const spec = () => ({ plane: 'axial', center: [10, 20, 30], widthMm: 2, heightMm: 2, windowCenter: 500, windowWidth: 1500 });
export const summary = () => ({
  volumeId: 'volume-1', coordinateSystem: 'LPS', units: 'mm', dimensions: [20, 30, 40],
  spacingMm: [0.2, 0.3, 0.4], originLpsMm: [-1, -2, -3], directionsLps: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  complete: true, missingSlices: 0, quantitativeMeasurementsAllowed: true,
  provenance: { source: 'local-dicom', sourceSlices: 40, expectedSlices: 40, rescaled: true, intensityUnits: 'rescaled values' },
  registration: { status: 'unregistered', workspaceUnits: 'file units', patientToWorkspace: null },
});
export function sliceCapture(viewSpec = spec(), index = 0) {
  const frame = getSliceFrame(viewSpec);
  return {
    id: `view-${index + 1}`, volumeId: 'volume-1', kind: 'slice', projection: 'orthographic',
    dataUrl: jpegUrls[index % jpegUrls.length], pixelWidth: 2, pixelHeight: 2, spec: structuredClone(viewSpec),
    pixelOriginLpsMm: pixelToPatient(frame, 0, 0, 2, 2),
    pixelRightLpsMm: frame.right.map(v => v * viewSpec.widthMm / 2),
    pixelDownLpsMm: frame.up.map(v => -v * viewSpec.heightMm / 2),
    overlay: { registration: summary().registration, components: [] },
    sampling: 'trilinear', unavailablePixels: 0,
  };
}
export function capture3d() {
  return {
    id: 'view-1', volumeId: 'volume-1', kind: '3d', projection: 'perspective', dataUrl: jpegUrls[0], pixelWidth: 2, pixelHeight: 2,
    coordinateSystem: 'workspace file units',
    camera: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], near: 0.1, far: 1000, verticalFovDegrees: 45, aspect: 1 },
    referencePlane: { origin: [-1, 1, 0], pixelRight: [1, 0, 0], pixelDown: [0, -1, 0], units: 'file units' },
    overlay: { registration: summary().registration, components: [{ id: 'restoration-1', kind: 'restoration', localToWorkspace: identity }] },
  };
}
export const evidence = (n = 2) => ({ sharing: 'rendered-images', summary: summary(), views: Array.from({ length: n }, (_, i) => sliceCapture({ ...spec(), center: [10, 20, 30 + i] }, i)), canRequestViews: n < 8 });

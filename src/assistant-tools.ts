import { tool } from 'ai';
import { z } from 'zod';
import { assistantSnapshotSchema, assistantToolCatalog, type AssistantSnapshot } from './assistant-context.ts';
import { FDI_TEETH } from './teeth.ts';
import { MAX_TOMOGRAPHY_IMAGES, MAX_TOMOGRAPHY_ROUNDS, tomographyEvidenceSchema, tomographyLimits, tomographyViewSpecSchema, type TomographyEvidence } from './tomography-evidence.ts';

const noInput = z.object({}).strict();
const fdi = z.union(FDI_TEETH.map(value => z.literal(value)));
const clinicalLimit = 'Intraoral surface meshes do not establish CT findings, bone width, height or density, nerve or sinus locations, implant size, or safety clearance. This assistant provides no patient diagnosis and performs no automatic movement.';
const chartLimit = 'FDI status, restoration intent, triangle assignments, notes, and site markers are user-entered records, not verified anatomy. Unreviewed and not-scanned do not mean absent; missing means the user marked missing.';
const collisionLimit = 'Triangle crossings and repeated triangle-corner vertex samples are mesh evidence, not exact contact area, overlap volume, or clinical clearance. Inside tests require closed surfaces. Sampled gaps can exceed the true surface gap. Self-intersections within a scan are not tested.';
const fitLimit = 'RMS uses fixed initial reference samples. Coverage is the fraction within the match radius with compatible normals, not contact area or clinical accuracy. These measurements describe the saved fit, not a later manual pose.';
const probeLimit = 'The probe is the corner nearest the click, not the exact clicked point. Indices start at zero; vertexIndex is the expanded corner index, not a local 0–2 corner. A negative signed sample indicates inside a closed comparison surface; null is unavailable, not zero or clear. The stored distance does not identify its target scan when several scans are compared.';
const distanceLimit = 'Euclidean marker-to-marker distance in workspace coordinates is not intertooth width, surface gap, available bone, or implant safety clearance. File units are not assumed to be millimeters.';

function readOnlyTool<S extends z.ZodType, Output extends object>(
  name: typeof assistantToolCatalog[number]['name'],
  inputSchema: S,
  execute: (input: z.infer<S>) => Output,
) {
  const entry = assistantToolCatalog.find(entry => entry.name === name)!;
  // Also validate direct execution, which does not pass through the SDK's validator.
  const validatedExecute = (input: z.infer<S>) => execute(inputSchema.parse(input));
  return Object.assign(tool<z.infer<S>, object, {}>({
    title: entry.title,
    description: entry.description,
    inputSchema,
    execute: validatedExecute,
    metadata: { annotations: { readOnlyHint: true } },
  }), { inputSchema, execute: validatedExecute });
}

/** Tools close over one validated snapshot and cannot modify the application's case. */
export function createAssistantTools(snapshot: AssistantSnapshot) {
  const current = assistantSnapshotSchema.parse(snapshot);
  const output = <T extends object>(data: T, limits: readonly string[] = []) => ({
    units: current.units,
    provenance: current.provenance,
    ...data,
    limitations: [...limits, clinicalLimit],
  });
  const toothAt = (code: number) => current.teeth.find(tooth => tooth.fdi === code)!;

  return {
    getModelInventory: readOnlyTool('getModelInventory', noInput, () => output({
      selectedPartId: current.selectedPartId,
      analysisState: current.analysisState,
      nearSurfaceThreshold: current.tolerance,
      parts: current.parts,
    }, ['Dimensions are extents of original file-axis bounds, not workspace bounds, tooth size, or bone dimensions. Offsets use file units; rotations use degrees. Saved bite poses are separate from manual movement. Roles may start as filename suggestions and require user confirmation. Closedness describes geometry, not tissue type. Scan identifiers are anonymized within this snapshot.'])),

    getToothChart: readOnlyTool('getToothChart', z.object({ fdi: fdi.optional() }).strict(), ({ fdi }) => output({
      numbering: 'FDI permanent',
      selectedFdi: current.selectedFdi,
      notesIncluded: current.notesIncluded,
      teeth: fdi === undefined ? current.teeth : [toothAt(fdi)],
    }, [chartLimit])),

    inspectImplantSite: readOnlyTool('inspectImplantSite', z.object({ fdi }).strict(), ({ fdi }) => {
      const record = toothAt(fdi);
      return output({
        status: record.site ? 'available' : 'unavailable',
        record,
        ...(record.site ? {} : { reason: 'No usable user-placed surface marker is recorded for this FDI position.' }),
      }, [chartLimit, 'A surface marker identifies only a user-chosen point on an imported mesh in workspace coordinates. It does not establish implant suitability or an implant trajectory.']);
    }),

    getCollisionReport: readOnlyTool('getCollisionReport', noInput, () => {
      const report = current.collision;
      const flagsKnown = report?.pairs.every(pair => (pair.intersectingTriangles ?? 0) > 0 || (pair.penetratingVertices ?? 0) > 0
        || (pair.intersectingTriangles !== null && pair.penetratingVertices !== null));
      return output({
        status: report ? 'available' : 'unavailable',
        analysisState: current.analysisState,
        tolerance: current.tolerance,
        report,
        crossingOrInsidePairCount: report && flagsKnown
          ? report.pairs.filter(pair => (pair.intersectingTriangles ?? 0) > 0 || (pair.penetratingVertices ?? 0) > 0).length
          : null,
        interpretation: report
          ? report.pairs.length
            ? 'Returned pairs have crossing triangles, inside samples, or nearby vertex samples. Nearby samples alone do not establish intersection.'
            : 'No intersections, inside samples, or nearby vertex samples were flagged at this tolerance. This does not establish exact separation or clinical clearance.'
          : 'A current collision report is unavailable. Running, paused, or unavailable analysis must not be described as clear.',
      }, [collisionLimit, 'The report covers complete visible non-reference scans; tooth isolation only affects presentation. Unlisted pairs were not flagged by this analysis, not proven clinically clear.']);
    }),

    getBiteFitReport: readOnlyTool('getBiteFitReport', noInput, () => output({
      status: current.biteFit.arches.length ? 'available' : 'unavailable',
      ...current.biteFit,
      interpretation: current.biteFit.manualMovementExists
        ? 'Manual movement exists. Saved fit statistics do not measure the current manually moved pose.'
        : 'Saved fit statistics describe the saved registration. They do not validate clinical alignment.',
    }, [fitLimit])),

    inspectSurfaceProbe: readOnlyTool('inspectSurfaceProbe', noInput, () => output({
      status: current.probe ? 'available' : 'unavailable',
      analysisState: current.analysisState,
      probe: current.probe,
      ...(current.probe ? {} : { reason: 'No surface corner is currently selected.' }),
    }, [probeLimit, collisionLimit])),

    measureSiteDistance: readOnlyTool('measureSiteDistance', z.object({ fromFdi: fdi, toFdi: fdi }).strict(), ({ fromFdi, toFdi }) => {
      const from = toothAt(fromFdi).site, to = toothAt(toFdi).site;
      const missingMarkers = [...new Set([...(from ? [] : [fromFdi]), ...(to ? [] : [toFdi])])];
      const measured = from && to ? Math.hypot(...from.workspacePoint.map((value, i) => value - to.workspacePoint[i])) : null;
      const distance = measured !== null && Number.isFinite(measured) ? measured : null;
      return output({
        status: distance === null ? 'unavailable' : 'available',
        fromFdi, toFdi, from, to, distance, missingMarkers,
        measurement: 'Euclidean workspace marker-to-marker distance',
        ...(distance === null ? { reason: missingMarkers.length ? 'Both FDI positions need usable user-placed surface markers.' : 'The marker distance is outside the finite numeric range.' } : {}),
      }, [distanceLimit, chartLimit]);
    }),

    getPlanningChecklist: readOnlyTool('getPlanningChecklist', noInput, () => {
      const implantSites = current.teeth.filter(tooth => tooth.restoration === 'implant');
      const roleCounts = Object.fromEntries(['upper', 'lower', 'bite', 'model'].map(role => [role, current.parts.filter(part => part.role === role).length]));
      return output({
        unreviewedFdi: current.teeth.filter(tooth => tooth.status === 'unreviewed').map(tooth => tooth.fdi),
        notScannedFdi: current.teeth.filter(tooth => tooth.status === 'not-scanned').map(tooth => tooth.fdi),
        userMarkedMissingFdi: current.teeth.filter(tooth => tooth.status === 'missing').map(tooth => tooth.fdi),
        implantSitesWithoutMarkers: implantSites.filter(tooth => !tooth.site).map(tooth => tooth.fdi),
        scanRoleCounts: roleCounts,
        biteRefinementInputsAvailable: roleCounts.upper === 1 && roleCounts.lower === 1 && roleCounts.bite > 0,
        scansLoaded: current.parts.length,
        collisionAnalysisState: current.analysisState,
        savedBiteFitAvailable: current.biteFit.arches.length > 0,
        manualMovementExists: current.biteFit.manualMovementExists,
        reviewItems: [
          'Review user-entered FDI statuses, restoration intent, triangle assignments, and surface markers.',
          'Confirm file units and shared scan coordinates; file-axis dimensions do not measure bone.',
          current.collision ? 'Review the ready collision report within its sampled-geometry limits.' : 'Obtain a ready collision analysis before describing current mesh relationships.',
          current.biteFit.manualMovementExists ? 'Review manual movement separately from saved bite-fit statistics.' : 'Review any saved bite-fit statistics within their sampling limits.',
          'A clinician must determine what clinical examination and appropriate imaging are needed for implant planning; this mesh snapshot cannot establish bone dimensions, critical anatomy, implant size, or safety clearance.',
        ],
      }, [chartLimit, collisionLimit, distanceLimit]);
    }),
  };
}


/** A selected image becomes native multimodal content, never base64 embedded in tool text. */
export function createTomographyTools(evidence?: TomographyEvidence, round = 0) {
  const current = evidence === undefined ? undefined : tomographyEvidenceSchema.parse(evidence);
  const describe = (view: NonNullable<typeof current>['views'][number]) => {
    const { dataUrl: _localImage, ...metadata } = view;
    return metadata;
  };
  let imageSelections = 0;
  const inspectionSchema = z.object({ viewId: z.string().regex(/^view-[1-8]$/) }).strict();
  return {
    getTomographyInventory: readOnlyTool('getTomographyInventory', noInput, () => ({
      status: current ? 'available' : 'unavailable',
      sharing: current ? 'rendered-images' : 'off',
      summary: current?.summary ?? null,
      views: current?.views.map(describe) ?? [],
      additionalViewsAvailable: Boolean(current?.canRequestViews && round < MAX_TOMOGRAPHY_ROUNDS),
      limitations: tomographyLimits,
      ...(!current ? { reason: 'No rendered images have been shared. The assistant cannot see tomography or the viewport.' } : {}),
    })),
    inspectTomographyView: tool({
      title: 'Inspect rendered tomography image',
      description: 'See one exact opted-in local slice or 3D image by view ID from getTomographyInventory, with pixel axes, window, projection and overlay metadata. No arbitrary viewport access.',
      inputSchema: inspectionSchema,
      execute: input => {
        const { viewId } = inspectionSchema.parse(input);
        const view = current?.views.find(view => view.id === viewId);
        if (view && imageSelections >= MAX_TOMOGRAPHY_IMAGES) return { status: 'unavailable' as const, reason: 'The per-request image inspection limit was reached.', limitations: tomographyLimits };
        if (view) imageSelections++;
        return view ? { status: 'available' as const, metadata: describe(view), summary: current!.summary, limitations: tomographyLimits }
          : { status: 'unavailable' as const, reason: 'That rendered view is not in the explicitly shared image set.', limitations: tomographyLimits };
      },
      toModelOutput: ({ input, output }) => {
        const view = current?.views.find(view => view.id === input.viewId);
        return { type: 'content' as const, value: [
          { type: 'text' as const, text: JSON.stringify(output) },
          ...(view && output.status === 'available' ? [{ type: 'file' as const, mediaType: 'image/jpeg', data: { type: 'data' as const, data: Uint8Array.from(atob(view.dataUrl.slice('data:image/jpeg;base64,'.length)), char => char.charCodeAt(0)) } }] : []),
        ] };
      },
      metadata: { annotations: { readOnlyHint: true } },
    }),
    // No execute: the stream hands a single precise request back to the local renderer.
    ...(current?.canRequestViews && current.views.length < MAX_TOMOGRAPHY_IMAGES && round < MAX_TOMOGRAPHY_ROUNDS ? {
      requestTomographyView: tool({
        title: 'Request a precise local slice',
        description: 'Request one additional locally rendered slice at exact LPS millimeter center, plane/basis, field of view and window. The client may render it and resume this question; do not claim to see it until inspectTomographyView returns its actual image. Request at most one view per round, at most three rounds. Cannot move restorations or create arbitrary 3D cameras.',
        inputSchema: tomographyViewSpecSchema,
        metadata: { annotations: { readOnlyHint: true } },
      }),
    } : {}),
  };
}

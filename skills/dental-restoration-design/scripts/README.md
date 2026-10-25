# Deterministic dental planning concept scripts

Run from the repository root with its installed dependencies; use **Node 24** for the assembly CLI and TypeScript stripping. No extra dependencies, service, AI model, patient provider call, or code execution endpoint is needed. These scripts write local artifacts; the in-app restoration worker is a separate executor. Keep patient files and derived inventory/previews outside git.

```sh
node --experimental-strip-types skills/dental-restoration-design/scripts/inspect-scans.mjs --help
node --experimental-strip-types skills/dental-restoration-design/scripts/generate-concept.mjs --help

node --experimental-strip-types skills/dental-restoration-design/scripts/inspect-scans.mjs \
  --upper /private/upper.ply --lower /private/lower.stl --bite /private/bite.obj \
  --out /tmp/ios-inspection

node --experimental-strip-types skills/dental-restoration-design/scripts/generate-concept.mjs \
  --spec /private/concept-spec.json --out /tmp/crown-concept

node --experimental-strip-types --test tests/dental-concept.test.mjs
```

Output directories must not already exist. Role flags can repeat; at least one scan is needed for inspection. Inspection writes `inventory.json`, `preview.json`, `preview.html`; crown-only generation writes `crown-concept.ply`, normalized `spec.json`, `report.json`, `preview.json`, `preview.html`. Open the HTML locally to orbit/zoom/toggle the sampled geometry. No external assets are loaded. Only the viewing camera is centered; preview JSON and PLY retain global coordinates. The preview is limited to 6000 deterministic triangle samples, so it can omit small features.

## Three-part assembly CLI and pure API

```sh
node --experimental-strip-types skills/dental-restoration-design/scripts/generate-assembly.mjs \
  --spec /private/assembly-spec.json --out-dir /tmp/restoration-assembly
```

`--out-dir` is a new directory. The outputs are **`fixture.ply`, `abutment.ply`, `crown.ply`, and `manifest.json`**. This command uses the pure `generateRestoration(spec)` from `src/restoration-geometry.ts`; it does not call the crown-only generator, read patient meshes, fit geometry, or invoke a provider. Keep all three files with the manifest and the source/pose case record. Import each component independently into the common frame.

The input is the exact `RestorationSpec` from `src/restoration-types.ts`. This complete example uses **arbitrary synthetic file-unit values, not automatic or clinical defaults**:

```json
{
  "version": "implant-assembly/v1",
  "fdi": 11,
  "parentPartId": "synthetic-source-part",
  "frame": {
    "origin": [0, 0, 0],
    "u": [1, 0, 0],
    "v": [0, 1, 0],
    "up": [0, 0, 1]
  },
  "parameters": {
    "fixture": { "radius": 0.6, "length": 4, "depth": 0.5, "taper": 0.2 },
    "abutment": { "radius": 0.4, "height": 1, "emergenceRadius": 0.7, "angleX": 0, "angleY": 0 },
    "crown": { "width": 2, "depth": 1, "height": 2, "cuspHeight": 0.3, "rotation": 0 }
  },
  "anatomy": "incisor",
  "provenance": "hypothesized",
  "units": "file units (u)",
  "source": "Synthetic format example; no patient anatomy or clinical measurements."
}
```

All component parameters are explicit in CLI input. The app may propose geometric defaults and then allow manual tuning; save those actual values in the spec. `anatomy` supports `incisor`, `canine`, `premolar`, or `molar`; `provenance` is `hypothesized` or `clinician-entered`. Permanent-tooth FDI format is validated, not inferred from a scan. Nonempty `parentPartId` and `source` record caller context; they do not independently verify source bytes or pose.

The source frame must be right-handed orthonormal (`u × v = up`) within `1e-8`. Fixture coronal face is at `origin - depth*up`; its apical face is a further `length` opposite `up`. The generic abutment begins at that platform, bridges the depth to the site plane, and continues to its angled top at the stated upward `height`; the crown starts at that top. The contiguous envelopes are simplified concept interfaces, not a precision implant connection. All lengths are **file units (`u`)**, all angles **degrees**, and taper dimensionless. See [component parameters](../references/component-parameters.md) for formulas and numerical validation. Source poses must be composed once outside the generator; no recentering, unit inference, or registration is performed.

`generateRestoration(spec)` returns three `RestorationMesh` objects with `component`, Float32 `positions` and `normals` as triangle soup, `triangles`, `vertices`, `closed`, and source-axis bounding `dimensions`. The generator has no filesystem/network I/O. Its closed-surface/winding checks and Float32 precision checks are construction checks, not a collision/fit audit. It supplies no thread, compatible platform, screw channel, intaglio, material thickness, or bone-safe depth. Fixture and abutment envelopes remain hypotheses even after manual edits. The in-app executor must cancel stale worker jobs and reject results for outdated source poses or parameters before applying them.

## Existing crown-only spec contract

[`synthetic-example.json`](./synthetic-example.json) is a complete runnable schema example with arbitrary synthetic numbers and an explicitly fake hash, **not clinical defaults**. Use inspection hashes from actual files, record the basis of each caller-supplied value, and place the frame at a manually chosen hypothetical IOS gap. There is no automatic site detection or anatomy inference. All geometry parameters, axes, units metadata, source provenance, and tessellation are required. Unknown fields and missing/invalid values fail validation.

- `schemaVersion`: `dental-crown-concept/v1`; `purpose`: `exterior-concept-only`.
- `units`: `{status: "unknown", name: null, provenance: "..."}` or `{status: "declared", name: "caller unit label", provenance: "basis for declaration"}`. Declaration records metadata; it never rescales values. All lengths remain **file units**.
- `sources`: 1–64 objects with `id: "sha256:<64 lowercase hex digits>"` (the hash of original file bytes), `fileName`, `role: "upper"|"lower"|"bite"`, `fileToWorld` (16 finite column-major rigid-matrix numbers), and nonempty `provenance`. IDs are unique. Generation records these supplied identities without reading the files or verifying their hashes. Inspection computes actual byte hashes and reports identity matrices because it performs no registration.
- `site`: `{hypothetical: true, toothNotation, toothIdentity, arch: "upper"|"lower", sourceScanId, provenance}`. The source must match the arch. Tooth notation/identity are opaque caller labels, not a diagnosis or a validated tooth-number lookup.
- `frame`: `{origin: [x,y,z], xAxis: [x,y,z], yAxis: [...], zAxis: [...], provenance}`. Axes must be unit length, mutually orthogonal, and right-handed (`x cross y = z`) within `1e-8`; no normalization is applied. Local +z goes from the artificial base toward the occlusal surface. The caller chooses anatomical meanings of local x/y. No assumption about global Z, upper/lower direction, or millimeters exists.
- Output `pose`: `{storage: "column-major", localToWorld: [...16], worldToLocal: [...16]}` is derived from the frame. It can be supplied on reimport, in which case it must agree with the frame. For a point `[x,y,z,1]`, `world = localToWorld * local`. The frame already lives in the common world coordinate system; source matrices are provenance, not applied a second time to the concept. Identity source matrices preserve original co-registered files. Any prior registration must be explicit in the source matrices and provenance.
- `geometry`: `kind: "parametric-crown-exterior-v1"`, `toothClass: "molar"|"premolar"` (metadata), positive `width`, `depth`, `basalWidth`, `basalDepth`, `shoulderHeight`, `domeHeight`, `grooveWidth`; nonnegative `grooveDepth < shoulderHeight` and `grooveDepth <= domeHeight`; `basalClosure: "artificial-flat-cap"`. The depth constraint keeps the top above the shoulder and prevents side-wall crossings. Basal dimensions cannot exceed width/depth. All dimensions are file units. No dimensions have defaults. Width/depth describe the nominal footprint ellipse; angular sampling can miss its exact extrema. Cusp amplitudes and dome height do not specify an exact overall height.
- `cusps`: 1–8 `{position: [localX, localY], height, radius}` objects. Positions must be strictly inside the ellipse with radii `width/2`, `depth/2`; heights and radii must be positive. Height is a **Gaussian influence amplitude**, not an independently exact apex height. Influence width is `radius`, in file units. Two influences can make a premolar-like outline; four can make a molar-like outline. The caller chooses all values.
- `tessellation`: explicit integer `angularSegments` in 12–256, `axialSegments` in 1–64, `radialSegments` in 2–128, at most 100000 faces. These are numerical mesh limits, not anatomical recommendations.

The surface is an elliptical, nested-ring side wall plus a radial height-field top. With `q = 1-(2x/width)^2-(2y/depth)^2`, top height is `shoulderHeight + q*(domeHeight + sum(height_i*exp(-distance_i^2/(2*radius_i^2))) - grooveDepth*max(exp(-(x/grooveWidth)^2), exp(-(y/grooveWidth)^2)))`. Thus the groove follows the local x/y cross and fades at the outer rim. The basal ring is at local z=0 and is closed by a **flat artificial triangle fan**. A watertight concept cap is not a fitted intaglio or a clinical margin. Extremely narrow cusp/groove details may be missed by the chosen tessellation; choose explicit resolution and inspect the result.

## Existing crown-only importable API

```js
import {
  validateConceptSpec, createCrownConcept, toPLY, trianglePositions,
} from './skills/dental-restoration-design/scripts/dental-concept.mjs';

const { spec, mesh, report } = createCrownConcept(callerJSON, {
  checkCancelled: () => { if (cancelled) throw new Error('Cancelled'); },
});
// mesh.positions: Float64Array xyz in global coordinates
// mesh.indices: Uint32Array triangle indices
const collisionPart = {
  id: 'hypothetical-crown', closed: report.integrity.closed,
  positions: trianglePositions(mesh), // Float64 triangle soup for src/collision.ts
};
const ply = toPLY(mesh);
```

The core module has no Node/browser I/O and accepts data only. `validateConceptSpec()` returns a detached spec with recorded pose matrices; `frameMatrices()`, `transformPoint()`, `inspectMesh()`, and `meshBounds()` are also exported. Node-only `inspectScanBytes(bytes, fileName, role)` and `inspectLocalScans([{path, role}])` reuse the repository's `src/import-models.ts`; `createPreviewData(parts)` and `createPreviewHTML(data)` create local preview artifacts. Importer UUIDs are replaced by deterministic hash/part IDs in saved inventory. Repeated identical inputs produce identical generated vertices, PLY, normalized spec, and report; there are no timestamps or random generation seeds.

Keep expensive collision analysis outside this pure generation module: a future worker can pass `collisionPart` to `src/collision.ts` using an explicitly chosen file-unit tolerance. Cancel/replace stale worker jobs using the application's existing worker approach; the generation hook checks cancellation between rings and coordinate batches. A synchronous cancellation hook cannot receive events while a worker is blocked; terminate the stale worker or use a shared cancellation flag. No collision, exact contact area, or overlap volume is claimed by this kit.

## Crown-only limits

The report marks fixture, abutment, clinical fit, and occlusion **unassessed**, and manufacturing **not-for-manufacturing**. There is no implant fixture/connection geometry, abutment design, drill guide, intaglio, tissue fitting, material model, registration, automatic clinical defaults, or donor morphing. The shapes are compact mathematical exterior concepts, not trained dental anatomy. Closed status means consistent edge incidence and connected vertex fans; general input self-intersections are not ruled out. The generated surface is a positive height graph above a nested side wall with an artificial cap.

Canonical geometry uses Float64; the existing importer stores Float32, so bounds and previews have that precision. Generation rejects non-finite/degenerate geometry or global poses that collapse triangles at importer precision instead of silently recentering the patient coordinates. The CLI additionally round-trips the PLY as one closed component through the actual importer. Physical units remain unknown unless explicitly declared by the caller. Scan role labels and byte hashes establish file identity, not anatomical identity, orientation, or clinical suitability.

## Donor exterior API and local CLI

The donor route clips existing scan triangles and applies an explicit affine edit. It preserves retained donor detail without smoothing or synthesizing anatomy. Selection cuts remain **uncapped**; an OPEN exterior is valid output. This route does not create an intaglio, fixture, abutment, or implant connection and does not assess fit, occlusion, contacts, tissue clearance, material thickness, or manufacturing readiness.

```js
import {
  createDonorExterior, validateDonorSpec, toPLY,
} from './skills/dental-restoration-design/scripts/donor-exterior.mjs';

// Arbitrary synthetic triangle and numbers; not anatomy or clinical defaults.
const positions = new Float64Array([-1, 0, 0, 1, 0, 0, 1, 2, 0]);
const input = {
  schemaVersion: 'dental-donor-exterior/v1',
  source: {
    id: 'synthetic-donor', sha256: '0'.repeat(64),
    provenance: 'Synthetic example; deliberately fake, unverified hash.',
  },
  planes: [{ normal: [-1, 0, 0], offset: 0 }],
  sourceToTarget: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
  weldTolerance: 1e-9,
  componentPolicy: 'largest',
};
const { spec, mesh, selection, report } = createDonorExterior(positions, input, {
  checkCancelled: () => false, // Throw to cancel, or return true. Must be synchronous.
});
// mesh.positions: Float64Array; mesh.indices: Uint32Array.
// Both source and resulting target coordinates stay in file units.
const ply = toPLY(mesh);
```

`validateDonorSpec(input)` returns a detached spec. All fields shown above are required; unknown fields fail. `source.id` and `source.provenance` are nonempty strings of at most 2000 characters; `source.sha256` is exactly 64 lowercase hex digits. The pure core records these as **caller-supplied-unverified** metadata and never reads a file. Pass geometry obtained from validated local handles to a future worker or Vercel AI SDK executor; do not expose the CLI's filesystem parameters as an unrestricted tool.

- `positions` is a nonempty finite number array, Float32Array, or Float64Array of xyz triangle corners, with length divisible by nine. Face IDs are zero-based input triangle-soup order. At most 2,000,000 source triangles and 2,000,000 retained output triangles are allowed; clipping can expand the output. Degenerate input faces fail, including faces outside the selection.
- `planes` is an explicit array of zero to 32 `{normal: [x,y,z], offset: number}` objects. Normals must already be unit length within `1e-8`; they are never normalized. Each finite plane retains `dot(normal, sourcePoint) <= offset`. Clipping occurs before the transform, including crossing faces, with no anatomical axis or cut-plane defaults. Empty and point/edge-only selections fail.
- `sourceToTarget` is 16 finite **column-major** numbers. The last row must be exactly `[0,0,0,1]`; its numerically computed linear determinant must be finite and nonzero. Reflection, shear, translation, and explicit scale are allowed; this is an **affine donor edit**, never a rigid source pose. Negative determinant reverses output winding once. No additional scale, unit conversion, registration, or recentering occurs.
- `weldTolerance` is explicitly positive and finite, in **source file units**. Vertices within that Euclidean distance of an existing representative are welded deterministically to the earliest representative, using neighboring spatial cells. It does not smooth the surface. Coordinate/tolerance cell indices must fit the safe integer grid range; unsupported ranges fail. Zero-area clipped remnants or triangles collapsed by welding are counted and discarded. Output that collapses under its affine transform fails.
- `componentPolicy` is `"largest"` or `"all"`. Components share welded **edges**; touching only at a vertex does not connect patches. Largest means greatest retained triangle count, ties resolved by first source order. This criterion depends on source tessellation and clipping, not anatomical importance or physical area.

`selection.triangles[i]` contains `{sourceFace, clipped}` for output triangle `i`, including every triangle produced by clipping a face. `clipped` means part of that retained source face was removed by a half-space. Selection records the planes, source metadata, weld space/tolerance, retained source-face counts, discarded degenerate triangle count, and removed component triangle counts. `report.transform` records the affine matrix, determinant, and winding reversal. `report.integrity` reports counts, edge-connected components, boundary edges, non-manifold edges/vertices, shared winding, finite positive area in squared file units, bounds, and `surfaceStatus`. `closed` is only a topology check; self-intersections are unassessed. **`signedVolume` is always null**; no solid or overlap volume is computed. Source coordinates need not be Float32-representable in the pure API.

The coding-agent CLI accepts the same fields except that `source` must be `{path, sha256, partIndex?}`. `path` is a local file path resolved relative to the spec file; URLs are rejected. `sha256` is the expected original **file byte** hash, verified before importing. `partIndex` is zero-based repository importer order, required when a file produces multiple parts. The selected part's triangle order, rather than original OBJ/PLY polygon IDs, defines source-face mapping. The spec is at most 1 MiB and source file at most the existing 100 MiB importer budget. No network, AI call, material loading, or additional dependencies are used.

This runnable example creates only synthetic data in a new temporary directory:

```sh
DONOR_EXAMPLE_DIR="$(mktemp -d)"
node --input-type=module - "$DONOR_EXAMPLE_DIR" <<'JS'
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const directory = process.argv[2];
const source = 'v -1 0 0\nv 1 0 0\nv 1 2 0\nf 1 2 3\n';
await writeFile(join(directory, 'synthetic-donor.obj'), source);
await writeFile(join(directory, 'donor-spec.json'), JSON.stringify({
  schemaVersion: 'dental-donor-exterior/v1',
  source: {
    path: 'synthetic-donor.obj',
    sha256: createHash('sha256').update(source).digest('hex'),
    partIndex: 0,
  },
  planes: [{ normal: [-1, 0, 0], offset: 0 }],
  sourceToTarget: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
  weldTolerance: 1e-9,
  componentPolicy: 'largest',
}, null, 2));
JS
node --experimental-strip-types skills/dental-restoration-design/scripts/generate-donor.mjs \
  --spec "$DONOR_EXAMPLE_DIR/donor-spec.json" --out "$DONOR_EXAMPLE_DIR/output"
node --experimental-strip-types --test tests/dental-donor.test.mjs
```

`--out` must be a NEW directory with an existing parent; an atomic directory creation and exclusive writes prevent overwrite. Validation and importer round-trip checks run before output creation. The four artifacts are `crown-exterior.ply` (ASCII double xyz, explicit exterior-only header), normalized replayable `spec.json`, `selection-map.json`, and `report.json`. No source file is copied. Reports record verified source byte SHA256, selected part, and **ordered source triangle SHA256** encoded as little-endian Float64 xyz promoted from importer Float32 values. The core's caller-metadata verification status remains separate from CLI byte verification.

The CLI reimports its PLY through the actual repository importer and compares triangle counts plus the oriented triangle-coordinate multiset at Float32 precision, allowing component regrouping. It reports coordinate rounding error, per-part closed status, and importer warnings. Open warnings are expected and do not mean failure. A collapsed Float32 triangle fails without moving the coordinates. Float32 rounding can merge distinct vertices or surfaces, and importer parts use vertex connectivity; a successful round trip is **not proof of unchanged topology or fit**. Near-singular affine matrices and floating-point clipping remain subject to numerical limits. Cancellation checks occur throughout the pure core; terminate a stale worker or use a shared flag because a synchronous callback cannot receive queued events while the worker is blocked.

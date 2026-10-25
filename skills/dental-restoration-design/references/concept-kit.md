# Deterministic restoration concept kit

The kit has separate contracts for a **three-part planning assembly**, the existing **procedural molar/premolar crown envelope**, and the **scan-donor exterior route**. All use explicit local data without dental-network training, patient provider calls, or additional dependencies. None identifies a missing tooth, infers bone, establishes a compatible implant connection, or validates clinical fit. Read the [script contract](../scripts/README.md) for invocation and exported APIs; use [synthetic-example.json](../scripts/synthetic-example.json) only as a crown-only format example, never patient defaults.

## Three-part planning assembly

The pure `src/restoration-geometry.ts` API, `generateRestoration(spec)`, accepts the `RestorationSpec` in `src/restoration-types.ts` and returns separate **fixture**, **abutment**, and **crown** triangle soups. Its `implant-assembly/v1` schema is distinct from `dental-crown-concept/v1`. The exact controls and clinical distinctions are in [component parameters](component-parameters.md).

The fixture is a smooth tapered envelope without threads or an interface. The abutment/pilar has radius, height, emergence radius, and two slope controls. Crown width/depth/height, relief height, and rotation support incisor, canine, premolar, and molar hypotheses. The in-app restoration executor can supply automatic geometric defaults and accept manual edits; the pure generator and CLI require the resulting explicit parameters. Defaults remain hypotheses, including fixture length/depth, regardless of how plausible they look.

The source frame `{ origin, u, v, up }` is right-handed and orthonormal (`u × v = up`). Fixture coronal face is at `origin - depth*up`, extending a further `length` opposite `up`; the generic abutment begins at that platform and spans to its shifted top above the site plane, where the crown begins. These contiguous envelopes do not represent a precision implant connection. Lengths are **file units (`u`)**, angular controls degrees. Preserve source coordinates and apply current source poses once outside the pure generator.

From the repository root, using Node 24:

```sh
node --experimental-strip-types skills/dental-restoration-design/scripts/generate-assembly.mjs \
  --spec /tmp/dental-case/assembly.json --out-dir /tmp/dental-case/assembly-01
```

The CLI writes `fixture.ply`, `abutment.ply`, `crown.ply`, and `manifest.json` to a new directory. Keep the manifest with the component files and inspect its recorded spec, limitations, and assessments; a CLI export is not automatically a full case record or collision audit. The existing `generate-concept.mjs --spec … --out …` route remains unchanged.

The local app worker executes this generator. When the live host explicitly enables bounded restoration-edit tools, chat may propose a validated component edit and receive the worker’s fresh evaluation; absent/disabled tools remain unavailable. Geometry stays local. Bind jobs and exported components to source identity, pose, site, and parameters; terminate stale jobs and reject outdated results. The generator returns Float32 positions/normals, triangle and vertex counts, closed status, and source-axis bounding dimensions. It rejects invalid frames, collapsed geometry, and failed winding/edge-closure checks; these do not assess self-intersection, fit, contact, tissue response, or manufacturing.

## Existing crown-only procedural route

From the repository root:

```sh
node --experimental-strip-types skills/dental-restoration-design/scripts/inspect-scans.mjs --help
node --experimental-strip-types skills/dental-restoration-design/scripts/generate-concept.mjs --help
node --experimental-strip-types skills/dental-restoration-design/scripts/generate-donor.mjs --help

node --experimental-strip-types skills/dental-restoration-design/scripts/inspect-scans.mjs \
  --upper /private/upper.ply --lower /private/lower.ply \
  --bite /private/bite1.ply --bite /private/bite2.ply \
  --out /tmp/dental-case/inspection

node --experimental-strip-types skills/dental-restoration-design/scripts/generate-concept.mjs \
  --spec /tmp/dental-case/design.json --out /tmp/dental-case/candidate-01
```

Each output directory must be new. Inspection computes real source byte hashes, preserves coordinates, and reports unknown physical units and identity matrices; it does not register the case. Crown-only generation validates caller-provided provenance and parameters and writes the importable PLY, normalized spec, topology report, and local preview. Source hashes in a spec are claims until checked against the inspected files.

All lengths are **file units**. The frame is explicitly right-handed and orthonormal; local +z points from the artificial base toward the occlusal surface. Upper crowns may therefore point opposite to lower crowns in the same global frame. The generated coordinates already live in the shared workspace; do not reapply source transforms to them. No automatic recentering, scaling, or axis normalization occurs.

The pure module `scripts/dental-concept.mjs` exports `validateConceptSpec`, `createCrownConcept`, `trianglePositions`, `inspectMesh`, `frameMatrices`, `transformPoint`, and `toPLY`. It is suitable as the deterministic core of a worker or a future validated SDK tool. Its cancellation checks supplement worker termination; a synchronous callback cannot process queued abort events while blocked.

The top is a controlled height field with cusp influences and a cross-shaped groove, joined to nested side rings and an artificial basal fan. Those are mathematical shape controls, not validated dental anatomy. Cusp influence amplitudes do not equal independently measured apex heights. The flat basal cap is not an inner fitting surface, tissue-contact design, material-thickness measurement, or implant seat.

The CLI verifies export/reimport through the project's importer. Its report describes construction/topology checks only. To evaluate fit, separately run actual distance/intersection checks against the source arches and inspect the candidate in context as described in [geometry workflow](geometry-workflow.md). Mark omitted checks untested. The generated concept must not inherit an occlusion pass from a successful topology report.

The self-contained preview displays a bounded triangle sample and may omit fine features; use a sufficiently detailed renderer and close views for the case decision. Render images are evidence of appearance, not a replacement for numeric geometry checks. Keep source meshes and derived case artifacts outside git; this repository ignores `work/dental-skill-evaluation/` for local exercises.

## Scan-donor route

When actual anatomy is available in a suitable donor region, use `scripts/donor-exterior.mjs`. Its pure `createDonorExterior(positions, spec, options)` API clips the supplied triangle soup to explicit source-coordinate half-spaces, welds at an explicit numerical tolerance, selects configured components, and applies an explicit nonsingular affine donor edit. It preserves a source-face map, corrects winding after reflection, and reports open boundaries without inventing solid volume. The helper does not decide donor identity, anatomical margins, or clinical fit.

`scripts/generate-donor.mjs --spec /private/donor-spec.json --out /tmp/new-donor` wraps that core for a local coding agent. The CLI verifies the source byte hash, records the selected part and ordered-triangle hash encoding, and checks the exported PLY through the existing importer. It writes `crown-exterior.ply`, `spec.json`, `selection-map.json`, and `report.json`. Output directories must be new. The exact data contract and synthetic invocation are in the script README. Do not copy patient-specific cut planes, transforms, or hashes into the reusable skill.

The half-spaces use `dot(normal, sourcePoint) <= offset` and require already normalized normals. The source-to-target matrix is column-major 4×4 and may include reflection/scale; it is a donor deformation, not the source scan's rigid pose. Keep the rest of the case record and cancellation/revision checks outside the helper. A future SDK tool should pass a locally resolved geometry handle and this data specification to a worker; the CLI's file-path input is not an unrestricted server tool.

An open patch preserves selected anatomy but may truncate peripheral ridges or contain unresolved crossings. Review those actual outcomes and run the separate full-source audit before describing fit. Construction success never upgrades an open exterior patch to a complete crown or implant restoration.

# Local planning evaluation and demo workflow

This workflow produces editable **planning concepts—clinical fit unvalidated** from explicitly selected local meshes. It measures execution time and geometric objectives. Without independent ground truth, accuracy, human effort, manual baseline and time saved remain unknown. The sibling `../platanus` application is independent.

## Browser workflow

1. Start the app with `pnpm dev`. It starts empty. Use **Import files** or drop the upper, lower and bite meshes, together with any local MTL/PNG/JPEG support files. Keep every source in its shared file coordinate system. Filename roles remain hypotheses; routine drafts do not require role confirmation. **Advanced scan, side & bite corrections · optional** lets you change **Upper arch**, **Lower arch**, **Bite reference** or **Unresolved / other**. If no usable arch role exists, assign one before preparation can proceed. Bite references supply alignment evidence, not fitting collision targets.
2. Use **Start AI workflow** or **Start local workflow** once. Assessment, supported concept generation, fitting and checks continue automatically without approving findings. Read the external disclosure below when AI is configured. In advanced evidence tools, use **Retry local preparation** after a real preparation failure. Patient side can remain **Unknown**; file axes and screen position cannot establish laterality. Optional **I reviewed the current static bite pose** records a separate human review; automatic fitting does not check that box.
3. Leave physical scale unknown unless an independent calibration is available. Under **Advanced automation & physical units**, a confirmed conversion needs both **Confirmed millimetres per file unit** and **Source of calibration**, followed by **Record calibration**. Source geometry and design controls remain in **file units (u)**. Do not infer scale from arch width, filename or PLY format.
4. Supported bounded scan gaps can produce **Upper draft site** or **Lower draft site** concepts while anatomical FDI stays unknown. Crown template FDI is illustrative anatomy only and appears in advanced identity details. **Optional identity corrections**, **Use in draft**, **Use this hypothesis** and **Skip** change draft hypotheses; they never establish missing status in the reviewed chart. **Record reviewed missing + concept intent** explicitly changes that chart and requires actual review. Missing geometry, malformed scans and unlocalized sites remain visible failures or unresolved findings.
5. Automatic generation keeps **Fixture**, **Abutment (pilar)** and **Crown** independent. **I want to generate sites manually** and **Optional manual generation tools** remain available for deliberate corrections or another generation pass. Inspect **Measured fitting** and **Sampling limits & candidate history**, including the baseline, best candidate, target provenance and every surface's crossings or incomplete checks. Clinical review stays separate from automatic workflow completion.
6. Inspect the whole concept plus close views of both neighboring relationships, antagonist cusps and cervical contour. **Inspect copy** and **Retry fitting as a comparison** preserve the original. **Adjust dimensions** followed by **Apply … dimensions** reruns fitting. Under **Identification details & manual corrections → Correction tools · brush, boundary & site**, review **Add brush**, **Erase**, **Exclude gum**, **Boundary**, **Crown seed**, **Mark site**, **Undo** and **Redo**. Protected erasures and exclusions must survive later preparation. Recompute evidence after changing geometry, role, source pose, site or annotations.
7. In **Review**, inspect the workflow record and unresolved requirements before saving or exporting. Verify ordinary import → render → collision colors → offset/reset and WebGL recovery in the browser before presenting a demo. A successful export or a completed workflow is not a clinical approval.

## Generate, independently evaluate, revise

The restoration worker separates construction, measurement, evaluation and selection. `restoration-quality.ts` never reads the optimizer's score. It checks emitted crown dimensions against neighbours, measured space occupancy, each proximal side, each antagonist, crossing evidence, conflicting constraints, anatomy provenance and component proportions. Each check returns **pass**, **fail** or **unknown** with its measurements and reasons. Missing or hypothesized evidence cannot certify a pass. Bite checks require the current static bite pose to be reviewed; procedural anatomy remains an explicit hypothesis.

An evaluator can propose bounded revisions, but only regenerated and remeasured candidates can be selected. Up to four review rounds share one candidate/time budget. Bounds remain anchored to the initial specification. A lower objective cannot purchase lost ray coverage, a newly failed check, a newly open previously satisfactory contact, a new transverse crossing or the loss of complete crossing evidence. The best accepted candidate is retained, along with the measurements and quality report for every measured attempt. An unresolved conflict is shown as needing revision or review.

If a sampled candidate appears to remove an observed crossing, a follow-up screens every supplied target triangle against a conservative bounding box. Disjoint boxes are excluded; up to 20,000 remaining faces receive the triangle test, with the existing 200,000-pair limit. An oversized region, degenerate faces or exhausted pair budget stays incomplete. The follow-up also preserves a previously complete target check. Its tested-target count includes broadphase screening, not just SAT pairs. Completeness applies to the supplied crop and numerical test, not to unscanned anatomy or clinical clearance.

The initial crown normalizes the template's actual footprint, limits its width across the arch relative to its length along the arch, and reserves 10% of the overall height for the visible generic abutment. Those proportions are engineering hypotheses. The optional local antagonist adaptation lowers only the occlusal table, retains the cervical contour and walls, and limits each cut to 30% of the current crown body height. It tries initially and, if parameters improve after the first sweep, at most once more. Only one alternative anatomy is retained; retries on an adapted crown do not stack additional cuts. Actual wall vertices are checked separately from interior fossae. Missing rays remain unknown, and vertex checks alone do not establish triangle clearance or thickness.

Default evaluator tolerances are configurable, dimensionless prototype ratios, not clinical limits:

| Check | Prototype range |
| --- | --- |
| Crown length along arch / neighbouring lengths | 0.70–1.35 |
| Crown width across arch / neighbouring widths | 0.80–1.20 |
| Crown height / neighbouring heights | 0.75–1.15 |
| Occupancy of measured gap | 0.90–1.00 |
| Open proximal excess over the illustrative target | ≤ 0.03 × crown length |
| Open opposing excess over the illustrative target | ≤ 0.05 × crown height |
| Minimum observed opposing ray coverage | 0.25 |

**Rebuild from measured site** creates a comparison using current initialization while preserving the old concept. **Retry fitting as a comparison** retains the selected anatomy. Saving stores both anatomy candidates and the selected verdict; reopening checks the selected quality against the restored meshes and evidence instead of trusting the saved verdict. **View controls → Hide annotations** removes labels and overlays for inspection; editing restores its overlays.

Generated components use separate smooth display normals and illustrative ceramic/metal finishes. Collision input remains the original geometry. Individual PLY component exports include smooth normals and illustrative colour without changing coordinates or triangle order. The PBR finish is viewer-only; the current importer recomputes flat normals when a PLY is reimported. No texture, thread, precision connection or compatible hardware is invented.

This separation follows the distinct anatomical, proximal, occlusal and basal operations in the [exocad freeforming workflow](https://wiki.exocad.com/wiki/index.php/Freeforming) and its [contact/occlusion visualization](https://wiki.exocad.com/wiki/index.php/Visualizing_contacts_and_occlusions). These sources support the workflow distinction, not the prototype ratios above. See also [reference-model research](tooth-model-references.md) and [fit-constraint research](tooth-fit-research.md).

## Local and external disclosure

Import, geometry preparation, the local draft, component generation and fitting run locally. The CLI below imports no provider client and makes no network request. It does not render or send images and does not copy original scan files.

The optional external planning flow sends rendered arch JPEGs, aliases, chart records, site evidence and geometry/pose summaries. It excludes original filenames and clinician notes; image pixels can still contain patient information. Tomography sharing has a separate control. **Open assistant** is another flow: **Send to Anthropic** sends the conversation and a case snapshot. Sharing clinician notes, tomography or current 3D images has separate controls, initially disabled. Check those controls for each intended disclosure. Raw mesh arrays are not part of the metadata snapshot, and chat tools are read-only. A planner's request to queue local components is not evidence that the worker produced an artifact.

Local evaluation outputs contain derived patient geometry, source names, hashes and anatomical hypotheses. A resumable session can include rendered evidence when saved from the browser. Keep scans, textures, screenshots, sessions and exports in private local storage, outside `public` and source control. The reproducible example output belongs only under ignored `work/dental-skill-evaluation/assistant-workflow-reproducible`.

## Bounds, cancellation and stage journal

The app terminates stale preparation/fitting workers and rejects results whose source, pose, annotation or parameter dependencies changed. **Cancel**, **Pause workflow** and **Resume local draft** are available. Resume can reuse completed evidence or create a local result without another provider assessment. Completed concepts may remain as explicitly stale history and are excluded from mesh exports.

**Workflow record** records **Prepare evidence**, **Assess case**, **Localize spaces**, **Generate & fit** and **Review & handoff**, tool results and correction counts. The current app workflow budget is one provider request, three model steps, 16 tool calls, 8,192 output tokens per step, 16 sites, 14 fit candidates per site, 12 seconds fitting per site and 240 seconds overall. These are execution limits, not clinical performance measures; source code remains the authority if budgets change.

The CLI runs the composition in a killable Node worker. Inputs total at most 100 MiB, with at most 64 selected input/support files and 16 MiB per image; the importer also enforces 64 parts and two million triangles. Sessions include generated parts in that geometry budget. The default fitting bounds are 14 candidates, 12 seconds, 120 samples per surface, one million total distance-target triangles and 4,096 intersection-target triangles per surface. The fitter accepts at most 16 named surfaces. Target construction preserves original local triangle subsets; these are bounded crops, not a complete-arch audit. The overall worker deadline defaults to 180 seconds, including synchronous preparation, and its JavaScript heap is capped at 1,536 MiB. Runtime can terminate earlier on an engine or memory limit.

Use Ctrl-C to terminate the worker. `stage-journal.json` records started/completed/failed stages and durations; a timeout or cancellation writes the last received events. Partial output remains for diagnosis and must not be treated as a completed evaluation. A fit that cannot establish its baseline or meet the input contract records `fitError`, exports no fitted mesh, and returns a nonzero exit code while retaining the prepared session. Existing output directories are always refused. Use a new directory for every run; the CLI neither overwrites nor resumes partial output. It is a single-snapshot evaluator, so there is no live job to become stale; it verifies source bytes, geometry and appearance again before saving.

## Save, reopen and hash checks

**Save case** / **Save resumable case** downloads `platanus-case.json`. Keep the exact original scans and local texture support files separately; original scan buffers are not embedded. Reimport those sources, attach the original textures where needed, then use **Reopen case**. Reopen validates geometry hashes and triangle order, recorded original-byte hashes, appearance/UV/texture hashes, poses and dependencies, plus component geometry and candidate history, before returning a replacement state. An appearance mismatch requires the original evidence, not an edited hash to bypass validation. Node may preserve texture bytes and UVs without decoding colors because browser image APIs are unavailable. A browser that decodes those colors can produce a different appearance signature; a CLI session with that mismatch must not be claimed as browser-reopen compatible.

**Export components & manifest** produces `platanus-planning.zip` with independent PLY meshes and a mesh-free provenance manifest. The ZIP is not the resumable case file. The CLI uses the same `createPlanningSession`, `readPlanningSession` and `planningExportBundle` APIs. It writes `session.json` separately, preserves the actual ZIP's `manifest.json` and component PLY bytes/paths, and checks a local session readback. Geometry hashes identify original triangle-order Float32 coordinate bytes, not the ASCII PLY bytes. Each component retains its parent source coordinates; apply manifest `fileToWorkspace` exactly once. No physical-unit conversion is baked into a mesh.

## Reproducible CLI invocation

Use Node 24 and the already installed project dependencies. Run from the repository root. Replace each uppercase placeholder with an explicit private local path; nothing is inferred or loaded automatically:

```sh
node --experimental-strip-types scripts/evaluate-planning-case.mjs \
  --upper /PRIVATE/UPPER.ply \
  --lower /PRIVATE/LOWER.ply \
  --bite /PRIVATE/BITE_1.ply \
  --bite /PRIVATE/BITE_2.ply \
  --out /PRIVATE/NEW_EVALUATION_DIRECTORY
```

At least one bite is required; repeat `--bite` for additional references. Optional repeatable `--texture /PRIVATE/ATLAS.png` and `--material /PRIVATE/MATERIALS.mtl` go through the actual importer. Only explicitly selected local support files can be paired. Remote texture references are ignored. Input basenames must be unique so role and material/image pairing are unambiguous. This first run keeps unknown laterality, an entirely unreviewed chart, and physical units unknown. It prepares evidence and exports a session and manifest without automatically generating any site.

Inspect `evaluation.json`'s zero-based `sites` list. To exercise one localized space, explicitly supply a site index and a permanent FDI hypothesis in a **new** output directory. An optional side flag changes preparation into a labeled engineering scenario:

```sh
node --experimental-strip-types scripts/evaluate-planning-case.mjs \
  --upper /PRIVATE/UPPER.ply --lower /PRIVATE/LOWER.ply \
  --bite /PRIVATE/BITE_1.ply --bite /PRIVATE/BITE_2.ply \
  --side image-right \
  --fit-site SITE_INDEX --hypothesis-fdi FDI_CODE \
  --max-candidates 14 --fit-ms 12000 --timeout-ms 180000 \
  --out /PRIVATE/NEW_ENGINEERING_SCENARIO_DIRECTORY
```

`SITE_INDEX` and `FDI_CODE` are required caller choices in this second invocation, not defaults or a diagnosis. The FDI must match the source arch. The CLI accepts a poorly confident localized scanned-space hypothesis but refuses not-scanned, segmentation-unresolved, chart-only or unlocalized sites. A disposable copy is adapted to the generator's `proposed-missing` enum, with explicit unreviewed provenance. The original prepared site and reviewed chart remain unchanged. The saved session's `patientRight` remains null even for a side scenario. Generic fixture and abutment dimensions are hypotheses, not bone or hardware measurements.

The composition calls `importModels → prepareCase → localPlanningResult`, and for an explicit eligible fit, `specForHypothesis → withPatientDonor → withQualityContext → fittingSurfaces → fitRestoration`. A donor is used only if the existing donor checks accept it; rejection retains the labeled procedural hypothesis. There is no forced donor substitution, automatic site loop or provider call.

Artifacts include:

- `evaluation.json`: original byte hashes, original-coordinate bounds, geometry and appearance hashes before/after, identities/sites, caller scenario provenance, actual local result, initial spec and target hashes, fit report, every measured candidate and unresolved per-surface intersections. `implementation` hashes identify the composition and principal API files. The revision binds inputs, appearance/geometry, unknown physical scale and side scenario.
- `stage-journal.json`: observed stages, durations, completion or failure/cancellation. `effort.timings` and wall duration measure this local run; manual baseline, human active effort, time saved and accuracy remain null.
- `session.json`: validated editable session with the unmodified reviewed chart, prepared draft and any best fitted assembly. Original scans are reimported separately.
- `planning.zip`, `manifest.json`, and `FDI-…/assembly-…/{fixture,abutment,crown}.ply`: application export paths with separate components only when an explicit fit succeeds. A prepared-only run correctly has no component meshes.

The CLI summary reports objective scores, exported component count and the number of unresolved fit surfaces, or null when no fit ran. An improved engineering objective does not establish medical accuracy or effort reduction. Reproducibility means explicit inputs, hashes, parameters and measured history; a time budget and machine scheduling can change how many candidates finish.

## Current clinical and manufacturing limits

The local sequence model, site locator, procedural anatomy and donor selection are unvalidated hypotheses. A confidence score is an evidence score, not calibrated accuracy. A broad gap, missing triangles, terminal scan boundary or unknown label does not establish a missing tooth or implant indication.

Fit measurements are unsigned area-stratified triangle-barycentre samples against complete **supplied crops**, without a surface-distance error bound. A sampled minimum may exceed the true minimum. Near-sample counts and eligible region area are not contact area. The intersection check includes touching/ambiguous contact, can use a deterministic target subset and pair-test cap, and may be incomplete. Every supplied surface's before/after result remains in the report; retain all residual hits and incomplete zero tests. Unreported surfaces and omitted categories remain unmeasured. No count establishes penetration volume, force or pressure. The fixture is excluded from the fitting objective, and fixture placement stays fixed.

Open IOS surfaces have no reliable solid interior. A static bite cannot validate excursions. Closed concept meshes and an improved score do not establish self-intersection freedom, clinically correct tooth morphology, tissue fit, an intaglio, material thickness, seating, a compatible implant connection or manufacturing suitability. Fixture depth is relative to the hypothesized site frame, not a measured bone crest. Bone-safe placement and clinical/fabrication release need independent professional evidence, calibrated/registered data and the applicable manufacturer requirements. Those assessments remain unknown here.

Root validation should run `pnpm test`, `pnpm build`, and the browser smoke test before a demo. The CLI contract can be checked independently with:

```sh
node --experimental-strip-types --test tests/evaluate-planning-case.test.mjs
```

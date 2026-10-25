# Geometry and evidence workflow

## Intake and coordinate contract

Parse all source meshes locally with existing import validation. Record byte hashes, source roles, original-coordinate bounds, triangle counts, closedness warnings, and a column-major rigid file-to-workspace matrix for each source. A raw-byte hash identifies a source file; a separate geometry/triangle-order hash is needed for face labels. Do not replace either with a filename. Avoid duplicating patient files in source control or sending raw arrays to an LLM.

PLY may refer to absent textures. Geometry can still be inspected, but do not infer gingiva/tooth segmentation from missing color. Connected shells are not clinical tooth labels. Record any simplification and use it for display only unless the analysis explicitly names its approximation.

Use one workspace for upper, lower, and bites. Start from imported poses. If necessary, run the existing local rigid bite refinement against fixed reference surfaces; preserve its transforms and per-reference metrics, and reject failure rather than silently applying a partial result. A lower RMS is a fit statistic, not clinical registration accuracy. Keep original and refined poses available. Do not run registration merely to eliminate opposing-arch collisions.

Distances remain in `u` with `mmPerUnit: null` until independent confirmation. Once verified, record the conversion and its provenance. Convert clinical/material thresholds into file units explicitly; never infer conversion from typical tooth size. Camera up-axis controls change only viewing.

## Establishing a candidate site

Look at both arches separately from occlusal, facial/lingual, and oblique views, then together in the captured bite. Anchor a hypothetical site to a source triangle where possible and retain the local point, face index, and provenance. Establish a local coordinate frame from the candidate space and neighboring surfaces; record how its axes were chosen. A surface normal alone is not an implant axis.

The host's FDI chart is clinician-entered. The case experiment may maintain its own unconfirmed anatomical hypothesis, with supporting views, without rewriting that chart. Tooth identity and geometry location can be separately uncertain. If more than one gap is plausible, render labeled alternatives and select one explicitly as the demonstration hypothesis. A geometry prototype may proceed with null FDI.

Measure mesiodistal space as a stated surface-to-surface operation inside a target region, not centroid-to-centroid or generic marker distance. Measure crown height relative to an identified cervical reference and antagonist envelope along the stated local occlusal direction. Record whether the result is ray-based, closest-surface, or sampled. Width/depth/height parameters of a generated crown are design values, not measurements of available bone.

## Construction options

Prefer a reviewed donor/template when it represents the requested anatomy. Document donor segmentation, anatomical suitability, reflection/rotation, and deformations. Keep occlusal detail while adjusting the contact regions and cervical envelope. Mirroring does not establish actual contralateral symmetry.

Save the donor's original face indices with the source geometry hash, selection/cut definition, and full donor-to-target transformation. Keep source file poses rigid and separate from donor reflection/scaling/deformation. A reflection reverses orientation: correct triangle winding and recompute normals. An affine scale can distort cusp relationships; record each axis scale and inspect its effect. Never silently weld a cropped donor to gingiva or claim that a geometric cut is a reviewed clinical margin. An open exterior patch is acceptable for a visual concept if its cut/boundary and omitted surfaces are explicit; it supplies no solid interior or intaglio.

Without a suitable donor, the included parameterized surface can produce a procedural exterior hypothesis. Specify cusp centers, heights, footprint, groove depth, and cervical taper. The kit provides topology and coordinate invariants; it does not encode a validated dental morphology model. Inspect whether the shape still reads as the intended tooth after fitting.

Never derive a natural-tooth root, intrabony screw, implant connection, intaglio, screw channel, or manufacturing minimum thickness from this exterior generator. Represent unavailable components as unknown in the report rather than plausible-looking hardware.

## Geometric audit

Separate three target categories: adjacent tooth contact regions, opposing arch, and source-arch/cervical surroundings. With no reviewed segmentation, a whole-arch relationship is only a whole-arch result. Do not attribute all near corners to a named neighbor. References named bite are excluded from collision targets.

Use full triangle-intersection checks for crossings/touching where feasible and record the numerical tolerance. Compare crown points to full-resolution triangle surfaces via a BVH; include area-weighted/adaptive samples near suspected contact rather than only coarse vertices. Record all samples, subdivision/coverage parameters, and whether an error bound exists. Calling sampling “dense” does not establish an error bound. If sampling is used in only one direction, state that; test reverse relationships when needed.

Open targets support distance and crossing queries, with no trustworthy solid sign. Local normal-oriented distances can be useful if orientation is reviewed, but remain distinct from global signed distance. A positive sample gap does not rule out a missed closer patch. If a contact area is approximated by integration of thresholded face area, record the threshold, tessellation dependence, and approximation; do not call it exact contact area.

Validate finite vertices, indices, winding, edge incidence, degeneracy, component count, and export/reimport consistency. Check self-intersection separately or mark it untested. A manifold mesh can still cross itself. Generic basal closure must be identified in the report and view; do not silently omit collisions with that closure.

For a static scenario, report only the captured pose. Patient-specific excursions require independent motion data and an anatomical kinematic model. A sweep around each mesh center is a geometric stress scenario, not a jaw simulation. Neither gap maps nor intersections give occlusal force, pressure, osseointegration, or soft-tissue compression.

## Iteration and evidence

Use explicit objective regions and clinician-configured contact/clearance targets. Until clinical targets and scale are supplied, optimize an illustrative envelope and label any numerical target a prototype parameter. Separate intended contact from prohibited penetration. Preserve a reasonable tooth morphology instead of satisfying every distance by shrinking indiscriminately.

Bound runtime and iterations. Snapshot source hashes, matrices, site state, annotation revision, and parameters at dispatch. Terminate expensive stale work; compare every dependency again before applying a result. Keep the best candidate and failed constraints. Save the spec, mesh, audit, and reproducible commands together, plus occlusal and oblique views and close-ups of both neighboring relationships and the antagonist. If the experiment cannot resolve bite/site/fit uncertainty, deliver the actual concept with that limitation instead of declaring a fit pass.

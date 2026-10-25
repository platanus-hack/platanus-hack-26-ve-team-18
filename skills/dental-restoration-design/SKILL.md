---
name: dental-restoration-design
description: Create and audit editable dental planning concepts from intraoral upper, lower, and bite meshes, including separate generic fixture, abutment/pilar, and crown parts. Use for geometric defaults, tooth form, space, contacts, bite, and emergence; distinguish visualization from surgical placement and compatible implant hardware.
---

# Dental restoration design

Use explicit anatomy hypotheses and bounded parameter edits; use local geometry tools to construct and measure the result. Deliver editable planning geometry with its evidence and unresolved requirements. General dental knowledge and automatic geometric defaults supply priors, not patient-specific anatomy or clinical approval.

## Establish the deliverable

Distinguish three independent editable parts: **fixture**, **abutment/pilar**, and **crown**. For a local planning concept, generate a smooth generic tapered fixture, an abutment envelope, and a crown hypothesis as separate meshes. Do not invent threads, an implant connection, screw access, or compatible hardware. A crown-only exterior remains a separate supported deliverable.

An IOS-only request can proceed with automatic geometric defaults and optional manual tuning. Label them **hypothesized**; fixture radius/length/depth and abutment proportions are visualization controls. IOS cannot establish bone-safe placement depth, surgical trajectory, manufacturer compatibility, or clinical fit. Keep those assessments unknown even when all three meshes exist.

Read [component parameters](references/component-parameters.md) for the three-part contract, frame, defaults, and clinical meaning of controls; [clinical considerations](references/clinical-considerations.md) for depth, diameter, tissue, restoration, or bite decisions. Read [geometry workflow](references/geometry-workflow.md) before handling meshes, and [AI SDK integration](references/ai-sdk-integration.md) when running in an application. The executable routes are described in [concept kit](references/concept-kit.md). The assembly route supplements the crown-only and donor routes; their contracts remain separate.

## Work from one case record

- Inventory source bytes, SHA-256 hashes, roles, triangle counts, boundaries, coordinates, and current rigid poses. Keep references to large arrays local; return bounded evidence to the LLM.
- Preserve the common frame. A camera convention does not rotate anatomy. Confirm physical scale independently; until then use **file units (`u`)** everywhere. A PLY extension or plausible arch width does not establish millimeters.
- Classify every design input as **measured**, **clinician-entered**, **hypothesized**, or **unknown**. Associate measurements with their source, method, pose, and sampling. No confidence score upgrades a hypothesis to a diagnosis.
- Review upper/lower roles and both bite references. Their filenames suggest roles only. Two bite files may capture different sides of the same static bite, not jaw motion. A poor or conflicting fit is unresolved evidence, not permission to push arches together.
- Identify the visible candidate gap and surrounding surfaces in occlusal and oblique views. An unscanned area, unlabeled triangles, or a long interdental gap does not prove a missing tooth. Record unconfirmed tooth identity as null or an explicit hypothesis; do not guess patient left/right from screen left/right.

## Define before generating

Record the target region, local mesiodistal/buccolingual/occlusal frame, tooth type, neighboring surfaces, antagonist region, and intended contact regions. The assembly frame is `{ origin, u, v, up }`, right-handed and orthonormal (`u × v = up`). Fixture depth is referenced to `origin` opposite `up`; the abutment extends toward `up`, with the crown above it. Preserve that source frame and its pose when editing or exporting; camera orientation is independent. Use positive dimensions and label lengths **file units (`u`)**, never assumed millimeters. Choose morphological proportions from a reviewed tooth reference, suitable donor, or explicit procedural hypothesis. Avoid treating a mirrored donor as exact missing anatomy.

Before choosing the tooth class and cusp pattern, inspect the whole-arch sequence and corresponding contralateral region. Record the anatomical basis separately from available gap width. A broad gap is not evidence for a molar. If class remains uncertain, retain alternatives; do not let a four-cusp procedural example become the automatic posterior-tooth prior. Verify that the exported surface actually has the intended cusp peaks, ridges, and fossae: a list of cusp influences does not prove those features survive the height field and fitting.

For an IOS-only **visual concept**, proceed with explicit geometric assumptions when the gap can be located. Unknown bone anatomy does not prevent a three-part planning experiment. Keep a site hypothesis separate from the clinician's saved chart. A margin on a prepared natural tooth, a mucosal outline, and an implant platform are different boundaries.

For a restoration on an **existing implant**, require reviewed scanbody registration plus the exact implant/abutment/library identity before representing its connection. To assess a **planned fixture clinically**, require clinician-reviewed cross-sectional imaging, segmentation, registration, calibrated units, anatomical exclusion regions, restorative objectives, and the selected implant system. These requirements govern clinical assessment, not creation of a labeled generic placeholder. Depth has a reference surface; never offer a universal “place it X mm deep” rule.

## Construct and refine

1. Write a structured design specification and assumptions before making geometry. Include source hashes, poses, unit status, site provenance, parameters, and desired artifact status.
2. For an assembly, run the local worker executor or assembly CLI and retain separate fixture, abutment, and crown artifacts plus the spec. Start from recorded geometric defaults, then optionally tune each component. Crown hypotheses support **incisor, canine, premolar, and molar** classes. For crown-only work, use the existing exterior kit or an explicitly identified donor/template. Treat a procedural oval as a **space envelope** until its anatomical features are demonstrated. If it lacks the intended anatomy, use a suitable donor/template or improve those features before presenting it as a tooth. Preserve morphology and edit a small parameter set; an LLM should not emit thousands of vertex coordinates.
3. Evaluate the candidate against the complete relevant source surfaces in the reviewed pose. Separate adjacent contacts, antagonist relationships, and basal/tissue relationships. Bite reference surfaces are registration evidence, not collision targets.
4. Inspect the complete crown and close views of both neighboring contacts, antagonist cusps, and cervical contour. Refine within a bounded iteration budget. Keep before/after parameters and measurements; retain the best valid candidate instead of the last one.
5. Recompute evidence after every geometry, site, annotation, or pose change. Cancel stale work. If fitting objectives conflict, preserve the conflict and alternatives rather than shrinking until the shape becomes an isolated pebble.

## Turn dentist feedback into an evidence-bound edit

Read the current component inventory and evaluation before proposing a change. For each complaint, identify **fixture, abutment/pilar, or crown**, the observed error, actual measurement or visible finding, intended target, missing evidence and smallest supported edit. Do not answer “fixed” from a tool request: wait for the local worker's actual result and fresh evaluation, compare before/after, and retain unresolved issues. Unknown anatomy or clinical evidence cannot become a pass because a mesh exists or the score improved.

- **Missing anatomy:** review tooth identity and the actual emitted cusps/incisal form, ridges, fossae and cervical taper. A donor label or template class is not proof of patient morphology. Supported edits include tooth class, relief/orientation and occlusal contour; inspect what survives regeneration.
- **Wrong dimensions/proportions:** use emitted component bounds in the stated site frame, separately from nominal controls. Review neighbours, available space and antagonist evidence before choosing a bounded dimension edit. Millimetres require independently verified scale.
- **Poor surface/cervical contour:** distinguish malformed geometry, display shading and the crown–abutment–mucosal transition. Review cervical contour and abutment radius/emergence/height controls. Report finite/degenerate/closure checks separately from untested self-intersection, local folds, tissue response, physical finish and manufacturing integrity.
- **Wrong colour:** a supported appearance edit changes illustrative display colour/roughness. It does not measure shade or select a clinical ceramic/material. Keep shade matching unknown without separately reviewed evidence.
- **Placement feedback:** the dentist wording was confirmed as **1.5 mm subcrestal** and **at least 1.5 mm from adjacent teeth**. Record both only as clinician-entered feedback for the explicitly selected case/assembly. Confirmed wording does not verify applicability, datums or measurements. Older ambiguous feedback stays unconfirmed until its wording is clarified. Never turn either value into a universal constant or automatic offset. Define the fixture/platform, bone-crest datum, neighboring tooth/root surfaces, method and calibrated registration before any clinical comparison. Gingiva is not bone crest; crown proximity is not root clearance.

The independent dentist guardrails supplement the ten engineering fitting checks. They can name controls worth reviewing, but unknown clinical evidence generates no executable numeric revision. See [clinical considerations](references/clinical-considerations.md) for evidence and [application integration](references/ai-sdk-integration.md) for the revision-bound edit loop.

## Audit with honest measures

- Triangle-corner distances to triangle surfaces are sampled measurements. Their minimum may exceed the true surface minimum. Shared corners can be repeated; their counts are not contact area.
- Triangle intersections include touching and coplanar contact. Distinguish intended contact from unwanted penetration; coloring an entire triangle does not measure a contact patch.
- Open intraoral scans have no reliable solid interior. Do not infer signed bone/tissue volume by capping them. Watertightness alone does not rule out self-intersection.
- Report the actual tests: full-resolution or sampled targets, sample counts, sampling coverage, normals, crossing flags, and limits. A missing pair or zero sampled interference does not prove clinical clearance, acceptable bite, force, or pressure.
- A static bite cannot validate lateral/protrusive motion. Synthetic motions are scenarios with explicit assumptions, never patient-specific kinematics.
- A closed basal cap in a concept mesh is an artificial closure, not an intaglio, emergence fit, abutment seat, or evidence of material thickness.

## Deliver and independently check

Deliver the specification, separate importable component concepts (or the requested crown-only concept), measurements, source/pose provenance, and multi-view evidence. Label the assembly **planning concept—clinical fit unvalidated**. Preserve component identities and independent visibility/export; joining them visually does not create a compatible interface. Keep fixture placement, connection, tissue response, and manufacturing checks explicitly unassessed when unsupported. Clinical and fabrication release requires the relevant professional review and manufacturer requirements; an audit pass applies only to the checks actually run.

Ask an independent agent to execute the skill on raw inputs in a separate output directory. Give it the request and this skill, without a proposed site, dimensions, or desired conclusion. Review its geometry and evidence yourself. Improve rules only for observed failures; preserve the failing case as a local regression artifact without bundling patient meshes into the skill.

## Application capability boundary

The Platanus **chat** receives bounded case evidence. Check the live capability catalog: when restoration editing is explicitly enabled, it may read the current restoration inventory and propose a validated component parameter, anatomy/contour or appearance edit. The host executes that proposal in the local worker, enforces revision and iteration/time caps, cancels stale jobs, and returns fresh geometry/evaluation. Disabled or absent editing tools remain unavailable; a skill document or queued proposal does not enable them.

Raw mesh access, CLI execution, arbitrary movement of original meshes and clinical certification remain unavailable to chat. Claim an edit or generation only after the executor returns actual artifacts for the current revision. Keep source meshes local and bind results/exports to source poses and revisions as described in the integration reference. Deterministic local construction/evaluation needs no patient provider call; enabling an assistant is a separate explicit data-sharing flow.

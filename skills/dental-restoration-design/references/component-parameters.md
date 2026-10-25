# Editable restoration component parameters

Engineering contract: [`src/restoration-types.ts`](../../../src/restoration-types.ts) and the pure [`generateRestoration`](../../../src/restoration-geometry.ts) implementation. This is **planning-concept geometry**, not an implant library or surgical prescription. The fixture, abutment/pilar, and crown remain independent editable meshes.

## Specification and source frame

`RestorationSpec` uses `version: "implant-assembly/v1"`, a permanent-tooth `fdi`, nonempty `parentPartId` and `source`, `anatomy: "incisor" | "canine" | "premolar" | "molar"`, `provenance: "hypothesized" | "clinician-entered"`, and the exact unit label `units: "file units (u)"`. FDI is caller selected; validation of its format does not confirm a missing tooth. Keep finer measured/unknown provenance in the case record rather than adding unsupported spec fields.

`frame: { origin, u, v, up }` contains three-number vectors. The axes must be unit length, mutually orthogonal, and right-handed (`u × v = up`) within `1e-8`; the generator rejects an invalid frame rather than normalizing it. For local coordinates `[x,y,z]`, the source point is `origin + x*u + y*v + z*up`. The vector named `u` is an axis; **file units (`u`)** are the length label. Neither establishes millimeters or a global anatomical up direction.

The frame lives in the original source coordinates. Apply the source part's current rigid pose once for workspace display/audit/export; never bake that pose twice or silently recenter an exported part. The spec alone is not a complete source-hash/pose record: retain that context in the executor's case record and CLI manifest as applicable.

## Independent controls

All lengths below are file units. Angular controls are **degrees**; `taper` is dimensionless. These parameters describe constructed surfaces, not measured clinical structures.

| Component | Exact `parameters` fields | Geometric meaning and limits of interpretation |
| --- | --- | --- |
| `fixture` | `radius`, `length`, `depth`, `taper` | Smooth capped tapered envelope without threads or connection. Coronal face: `origin - depth*up`; apical face: `origin - (depth + length)*up`. Coronal radius is `radius`; apical radius is `radius*(1-taper)`. `depth` is a nonnegative displacement from the chosen origin, **not depth from a measured bone crest**. |
| `abutment` | `radius`, `height`, `emergenceRadius`, `angleX`, `angleY` | Starts at the fixture platform at `-depth*up`, spans to `emergenceRadius` at the site origin, then lofts to `radius` at height `height` along `up`. Top center in local coordinates is `[height*tan(angleY), -height*tan(angleX), height]`. Height locates the crown base above the site, independently of platform depth. Angles control centerline slopes of horizontal sections, not a rigid rotation or screw-channel direction. The envelope does not measure gingival height, establish tissue fit, or encode a compatible platform. |
| `crown` | `width`, `depth`, `height`, `cuspHeight`, `rotation` | Width/depth control the unrotated footprint along local `u`/`v`; rotation is about `up`. The artificial basal cap starts at the abutment top. `height` controls body height; `cuspHeight` adds anatomy-dependent relief and does **not** specify an exact apex or total bounding height. Incisor, canine, premolar, and molar select different procedural relief hypotheses, not validated reconstructions. |

The generator requires positive radii, lengths, abutment height, crown width/depth/height; fixture depth and cusp height may be zero. It accepts taper `0–0.95`, abutment angles `-80–80°` each, and crown rotation `-360–360°`. These are **software construction limits**, never clinical or manufacturer recommendations. Float32 coordinate collapse, invalid winding, or failed closure is an error; no source-coordinate correction is silently applied. Read the current generator if changing validation.

The executor also rejects dimension ratios above `10,000` and source-coordinate rounding larger than `2%` of the smallest local mesh edge. These numerical guards prevent known partial Float32 folding failures; they are not anatomical limits or a general self-intersection certification. Geometry is never silently moved to a different origin to pass them.

The abutment starts at the fixture platform, including when fixture depth is nonzero. Its generic envelope bridges that depth to the site plane and continues to the crown base; angle changes preserve these shared reference planes. This is a simplified contiguous concept interface, not a precision implant connection. Three closed meshes do not demonstrate seating, wall thickness, mating tolerances, manufacturability, or general freedom from self-intersection.

## Defaults and manual tuning

Procedural templates already contain cusp anatomy. Initial added `cuspHeight` is zero; extra relief is an explicit edit. Surface-based site initialization budgets the actual emitted peak plus abutment against the neighboring-height hypothesis and available sampled antagonist headroom. Provisional bite measurements remain provisional. A 98% initial axial gap occupancy and a one-part-per-million rounding reserve are engineering initialization values, not clinical acceptance thresholds.

Manual dimension edits regenerate and measure exactly those values, with one candidate. “Retry fitting as a comparison” explicitly starts bounded optimization. The automatic fitter can approach an observed opposing patch using forward rays along the restorative axis; it cannot assess clinical occlusion or select a bone-safe implant position. Missed rays remain unknown. Fixture depth remains fixed during crown fitting.

Automatic geometric defaults provide an editable starting hypothesis from the selected site/class and available geometry. Record the actual values and their basis: source dimensions, a geometric fallback, and clinical measurements are different evidence. A default generated from arch bounds must not be described as a measured neighboring contact or bone dimension. Users may tune each component without changing its identity; recompute views and collision evidence after edits.

Keep automatic values `hypothesized`. A clinician-entered value records who supplied it, not an automatic clinical approval. Neither tuning nor zero sampled collisions establishes safe bone depth, soft-tissue response, compatible hardware, or acceptable occlusion. Keep crown height, abutment height, and fixture depth separate. Use actual exported dimensions for geometric reporting instead of treating parameter names as exact bounds.

## Clinical distinctions and primary sources

Sources accessed **2026-10-24**. Full register: [sources.md](sources.md).

- [AAOMS: Components of a dental implant restoration](https://myoms.org/what-we-do/dental-implant-surgery/what-are-the-components-of-a-dental-implant-restoration/) (**updated September 2026**, day unspecified; patient education) distinguishes the intrabony implant, intermediate abutment, and visible prosthesis. Here `fixture` is the app's name for a generic implant-body envelope; AAOMS supplies component relationships, not CAD defaults. [S25]
- [FDA: Dental implants—what you should know](https://www.fda.gov/medical-devices/dental-devices/dental-implants-what-you-should-know) (**publication/update date unstated**; regulator guidance) distinguishes implant body, abutment, and possible fixation screw, and advises retaining brand/model information. Our envelopes represent none of those verified product identities. [S1]
- [MEDENTiKA digital dentistry guide](https://www.straumann.com/content/dam/media-center/medentika/en-us/documents/brochure/UserGuide_708957_A00_US.pdf#page=11) (**IFU_708957_A00_US, revision A00; publication/revision date unstated**; manufacturer instructions), printed pp. 11–14, distinguishes stock gingival height, margin diameter/height, total design height, cementable post height, wall thickness, and design angulation. Their datums and constraints depend on the platform, blank, material, and compatible CAD library. Screw-channel angulation is a separate, connection-specific parameter. The generic `emergenceRadius`, `height`, and slope controls do not implement these checks. Do not transfer its numerical limits into universal defaults. [S26]
- [ADA: Dental X-ray patient-selection recommendations announcement](https://www.ada.org/about/press-releases/new-recommendations-confirm-dental-x-rays-most-effectively-used-in-moderation) (**published 2026-01-05**; professional guidance summary) calls for imaging only when clinically justified after history and examination, including implant-planning scenarios. A local IOS concept neither orders imaging nor supplies the missing bone assessment. See [clinical considerations](clinical-considerations.md) before discussing clinical placement. [S27]

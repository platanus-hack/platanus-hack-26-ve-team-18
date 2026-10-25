# Implant-restoration design considerations

Research checked **2026-10-24**. Source IDs link to [sources.md](sources.md), which records publication dates and evidence types. This is a structured planning reference; it is not a patient-specific prescription. Distinguish consensus, observational association, clinical trial, laboratory finding, manufacturer requirements, and engineering inference.

## Begin with the restoration and patient

An implant system comprises the intrabony implant body, connecting abutment/components, and supported crown. The app calls its generic implant-body envelope a **fixture**, and the abutment a **pilar** where appropriate. Establish whether the task concerns a planning concept, a planned clinical implant, an existing implant, a healing component, a provisional crown, or a definitive restoration. [S1, S25]

Start with the intended tooth position and form, appearance, available restorative space, access for cleaning, and retention/access feasibility; reconcile that plan with the available anatomy. Medical/dental history, periodontal status, smoking, parafunction, healing/loading conditions, and patient priorities belong in clinician review, not inference from surface appearance. [S2, S6, S8, S12]

## Editable geometric concepts

IOS-only work may create three independent planning parts: a generic tapered fixture, abutment/pilar envelope, and incisor/canine/premolar/molar crown hypothesis. Automatic dimensions and optional manual tuning are geometric hypotheses. User-authorized generic illustrative fixture threads/flutes supply no engineered thread form or manufacturer identity; the abutment has no verified platform, screw channel, or tissue fit. Actual local mesh artifacts are useful for visualization even while clinical placement and compatibility remain unassessed. Read [component parameters](component-parameters.md) for the exact source-frame and parameter meanings.

In that contract, fixture `depth` is an offset from the chosen `origin` opposite `up`; `abutment.height` locates the crown-body/seating datum. The nested-support envelope extends a tapered retention post into the crown without raising that datum. Its measured support/enclosure is an engineering check distinct from unknown clinical gum emergence, retention strength and material thickness. Exploded reference-view spacing is not installed clearance. These are not bone-crest measurements. IOS does not reveal the bone boundaries needed to assess bone-safe depth, and a visual match does not establish manufacturer compatibility. Keep these unknowns visible without blocking a labeled concept experiment. [S1, S25; engineering consequence]

Manufacturer guidance distinguishes gingival/margin height, total height, post height, wall thickness, and angulation with component-specific datums and libraries. Generic radius/height/emergence controls cannot substitute for those requirements; no manufacturer-specific number becomes a universal generator default. [S26]

## What changes the design

| Consideration | Evidence needed and implication for an agent |
| --- | --- |
| Fixture depth | Define **which reference**: implant shoulder/platform relative to bone crest, planned mucosal margin, or restorative landmark. Record the implant system and bone-level versus tissue-level design. Soft-tissue conditions, emergence space, planned restoration, and anatomy affect the decision. A gum surface cannot establish bone crest or a universal depth. [S2, S9, S20] |
| Fixture diameter and length | Require reviewed bone dimensions, neighboring roots/implants, relevant anatomy, restorative demands, loading strategy, and selected-system indications. Crown width alone cannot choose a fixture. Narrow/short alternatives have indication-specific benefits and mechanical tradeoffs; longer/wider is not automatically better. [S7, S8] |
| Three-dimensional position and angle | Relate mesiodistal, faciolingual, and apicocoronal position to the restoration and anatomical constraints. For guided planning, register surface/prosthetic and volumetric data, and include acquisition, registration, and transfer uncertainty. A computed distance does not guarantee surgical clearance. [S2, S6] |
| Crown size and morphology | Determine tooth identity, neighboring contours, arch alignment, available space, opposing anatomy, aesthetics, and restoration stage. Use those as inputs to an editable shape hypothesis. Fitting an arbitrary ovoid into a gap does not establish tooth anatomy. This is an engineering interpretation of restoration-driven planning. [S2] |
| Proximal contacts | Evaluate adjacent contacts separately from opposing contacts, including contact location, embrasures, food-trap risk, and cleaning access. Contact relationships can change over time. Scan distance does not establish clinical tightness or future contact stability. [S13] |
| Static bite and excursions | Record the jaw position and loading/restoration protocol. Review opposing contacts and cusp relationships, then separately evaluate excursions if actual motion data exist. A static mesh supplies no muscle force, contact timing, or overload diagnosis. [S12, S14–S16] |
| Emergence and soft tissue | Evaluate the transition from platform/abutment to crown, facial contour, tissue support, embrasures, and access for circumferential hygiene and examination. Avoid obstructive overcontouring. Neither tissue thickness nor compression response is established by an external surface alone. [S9–S11] |
| Retention, components, and material | Require exact platform/connection, scanbody level and identity, compatible library/version, abutment or Ti-base, screw access, retention strategy, and selected material/process. Apply current manufacturer requirements for wall thickness, connection, processing, and compatible parts; do not invent a universal thickness or torque. [S20–S22] |

## Imaging, anatomical exclusions, and depth

The 2026 ADA/AAOMR recommendations support CBCT in presurgical implant assessment after clinical evaluation and imaging justification. The ADA announcement emphasizes ordering imaging only when clinically necessary after reviewing history, prior images, and examination findings. These are clinical recommendations, not a guarantee that imaging alone establishes a plan or a reason for the concept generator to request imaging automatically. A clinician must interpret the relevant volume and its limitations. [S3, S27]

Assess structures relevant to the actual site: neighboring roots/implants; inferior alveolar canal, mental region and lingual concavities/vascular anatomy in the mandible; sinus/nasal boundaries and nasopalatine region in the maxilla; and local pathology. Their surfaces are not present in an ordinary upper/lower/bite optical mesh. [S4]

For a clinical depth proposal, the case record must identify the chosen fixture/platform and axis, bone and soft-tissue references, calibrated coordinates, intended restoration/emergence, and clinician-selected constraints. Unknown platform or bone crest means **clinical depth unassessed**, even if a geometric `depth` value is editable. “Crown height,” “transmucosal running room,” and “depth in bone” must be separate fields. This data requirement is an engineering synthesis, not a new treatment rule. [S2, S9, S20]

The 2018 ITI guided-surgery consensus describes nonzero transfer error and a safety allowance in that workflow. Such guidance must retain its scope; it cannot be turned into a guaranteed clearance calculated from a PLY. [S6]

## Numeric evidence is contextual

- The 2023 ITI consensus recommends a facial/buccal bone wall **greater than 1.5 mm at placement in healed sites**. This requires bone evidence and does not prescribe fixture depth or an automatic augmentation operation. [S9]
- A cross-sectional study associated emergence angles **over 30°**, particularly with convex profiles, with peri-implantitis in its **bone-level** subgroup. This was an association and study division, not a universal causal threshold. A later aesthetic-zone trial studied recession with different profiles; it answered a different question. [S11]
- Immediate provisional crown recommendations in ITI's **Type 1A aesthetic-zone** protocol include avoiding eccentric contacts. Do not extend a provisional protocol to every definitive crown or translate it into one default geometric gap. [S12]

Do not ship these figures as automatic limits in a generator. A clinical rule needs its source, population, implant/restoration system, measurement definition, units, and clinician applicability decision.

## Tooth anatomy is a separate prior

For an upper-premolar hypothesis, use buccal and palatal/lingual cusp anatomy as the starting reference; three-dimensional studies show meaningful first/second-premolar differences in relative cusp form and position. Do not substitute a generic four-cusp molar simply because it fills the gap. [S23] Lower second premolars also exhibit different cusp patterns, so a single “posterior tooth” recipe is inadequate. [S24]

Compare the sequence of visible teeth and a suitable contralateral region before choosing a model. Keep patient side/FDI unconfirmed if orientation or chart evidence is insufficient. Inspect actual cusp peaks, marginal ridges, fossae, groove continuity, cervical taper, and neighboring proportions in the exported surface. These are morphology checks, independent of collision results. The present procedural kit is a shape experiment; a smooth ovoid with a cross indentation is an envelope until its intended tooth anatomy is demonstrated. This quality criterion is an engineering consequence of the anatomical differences, not a clinical acceptance rule.

## Dentist feedback: actionable evidence without invented acceptance

Record each complaint against the named component, current emitted geometry or appearance, target, missing evidence and supported edit. Use the [numeric evaluation contract](geometry-workflow.md#numeric-evaluation-contract): actual, target/comparator, signed error, units, datum, actual/target provenance, method, evidence and revision. Unknown actuals/errors stay null. Distinguish nominal `width/depth/height` controls from actual post-deformation bounds; fitting and rotation can change those bounds. A geometrically satisfactory prototype ratio does not supply a patient-specific dimension target. This is an engineering reporting rule, not a clinical size recommendation.

Keep four conclusions independent: **display/cosmetic** (illustrative color and roughness), **geometric** (dimensions, mesh integrity and measured relationships), **anatomical** (reviewed tooth identity, actual cusp/ridge/fossa and cervical form), and **clinical** (placement, tissue response, shade/material and functional appropriateness). Smoother shading does not repair malformed geometry; a tooth-class label does not verify morphology; a collision pass does not approve a restoration. Manual input records who entered a value, not clinical validation of its meaning.

The current host screens agent candidates before commit using measured engineering evidence. A rejected candidate leaves the current geometry/history intact and returns its actual rows and failure reasons for a bounded revised attempt. Manual edits can still apply with failures visible. Read `quality.feedbackRows`, `quality.failureFeedback` and the current revision after either outcome; keep rejected-candidate measurements separate. Passing this admission gate does not resolve unknown clinical datums, verify anatomy or change the two case targets below. See the [edit loop](geometry-workflow.md#manual-and-agent-edit-loop) for the eight-request cap and per-target comparison requirements.

For poor cervical contour, inspect the crown–abutment transition, local wall shape and reviewed mucosal boundary. Generic abutment slopes are not measured clinical emergence angles. The contour association in S11a does not justify an automatic 30° acceptance limit. Finite/degenerate-face checks, declared closure and smooth display normals are distinct from self-intersection freedom, physical surface finish and tissue compatibility. Numerical mesh quality must never certify the latter.

Treat wrong colour as an appearance complaint until a clinical shade target and suitable measurement/viewing evidence are recorded. A clinical comparison of 120 anterior teeth in 20 participants found scanner shade readings did not exactly match a spectrophotometer, recommending additional methods; its findings concern those devices and workflow. Geometry alone has still less shade evidence. **Engineering consequence:** permit illustrative display edits but keep clinical shade matching unassessed. [S28]

For this case the user explicitly confirmed two **minimum** targets: **implant PLATFORM at least 1.5 mm below the REVIEWED BONE CREST**, and **implant OUTER SURFACE at least 1.5 mm from EACH adjacent ROOT**. Treat them as clinician-entered case feedback for the selected assembly; do not re-ask the confirmed wording or apply it to every case. Preserve older ambiguous records as history. Confirmation supplies the target and intended anatomical entities, not actual landmarks, calibration, a measurement method, applicability to a selected implant system, or clinical approval. The legacy `adjacentToothClearanceMm` field name does not broaden this case target to crown surfaces.

The sources illustrate why the datums and scope matter:

- **S31, manufacturer instructions:** Straumann's June 2026 technical guide, §3.1.1 (printed p. 13), measures its 1.5 mm mesial/distal recommendation from the **implant shoulder to the neighboring tooth at bone level**. §3.1.3 (printed p. 18) distinguishes implant designs and bone/gingival references, including a scalloped crest. That shoulder-level rule is not evidence that a software measurement of the entire exterior to every root has been performed, and it does not establish this case's subcrestal target. [Straumann guide](https://www.straumann.com/content/dam/media-center/straumann/en/documents/brochure/technical-information/702084-en_low.pdf#page=15)
- **S29, original randomized trial:** the tested 1.5 mm subcrestal protocol used 40 submerged bone-level platform-switched implants in 32 patients with thin vertical tissues. Its abstract distinguishes crest-to-neck remodeling from neck-to-first-radiographic-bone-contact loss. This is evidence about that protocol, not a universal minimum placement depth. [Linkevicius et al., abstract—Materials and methods](https://onlinelibrary.wiley.com/doi/10.1111/cid.12903)
- **S30, original retrospective study:** root invasion, surface contact and under-1-mm root proximity were separate study groups. These definitions concern roots and implant surfaces; the study did not test a universal 1.5 mm acceptance threshold. [Yi et al., p. 1 abstract](https://www.nature.com/articles/s41598-021-87062-9.pdf)

Use the [case placement datums](geometry-workflow.md#case-placement-datums) to define a signed platform-to-reviewed-crest measurement and separate outer-surface clearance for every relevant root. Do not replace either with construction `fixture.depth`, an implant-center distance, gingival proximity, crown contacts or an average of two sides. Unitless meshes remain in file units; a mm target cannot convert them implicitly.

Return **unknown**, with null actual clinical distances/errors, while the necessary reviewed anatomy, platform identity, scale, registration, coverage or measurement capability is absent. The current evaluator deliberately leaves these clinical actuals null; adding a volume or confirming feedback alone does not implement them. Keep separately entered measurements labeled manual/unverified by the app. Unknown placement does not block authorized cosmetic or geometric concept edits, but it cannot justify an automatic fixture relocation. These are requirements for meaningful software assessment, not instructions to order imaging or prescribe treatment.

## IOS, bite, and scanner-specific limits

Core PLY has vertices, faces, and optional properties; it has no mandatory clinical unit, dental role, or scene transform. Export workflows may preserve occlusion or independently orient arches. Confirm provenance rather than inferring alignment from file names. [S17, S18]

Buccal bite records can relate arches in a recorded intercuspation pose. Published repeatability for a particular scanner/workflow is not proof of the accuracy of these files. Multiple captured positions also differ from continuous patient motion. [S15, S16]

Engineering consequence: inspect both references, preserve original poses, state any registration, and report sampled surface proximity in the actual evaluated pose. Triangle crossings can reflect scan/registration errors as well as geometry interference. They cannot establish contact pressure, tissue response, exact contact area, or safe loading.

## Release states

For IOS-only generation, deliver a **planning concept—clinical fit unvalidated**, with three separate component artifacts when requested; crown-only exterior generation remains available. Keep fixture placement, hidden connection, tissue fit, dynamic bite, material thickness, and fabrication unassessed where evidence is absent. Generating a fixture envelope does not validate its clinical placement. For restoration of an existing implant, reviewed scanbody/library registration provides component pose; it does not automatically validate every restorative constraint. Surgical and laboratory decisions remain separate review stages. [S20–S22, S26]

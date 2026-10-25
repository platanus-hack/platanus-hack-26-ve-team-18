# Implant-restoration design considerations

Research checked **2026-10-24**. Source IDs link to [sources.md](sources.md), which records publication dates and evidence types. This is a structured planning reference; it is not a patient-specific prescription. Distinguish consensus, observational association, clinical trial, laboratory finding, manufacturer requirements, and engineering inference.

## Begin with the restoration and patient

An implant system comprises the intrabony implant body, connecting abutment/components, and supported crown. The app calls its generic implant-body envelope a **fixture**, and the abutment a **pilar** where appropriate. Establish whether the task concerns a planning concept, a planned clinical implant, an existing implant, a healing component, a provisional crown, or a definitive restoration. [S1, S25]

Start with the intended tooth position and form, appearance, available restorative space, access for cleaning, and retention/access feasibility; reconcile that plan with the available anatomy. Medical/dental history, periodontal status, smoking, parafunction, healing/loading conditions, and patient priorities belong in clinician review, not inference from surface appearance. [S2, S6, S8, S12]

## Editable geometric concepts

IOS-only work may create three independent planning parts: a generic tapered fixture, abutment/pilar envelope, and incisor/canine/premolar/molar crown hypothesis. Automatic dimensions and optional manual tuning are geometric hypotheses. The fixture has no invented threads or implant interface; the abutment has no verified platform, screw channel, or tissue fit. Actual local mesh artifacts are useful for visualization even while clinical placement and compatibility remain unassessed. Read [component parameters](component-parameters.md) for the exact source-frame and parameter meanings.

In that contract, fixture `depth` is an offset from the chosen `origin` opposite `up`; abutment `height` rises from the origin, and the crown starts above it. This is not a bone-crest measurement. IOS does not reveal the bone boundaries needed to assess bone-safe depth, and a visual match does not establish manufacturer compatibility. Keep these unknowns visible without blocking a labeled concept experiment. [S1, S25; engineering consequence]

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

Record each complaint against the named component, current emitted geometry or appearance, target, missing evidence and supported edit. Distinguish nominal `width/depth/height` controls from actual post-deformation bounds; fitting and rotation can change those bounds. A geometrically satisfactory prototype ratio does not supply a patient-specific dimension target. This is an engineering reporting rule, not a clinical size recommendation.

For poor cervical contour, inspect the crown–abutment transition, local wall shape and reviewed mucosal boundary. Generic abutment slopes are not measured clinical emergence angles. The contour association in S11a does not justify an automatic 30° acceptance limit. Finite/degenerate-face checks, declared closure and smooth display normals are distinct from self-intersection freedom, physical surface finish and tissue compatibility. Numerical mesh quality must never certify the latter.

Treat wrong colour as an appearance complaint until a clinical shade target and suitable measurement/viewing evidence are recorded. A clinical comparison of 120 anterior teeth in 20 participants found scanner shade readings did not exactly match a spectrophotometer, recommending additional methods; its findings concern those devices and workflow. Geometry alone has still less shade evidence. **Engineering consequence:** permit illustrative display edits but keep clinical shade matching unassessed. [S28]

The dentist wording is now confirmed as **1.5 mm subcrestal** and **at least 1.5 mm from adjacent teeth**. Record these as **clinician-entered case feedback** only after explicitly recording them for the selected assembly. Wording confirmation does not validate clinical applicability or measure either relationship. Preserve earlier ambiguous records as unconfirmed feedback; clarify datums, intended surfaces, tolerance and applicability before assessment. A trial testing 1.5 mm subcrestal placement involved a specific bone-level, platform-switched protocol in patients with thin tissue; it does not establish a universal placement depth. [S29] A retrospective implant–tooth injury study distinguishes root invasion, contact and close proximity, and notes imaging/measurement limitations; it does not validate a general 1.5 mm clearance cutoff. [S30]

Until reviewed, registered bone crest and neighboring roots, verified scale and a clinician-selected target/method are available, return **unknown** with null actual clinical distances. `fixture.depth` remains an offset from the construction origin in file units. Scanned gingiva cannot supply bone crest, and adjacent crown contacts cannot supply root clearance. Do not request an automatic fixture change to resolve missing evidence. These are requirements for meaningful software assessment, not instructions to order imaging or prescribe treatment.

## IOS, bite, and scanner-specific limits

Core PLY has vertices, faces, and optional properties; it has no mandatory clinical unit, dental role, or scene transform. Export workflows may preserve occlusion or independently orient arches. Confirm provenance rather than inferring alignment from file names. [S17, S18]

Buccal bite records can relate arches in a recorded intercuspation pose. Published repeatability for a particular scanner/workflow is not proof of the accuracy of these files. Multiple captured positions also differ from continuous patient motion. [S15, S16]

Engineering consequence: inspect both references, preserve original poses, state any registration, and report sampled surface proximity in the actual evaluated pose. Triangle crossings can reflect scan/registration errors as well as geometry interference. They cannot establish contact pressure, tissue response, exact contact area, or safe loading.

## Release states

For IOS-only generation, deliver a **planning concept—clinical fit unvalidated**, with three separate component artifacts when requested; crown-only exterior generation remains available. Keep fixture placement, hidden connection, tissue fit, dynamic bite, material thickness, and fabrication unassessed where evidence is absent. Generating a fixture envelope does not validate its clinical placement. For restoration of an existing implant, reviewed scanbody/library registration provides component pose; it does not automatically validate every restorative constraint. Surgical and laboratory decisions remain separate review stages. [S20–S22, S26]

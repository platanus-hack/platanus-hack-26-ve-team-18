# Tooth model references for a more useful local generator

Checked **2026-10-24**. Read with [tooth-fit-research.md](tooth-fit-research.md) and the [dental-restoration-design skill](../skills/dental-restoration-design/SKILL.md). This research combines bounded public-mesh inspection with the implementation checks below. No patient data was uploaded, no dependency was added, and no external model was bundled in the application.

**Recommended starting point:** use Dundee's explicitly labeled educational teeth to review the anatomy vocabulary; use the Díaz **D36/D37** meshes below to inspect scan-derived shape and donor conversion. Keep site fitting driven by the user's reviewed neighboring surfaces, antagonist and cervical reference. A natural crown exterior, a whole tooth including roots, and a restoration with a designed intaglio are different objects.

## Six-source reference matrix

| Source and date | Geometry and anatomical labels | Verified access/license | Useful for this generator; limits |
| --- | --- | --- | --- |
| **University of Dundee, School of Dentistry — [Permanent Teeth collection](https://sketchfab.com/DundeeDental/collections/permanent-teeth-4c0d0548c40c463c8cdceb6e0d08df7f)**; models published in 2016, metadata checked above | Seventeen individual educational models across upper/lower permanent classes, including a separate Carabelli variant. [Left lower first molar](https://sketchfab.com/3d-models/mandibular-first-molar-e1c919d6603846eca873154eeededdd6) corresponds to FDI 36; [left upper first molar](https://sketchfab.com/3d-models/maxillary-first-molar-e719a474ef7e4bd7abec508f85f1e984) to 26. These include roots, not restoration interiors. | Both specific assets' public API metadata says **CC BY 4.0**. Lower-first description says ZBrush; upper-first says ZBrush using CT data. Browser previews are public; download API returned **401 without authentication**. Use the normal authorized download route, not viewer extraction. | Strong class/orientation teaching references, not unmodified natural-population samples. Metadata lists 27,592 and 28,504 faces respectively; triangulation was not inspected. **Label defect:** the collection's “Mandibular Second Molar” description instead says “Maxillary Third Molar (Left)”; quarantine that entry until reviewed. |
| **Díaz, Ferro Sanchez and Campo — [Synthetic human jaw dataset, v1](https://data.mendeley.com/datasets/xjsx7nfhj8/1)**, **2024-09-12**, DOI `10.17632/xjsx7nfhj8.1` | Fourteen separate mandibular teeth, FDI 37→31 and 41→47; filenames `Dxx`, matching PDL shells `Lxx`, bones and assembled jaw. Despite “synthetic” in its title, the method merges **IOS crowns with segmented DICOM roots** from one skeletal-Class-I case; subsequently remeshed. | **CC BY 4.0**, explicit on publisher record. Public ZIP, 109,558,383 bytes; HTTP ranges allow two sub-megabyte members to be inspected without full download. Specific assets verified below. | Best immediately usable small natural-shape reference here. Compare first/second molars and preserve their common frame. This is a processed hybrid whole tooth, not an untouched IOS crown or clinical restoration. The PDL is a constructed 0.25-mm shell; do not treat it as a measured space or transplant its dimensions as fitting defaults. |
| **Hernaiz-Garcia — [Lower-molar macrowear models, v1](https://data.mendeley.com/datasets/g8p46cw7j4/1)**, **2023-12-15**, DOI `10.17632/g8p46cw7j4.1` | Individual lower first/second molar STL surfaces from Neanderthals, fossil Homo sapiens and recent humans with differing subsistence histories. Scans of dental replicas. Names encode specimen, lower arch, side and M1/M2. | **CC BY 4.0** on publisher record. Public file metadata exposes individual downloads, e.g. [AM10854_lower_LM1.stl](https://data.mendeley.com/public-files/datasets/g8p46cw7j4/files/129120f1-4b56-46e1-a40e-4220770a6ab0/file_downloaded), **4,836,384 bytes**. This file's body was not downloaded. | Useful for wear/facet variation and testing whether the generator overproduces sharp, unworn cusps. Resolve each specimen's population and wear record before comparing it; filename alone is insufficient. Do not use pooled fossil/modern shape as a contemporary restoration norm. The landing page's “55 mm” scanner-resolution wording is questionable; do not silently reinterpret it or use it as calibration. |
| **Ben-Hamadou et al. — [Teeth3DS+ / 3DTeethLand](https://crns-smartvision.github.io/teeth3ds/)**, 2022/2024 challenges; [OSF data](https://osf.io/xctdy/) | 1,800 upper/lower IOS arches from 900 patients; OBJ vertices have JSON FDI labels and instance IDs, with `0` for gingiva. Landmark extension names mesial/distal, cusp, inner/outer gingival and facial-axis points; public training subset has 240 scans. | **Important: the actual [dataset license.txt](https://osf.io/download/9dutn/) reads CC BY-NC-ND 4.0.** The project's website footer is separately CC BY-SA 4.0; OSF's generic license field says “Other.” Read the downloadable data license. No arch archive downloaded. | Strong neighbor/context and landmark-schema reference; IOS shows exposed surfaces, not roots or restoration intaglios. Separate upper/lower files alone do not establish a registered bite. NC/ND makes this unsuitable as an automatically redistributed, cropped/deformed template library without additional permission. Inspect under its terms; do not infer a permissive data license from the web page. |
| **exocad — [ZRS Tooth Library](https://exocad.com/our-products/exocad-dentalcad/tooth-library)**, current undated product page | Natural-morphology restorative library: 61 upper-anterior sets and 19 each of lower-anterior, upper-posterior and lower-posterior sets; includes forms based on Jan Hajtó's Anteriores collection. Individual predefined teeth are editable. Public catalog groups are not downloadable per-tooth FDI metadata. | Commercial **DentalCAD add-on**, purchased through partners, with perpetual/Flex licensing. Public product descriptions/images are inspectable; no open mesh redistribution grant or public raw sample was established. No assets acquired. | Best workflow precedent for selecting a coherent morphology family and adjusting teeth individually. Library anatomy is a starting form; clinical margin, adjacent contacts, antagonist and material/process constraints remain separate fitting inputs. Do not copy vendor library geometry into v2. |
| **VITA — [VIONIC DIGITAL VIGO](https://hs.vita-zahnfabrik.com/en/vita-vionic-digital-vigo-terms-of-use)**; [January 2026 compendium](https://www.vita-zahnfabrik.com/datei.php?src=portal%2Fsap%2Fkompendium%2Fausgaben%2F274001%2Fdownload%2FVITA-Compendium_EN_1.2026.pdf), p. 53 | **Denture/prosthetic tooth library**, licensed for removable restorations, activated through exocad/3Shape. This is not a dataset of naturally positioned individual patient teeth or prepared-tooth intaglios. | Vendor terms restrict use to the stated indication and **prohibit duplication, distribution or public reproduction of the library or parts**. Activation requires the license agreement; underlying CAD EULA also applies. No assets acquired. | Useful contrast: a manufacturable denture workflow has indication-specific tooth/basal interfaces and output rules. “Free library” or export support elsewhere does not grant reuse in an unrelated generator. Do not treat a denture base interface as a natural-tooth margin or implant connection. |

Dundee's asset-specific metadata can be rechecked through the [36 API record](https://api.sketchfab.com/v3/models/e1c919d6603846eca873154eeededdd6), [26 API record](https://api.sketchfab.com/v3/models/e719a474ef7e4bd7abec508f85f1e984), and [conflicting second-molar record](https://api.sketchfab.com/v3/models/b77dcbc5052e4740b87cdb1964649742). Archive/asset terms apply independently of the hosting website's footer or application-code license.

## Two small meshes actually inspected

Both come from **Díaz et al., v1, CC BY 4.0**, with the scan-derived/processed provenance above. The publisher supplies an archive rather than standalone tooth URLs:

- [Publisher download URL](https://data.mendeley.com/public-files/datasets/xjsx7nfhj8/files/13782c79-6669-4f4f-b8f3-3459c1ac9540/file_downloaded).
- [Resolved public asset URL used for bounded byte ranges](https://prod-dcd-datasets-public-files-eu-west-1.s3.eu-west-1.amazonaws.com/100443c8-c2a4-4cfb-ada6-3e45fb3f650e). Retain the DOI/publisher link if storage URLs change.
- Archive members: `Human Lower Jaw Dataset/Teeth/STL/D36.stl` and `Human Lower Jaw Dataset/Teeth/STL/D37.stl`.

| Member / identity | Raw STL bytes / triangles | Compressed payload byte range, inclusive | Original-axis extent, **file units** |
| --- | --- | --- | --- |
| `D36.stl` / permanent lower-left first molar | 377,584 / 7,550 | `41182720–41354584` | 10.68907 × 15.53223 × 18.63476 |
| `D37.stl` / permanent lower-left second molar | 346,384 / 6,926 | `41354704–41511984` | 10.20886 × 14.42291 × 19.22783 |

SHA-256 of decompressed source bytes:

```text
D36.stl  2890fded32b03aaca71b00a0eb8c9fd04af0d6d0d1854ec11e4e10348f4ba7b4
D37.stl  a5f5488b4c300d02b51661def99df33b8a0397d55090810b2043a7decf3b0b36
```

Inspection used Python's standard library, read ZIP metadata and fetched/decompressed only these members in memory; ZIP CRCs, binary-STL byte counts and hashes matched. Approximately **342 KB** was fetched, including archive metadata. No source files were retained. These extents include roots and oblique source placement: they are **not mesiodistal/buccolingual crown dimensions**. Topology, self-intersections, cusp landmarks, crown/root boundary and anatomical axes were not validated in this research pass.

For the parent's bounded geometry inspection, the following returns the original STL bytes without a new dependency or downloading the whole ZIP. Save only into an ignored local evaluation directory if needed, alongside the source DOI and license attribution.

```python
import hashlib, urllib.request, zlib

asset = "https://prod-dcd-datasets-public-files-eu-west-1.s3.eu-west-1.amazonaws.com/100443c8-c2a4-4cfb-ada6-3e45fb3f650e"
def source_tooth(first, last, expected_sha256):
    request = urllib.request.Request(asset, headers={"Range": f"bytes={first}-{last}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 206:
            raise ValueError("Server did not honor bounded range request")
        compressed = response.read(last - first + 2)
    if len(compressed) != last - first + 1:
        raise ValueError("Unexpected byte-range length")
    mesh = zlib.decompress(compressed, -15)  # ZIP raw DEFLATE payload
    if hashlib.sha256(mesh).hexdigest() != expected_sha256:
        raise ValueError("Source mesh changed")
    return mesh
```

## Morphology lessons to encode and verify

These are **qualitative priors with variants**, not fixed patient dimensions or obligatory cusp counts. FDI requires confirmed arch, side and position; camera direction and gap width do not determine identity.

| Permanent class | Feature distinction worth preserving |
| --- | --- |
| **Upper first molar, 16/26** | Four main unequal cusps; rhomboidal outline; an oblique ridge from mesiolingual to distobuccal, with distinct fossae. Carabelli is an optional supplemental feature, not a mandatory fifth load-bearing bump. [Mustansiriyah lecture 13, pp. 5–6](https://uomustansiriyah.edu.iq/media/lectures/3/3_2017_12_08!10_53_23_AM.pdf). |
| **Upper second molar, 17/27** | Reduced distal cusp development and distal taper; retain rhomboidal and reduced-distolingual/heart-shaped alternatives. Merely shrinking an upper first molar misses this change. [Mustansiriyah lecture 14, pp. 1–2](https://uomustansiriyah.edu.iq/media/lectures/3/3_2017_12_08!10_51_48_AM.pdf). |
| **Lower first vs second molar, 36/46 vs 37/47** | First typically has five cusps including a small distal cusp and separate buccal grooves; second typically has four more comparable cusps and a cross-shaped groove arrangement. Preserve the groove network, marginal ridges and asymmetric silhouette, not just peak count. [Al-Mustaqbal mandibular-molar lecture, pp. 4–8](https://uomus.edu.iq/uploads/lectures/9/e9158f36e3fc453a8df1d76e6eefd31d.pdf). |
| **Premolars, digits 4/5** | Upper first: more prominent buccal cusp and mesial marginal groove; upper second: rounder outline, more similar cusp heights and shorter central groove. Lower first: dominant buccal and small lingual cusp; lower second: preserve two-cusp H/U and three-cusp Y variants. Avoid one generic bicuspid for all four classes. [Mustansiriyah maxillary-premolar lecture](https://uomustansiriyah.edu.iq/media/lectures/3/3_2017_12_08%2110_58_15_AM.pdf); [Oral Facial Anatomy Online, permanent posterior teeth](https://ecampusontario.pressbooks.pub/oralfacialonline/chapter/tooth-morphology-part-a/). |
| **Incisors, digits 1/2** | Incisal ridge/edge, lingual fossa, cingulum and marginal ridges; use a blade-like crown rather than posterior cusp bumps. Upper incisors generally have greater width than lower incisors; central/lateral variants and wear matter. [Al-Mustaqbal incisor lecture, p. 1](https://uomus.edu.iq/uploads/lectures/9/90bfb6f05eab4ec88ed6c6c45adcced1.pdf); [GVSU, Dentition](https://pressbooks.gvsu.edu/introhumanosteology/chapter/dentition/). |

The teaching sources are publicly readable; no blanket mesh/image reuse rights are inferred from university hosting. The prior research already documents natural molar variation and why typical MD/BL proportions must not become hard acceptance rules.

## Implementation recommendations

1. **Keep reference identity explicit.** Record source/version/license/hash, whole-tooth versus crown exterior versus restoration, FDI or unresolved identity, natural/edited/synthetic provenance, local anatomy frame and crop definition. Start empty; any reference import is an explicit user action. Never place a lower-36 reference into an unidentified upper gap because it fits the bounding box.
2. **Preserve anatomy through fitting.** Represent named cusp peaks, ridge connections, fossae, grooves and cervical silhouette as editable regions. Inspect the emitted mesh before and after fitting: a parameter list does not demonstrate that the surface retains those features. Normalize comparisons in a reviewed anatomical frame; global-axis bounds are unsuitable for deriving crown proportions.
3. **Separate donor-conversion errors.** Evaluate occlusal, side-wall and crop-boundary residuals independently, ideally in both surface directions. Sample triangle surfaces/intersections rather than assigning walls from nearest vertices alone. Record sampling coverage and report median, high percentile and worst residual separately; an improved wall percentile does not establish a better margin or global accuracy. A crop boundary is a geometric choice, not an identified clinical margin.
4. **Fit local context separately from naturalness.** Keep mesial/distal contact regions, antagonist envelope and cervical reference as distinct constraints. Preserve the source arch pose; local deformation of the contact regions should not erase cusp/fossa relationships or shrink the crown into an isolated pebble. None of these public references supplies this patient's internal seat, tissue adaptation, material thickness or implant interface.
5. **Use variation evidence conservatively.** [Oxilia et al., 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC11941563/) found greater contralateral similarity than between-person similarity in upper first molars, supporting a reviewed same-person donor as a prior. However, its methods inconsistently describe 76 individuals versus 76 teeth/38 individuals; the sample is selected, minimally worn, Italian and Class I, and its Procrustes results are not millimeter fitting tolerances. No public STL deposit was established. [Jin et al., 2023](https://www.frontiersin.org/journals/bioengineering-and-biotechnology/articles/10.3389/fbioe.2023.1216651/full) conditions crown shape on adjacent teeth and adapts to a preparation finish line, with target location still manually specified. Its data require author request and its biomechanical result is proof of concept. Adopt the separation of anatomy and context; do not import claimed accuracy thresholds into v2.

The supplied `user36STL` remains the separately measured local reference documented in `tooth-fit-research.md`; it has not been relabeled as a natural whole tooth or assumed to possess a usable seating interface. The measurements below apply to the implementation and local reference inspection, independently of these public dataset descriptions.


## Applied geometry changes and local validation

- Upper molar fallbacks now place an oblique bridge between the mesiolingual and distobuccal cusps. The prior diagonal was reversed and the generic grooves erased the intended bridge. Emitted-triangle tests check the bridge and flanking depressions while retaining four cusp peaks and the original bounding envelope. These are normalized procedural shape choices, not a learned natural-tooth model.
- The lower first premolar's lingual shoulders narrow; its dominant buccal and smaller lingual cusp remain. The lower second premolar is explicitly described as a two-cusp hypothesis; the three-cusp variant is not implemented or inferred from patient data.
- Donor walls use radial-plane/triangle intersections at each output level, replacing nearby-vertex bins. Observed radii are retained; only missing radii are filled angularly or extrapolated axially. Source-coordinate Float32 precision sets the height-intersection tolerance. Sections are consumed immediately instead of retaining every angle's segments. The smoothed rim, polar sampling, outer-envelope representation and artificial basal cap remain approximations.
- Fitting now retains its resolved undeformed crown shape in the output specification. Subsequent edits and saved cases preserve that shape instead of selecting the current procedural template again. Legacy cases without a saved shape retain their stored meshes on reopening; their first explicit regeneration adopts and records the current template.

The supplied 36 STL was resampled in the **same declared computational frame** as the earlier inspection, with +Z as the approximate occlusal direction. This frame is not a reviewed anatomical placement. One-direction **output-vertex to source-triangle** distances, in file units:

| Region / sample count | Median before → after | p95 before → after | Maximum before → after |
| --- | --- | --- | --- |
| Wall / 1,248 | 0.03352 → 0.00000011 | 0.11090 → 0.00466 | 0.27575 → 0.15793 |
| Occlusal / 2,305 | 0.00176 → 0.00178 | 0.00959 → 0.00952 | 0.02609 → 0.02615 |
| Artificial margin / 96 | 0.28449 → 0.36855 | 0.66945 → 0.55830 | 0.68234 → 0.56893 |

The margin's **median worsened**, although its p95 and maximum decreased. Its entire basal row still requires extrapolation because the source closes to a point at the selected datum. This is not a validated cervical contour or an intaglio. These sampled residuals do not establish Hausdorff distance, clinical accuracy, contacts, material thickness or improved patient fit. The source STL was not substituted into the user's unidentified upper gap.

Reproduction scripts, source-frame inspection, before/after measurements and generated anatomy views are in the ignored `work/dental-skill-evaluation/tooth-models/` directory. No patient mesh or public library mesh is shipped with the application.

Final validation: **917 tests passed**, `pnpm build` passed (existing large-bundle warning). Independent reviews reproduced and verified fixes for rigid-pose rounding, file-unit scale invariance and peak memory; the 120,000-face stress input fell from 742 MiB / 4.81 s to 487.5 MiB / 1.76 s in separate local processes, not a general performance guarantee. The final browser build started empty and passed six-file import/render, completed collision evidence and color toggling, offset/reset, old-case reopening, explicit crown regeneration and saving/reopening the recorded anatomy. No external requests were made by that browser run.

The browser regenerated the existing draft at its saved dimensions rather than rerunning optimization. Its static forward gap was 0.1480 u with 100/120 ray hits; the bounded antagonist intersection test reported zero while the tissue test still reported **86 intersecting crown/abutment triangles**. These checks do not establish a fit pass, and fixture depth remains an unassessed placeholder. The resumable local result is `work/dental-skill-evaluation/tooth-models/platanus-case.json`; reimport the same six source files before reopening it.

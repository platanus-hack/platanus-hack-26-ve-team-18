# Vercel AI SDK integration

## Current chat and local geometry host

This repository uses `ai` 7, Zod, the direct Anthropic provider, and `streamText` in `server/assistant.ts`. It runs behind the existing local Vite middleware, not a deployed Vercel function. No additional provider, backend, dependency, API key, or model training is needed to load the skill.

The middleware loads the trusted `SKILL.md` text as guidance alongside its existing case rules. `getDentalDesignGuidance({ topic })` retrieves allowlisted references on demand. The documents are **general design knowledge**, not tool observations of this patient. Case assertions still require the existing snapshot tools. Reference URLs are sources for general claims and must never be presented as confirmation of a patient finding.

Actual topic names and server implementation live in `server/dental-skill.ts`; read that file rather than inventing arguments. The UI function catalog must include any exposed tool. The server controls document locations; model inputs never become file paths. Keep references packaged with the application if hosting it elsewhere, or prebundle the trusted texts at build time. Do not make patient files static assets to support a skill loader.

Existing case tools include `getModelInventory`, `getToothChart`, `inspectImplantSite`, `getCollisionReport`, `getBiteFitReport`, `inspectSurfaceProbe`, `measureSiteDistance`, and `getPlanningChecklist`. These remain bounded, read-only evidence views. Check the live catalog for separately enabled restoration inventory and edit tools; do not infer mutation capability from a skill document. Mesh arrays, source files and full transforms stay local. Optional image sharing is an explicit host capability, not an implication of the metadata tools. The chat cannot segment a tooth, execute a CLI, move original meshes arbitrarily or certify clinical placement. A clinician-entered implant intention or surface marker does not supply a fixture axis.

The separate in-app **restoration worker executor** accepts the data-only `RestorationSpec` and runs `generateRestoration` locally. It produces three actual component meshes: generic fixture, abutment/pilar, and crown. UI defaults are geometric hypotheses that may be manually tuned; none establishes bone-safe depth, an implant interface, or manufacturer compatibility. Read [component parameters](component-parameters.md) for the exact contract. Keep the mesh buffers in the local workspace; this action requires no patient provider call or new dependency.

The explicit **case-planning workflow** is a separate host from the interactive assistant and its optional bounded edit loop. Its structured `inspectPreparedCase`, `evaluateMissingSite`, `chooseAnatomicalCandidate` and `requestDraftComponents` tools inspect bounded local evidence and queue supported draft intentions. Browser workers resolve source geometry, choose an eligible donor or labeled procedural fallback, construct components, fit and measure them, and retain the best valid candidate. A queued intention is not an artifact. The case stores provider-reported model attribution/token usage, actual tool results, local stage results, correction actions and candidate history. Cancellation terminates pending workers; resuming retained evidence uses a local draft without silently spending another provider request.

The three current planning presets use low effort within the output cap: Haiku disables up-front thinking, Sonnet uses `between_tools`, and Opus uses adaptive thinking. Custom server models receive no invented provider setting. These per-model choices avoid spending the full structured-output cap on reasoning; they do not establish medical reasoning quality. See the installed Anthropic provider options, [thinking troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), and [Opus 5.5 migration guidance](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide), checked 2026-10-24. The host enforces bounded steps, tools, tokens, runtime and fitting candidates; provider charges still depend on the account and failed requests may incur usage.

The coding agent can also run the local `generate-assembly.mjs --spec … --out-dir …` CLI with source-file access to produce separate PLY artifacts and a manifest. The existing crown-only CLI remains separate. The CLI is not a chat tool. Mutation capability exists only when the live host explicitly enables its bounded restoration-edit tool. Report generation/editing only after the relevant executor returns actual current-revision artifacts; a queued request is not a completed edit.

## Explicitly enabled bounded restoration editing

The editing contract is **read current inventory → propose a validated component edit → local worker regenerates/measures → return fresh evaluation → bounded follow-up**. Inventory must include component IDs, parameters/anatomy/appearance, actual extents, quality and dentist guardrails, unresolved evidence and a revision token. A proposal identifies the current assembly/revision, reason, and a supported parameter, anatomy/contour or display-appearance patch. It must not contain raw vertices, executable code or an arbitrary source transform.

The host validates the shared edit schema and finite construction bounds, checks the revision immediately before applying, executes expensive geometry/collision work in its cancellable worker, and returns actual completion, failure, stale or cancelled status. Cap calls, iterations and runtime; refresh inventory after each applied edit rather than chaining proposals against an old snapshot. Keep comparison/history and cancellation behavior. Routine authorized concept edits need no extra approval ceremony, but an absent/disabled edit capability cannot be bypassed by prose.

Interpret the report by domain. Existing `quality.criteria`, `status` and numeric `revisions` retain the ten engineering fitting checks. The additive optional `quality.guardrails` extension (`restoration-guardrails/v1`) covers anatomy, actual component dimensions, cervical/emergence, surface integrity, shade, subcrestal placement and adjacent-root clearance. Each issue identifies components, status, actual/target values, missing evidence and **nonautomatic** supported edit suggestions. Unknown evidence never becomes a pass and never adds a numeric fitting revision. Clinical placement, shade, tissue response and manufacturing approval remain unsupported.

`qualityContext.placementFeedback` optionally stores `subcrestalDepthMm`, `adjacentToothClearanceMm`, `source` and provenance (`unconfirmed-case-feedback` or `clinician-entered-case-feedback`). The latter records confirmed dentist wording, not verified applicability or measurements. The confirmed 1.5 mm / ≥1.5 mm wording may be offered as a form prefill, but only an explicit record action attaches it to the selected assembly. There are no generator/evaluator defaults, automatic unit conversion or fixture relocation. Clinical scale, bone/root references and target applicability remain unassessed by this evaluator.

Older v1 quality reports without `guardrails` remain readable. Do not infer a clinical pass from their absence. Recompute current guardrails from restored, verified components/spec/evidence before exposing them as current inventory; historical reports remain bound to their original revision. Changing display colour must not confirm tooth identity or clinical shade. Supported `contour.cervicalScale` / `contour.occlusalScale` controls deform a concept; they do not supply clinical contour or anatomy validation.

## Executor lifecycle and optional future SDK adapter

For the local assembly, validate against `RestorationSpec` and the pure generator; do not pass it to the incompatible crown-only `validateConceptSpec`. Keep fixture, abutment, and crown identities, edit parameters, visibility, and exports separate. Store the frame in source coordinates and compose the current source pose once for display, evaluation, and export. A successful worker result creates planning geometry, not a fit audit.

The surrounding application owns source hashes, poses, job IDs, revisions, cancellation, and artifact lifetime. Snapshot all dependencies before dispatch; on an edit, source/pose change, reset, or removal, terminate obsolete work and reject any late result that no longer matches. The pure generator is synchronous; queued abort messages cannot interrupt it while blocked. Do not use a no-op cancellation callback as evidence that a stale job stopped.

Use the current SDK's typed `tool({ inputSchema, execute })` API and a bounded tool loop; pass the tool execution abort signal through to the geometry job. The official references are [Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) and [Loop control](https://ai-sdk.dev/docs/agents/loop-control), checked 2026-10-24. Verify installed APIs when adapting; do not copy old SDK approval or loop examples blindly.

Expose explicit capabilities such as inspect sources, request views, evaluate a site, generate an exterior concept, and audit a candidate only when those executors actually exist. Register each capability in the host's catalog. Avoid exposing arbitrary filesystem paths, executable code, shell commands, or unrestricted script execution to the model.

A general new-assembly or crown-only creation adapter would require its own validated data specification and executor; do not infer it from existing-component editing. Read the live tool catalog before naming an available action.

The donor route can instead execute the pure `createDonorExterior` helper on locally resolved source geometry, with explicit clipping planes and an affine donor edit. Keep raw file paths out of model-facing tool arguments. It returns selected surface geometry and provenance, not a fit approval; use the same job/revision envelope and independent evaluation.

An application job envelope can preserve dependencies around the distinct generator schemas:

```ts
type GeometryJob = {
  caseId: string;           // opaque, scoped to the current local case
  operationId: string;      // retry identity within that case
  caseRevision: string;    // changes with source, pose, site, or annotation changes
  sourceGeometry: {
    id: string;
    byteSha256: string;
    geometrySha256: string;
    fileToWorkspace: number[]; // 16 column-major rigid-matrix entries
  }[];
  siteRevision: string;
  annotationRevision: string;
  designSpec: unknown;     // validate with the selected generator's contract; never execute it
};

type GeometryResult = {
  operationId: string;
  caseRevision: string;
  status: 'concept' | 'needs-input' | 'invalid' | 'cancelled' | 'stale';
  artifactId: string | null; // bounded ID; mesh remains local
  auditId: string | null;
  unresolved: string[];
};
```

Bind generated artifacts to **every** geometry dependency: exact bytes/triangle order where relevant, file-to-workspace matrices, site and tooth annotations, unit conversion, design parameters, and evaluator settings. Recheck these atomically before adding a result to the workspace. A source-only revision does not catch manual pose or annotation changes. A transport scan alias is not a stable source hash.

Keep expensive import, registration, distance/intersection checks, and fitting in cancellable workers. The executor must terminate stale work, enforce time/triangle/iteration limits, release buffers, and avoid applying partial results. Retry the same operation ID without inserting duplicate objects. Applying a completed concept is reversible and should integrate with the existing workspace state and reset/undo behavior. Do not create a new approval flow for routine concept edits merely because they use a skill.

## LLM context and result discipline

Send compact numerical summaries, chosen parameters, provenance-tagged evidence, and selected rendered views when the host explicitly supports image input. Keep raw mesh buffers local. A screenshot supports visual inspection; it does not provide calibrated dimensions or reveal bone. A text-only model may direct tool calls using summaries but should not claim it saw the mesh.

Separate measurement facts from design hypotheses in tool results. Use null for unavailable values, never zero. Include method, units, sample count, direction, pose revision, and limitations with each result. Return artifact handles and audit status rather than megabytes of triangles. Do not put patient names in source IDs, logs, or errors. Review actual outgoing data before enabling an additional provider flow; this skill does not authorize silent uploads.

In an editing host, iterate through **specification → local mesh → audit/views → bounded parameter adjustment**. Only report that a model was created when an artifact exists. A failed audit remains a failed audit even if the LLM writes a favorable explanation. Distinguish topology pass, geometric relationships, anatomical plausibility, clinical review, and fabrication readiness as separate states. No single score implies all five.

## Integration tests

Use the existing SDK mock model for tool selection, prompt loading, progressive reference retrieval, invalid arguments, source provenance, streaming, and failure behavior. Do not spend a live provider call merely to test the loader. Separately test the assembly generator's frame/component invariants and the worker's stale-result rejection, cancellation, edit/reset, and export behavior. The independent coding-agent case exercise tests actual geometry reasoning; a mock SDK conversation does not replace it.

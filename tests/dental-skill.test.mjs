import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { asSchema } from 'ai';
import { createDentalDesignTools, dentalGuidanceTopics, loadDentalDesignInstructions, loadDentalGenerationInstructions, MAX_DENTAL_DOCUMENT_BYTES } from '../server/dental-skill.ts';
import { planningInstructions } from '../server/case-planning.ts';

test('trusted main skill distinguishes enabled bounded edits from unavailable operations', async () => {
  const main = await readFile(new URL('../skills/dental-restoration-design/SKILL.md', import.meta.url), 'utf8');
  const instructions = await loadDentalDesignInstructions();
  assert.ok(instructions.includes(main));
  assert.match(instructions, /GENERAL DESIGN KNOWLEDGE; not a patient observation/);
  assert.match(instructions, /When requestRestorationEdit is enabled/);
  assert.match(instructions, /Without that tool, provide evidence interpretation and design guidance only/);
  assert.match(instructions, /Raw mesh access, coding-agent CLI execution.*clinical placement approval remain unavailable/);
  assert.match(instructions, /Read the host result before claiming any change/);
  assert.match(instructions, /do not establish patient-specific anatomy or replace fresh case-tool evidence/);
});

test('all allowlisted topics return bounded repository knowledge with independent provenance', async () => {
  const { getDentalDesignGuidance: guidance } = createDentalDesignTools();
  assert.equal(guidance.metadata.annotations.readOnlyHint, true);
  const schema = asSchema(guidance.inputSchema).jsonSchema;
  assert.deepEqual(schema.properties.topic.enum, dentalGuidanceTopics);
  assert.deepEqual(schema.required, ['topic']);
  assert.equal(schema.additionalProperties, false);
  assert.ok(dentalGuidanceTopics.includes('component-parameters'));
  for (const topic of dentalGuidanceTopics) {
    const output = await guidance.execute({ topic });
    assert.equal(output.status, 'available', topic);
    assert.equal(output.topic, topic);
    assert.equal(output.source, `skills/dental-restoration-design/references/${topic}.md`);
    assert.match(output.provenance, /GENERAL DESIGN KNOWLEDGE; not a patient observation/);
    assert.equal(output.content, await readFile(new URL(`../${output.source}`, import.meta.url), 'utf8'));
    assert.ok(output.content.trim().length > 100, topic);
    assert.ok(Buffer.byteLength(output.content, 'utf8') <= MAX_DENTAL_DOCUMENT_BYTES, topic);
    assert.match(output.limitations.join(' '), /fresh case tools for every case-specific assertion/);
    assert.match(output.limitations.join(' '), /reference reader cannot change the case/);
    assert.match(output.limitations.join(' '), /only when requestRestorationEdit is in the live catalog/);
    assert.equal(Object.hasOwn(output, 'units'), false);
    assert.equal(Object.hasOwn(output, 'parts'), false);
    assert.equal(Object.hasOwn(output, 'teeth'), false);
  }
});

test('generation preloads bounded trusted skill, clinical, exact component and geometry guidance without chat capability restrictions', async () => {
  const instructions = await loadDentalGenerationInstructions();
  for (const filename of ['SKILL.md', 'references/clinical-considerations.md', 'references/component-parameters.md', 'references/geometry-workflow.md']) {
    const content = await readFile(new URL(`../skills/dental-restoration-design/${filename}`, import.meta.url), 'utf8');
    assert.ok(Buffer.byteLength(content, 'utf8') <= MAX_DENTAL_DOCUMENT_BYTES);
    assert.ok(instructions.includes(content), filename);
    assert.ok(instructions.includes(`skills/dental-restoration-design/${filename}`));
  }
  assert.match(instructions, /GENERAL PRIOR KNOWLEDGE; not case evidence/);
  assert.match(instructions, /hypothesized illustrative geometry in file units/);
  assert.doesNotMatch(instructions, /Current chat capability scope:/);
});

test('planning instructions require complete AI-authored design, optional evidence tools and honest worker handoff', async () => {
  const instructions = await planningInstructions();
  assert.match(instructions, /AI WORKFLOW:/);
  assert.match(instructions, /local algorithm workflow/);
  assert.match(instructions, /construct and measure exactly those values with operation local-construct-measure/);
  for (const fields of [
    'design.anatomySource', 'parameters.fixture.{radius,length,depth,taper}',
    'parameters.abutment.{radius,height,emergenceRadius,angleX,angleY}',
    'parameters.crown.{width,depth,height,cuspHeight,rotation}', 'contour.{cervicalScale,occlusalScale}',
  ]) assert.ok(instructions.includes(fields), fields);
  assert.match(instructions, /No parameter, source or contour may be omitted or filled by hidden defaults/);
  assert.match(instructions, /site's numerical MD\/BL, crown-height and sampled vertical evidence/);
  assert.match(instructions, /hypothesized illustrative geometry in file units; they are not clinical fixture prescriptions/);
  assert.match(instructions, /Never emit raw vertices/);
  assert.match(instructions, /optional evidence views, not sequential prerequisites/);
  assert.match(instructions, /queue a complete design directly from the supplied preparation/);
  assert.match(instructions, /geometricDraftEligible true/);
  assert.match(instructions, /keep the actual site FDI and laterality unresolved/);
  assert.match(instructions, /Never claim generation, fit, placement or successful measurements before actual worker results/);
  assert.match(instructions, /host-owned componentDesign nested-support\/v1/);
  assert.match(instructions, /[Aa]butment.height remains the crown seating\/body datum/);
  assert.match(instructions, /component-support.pilar-enclosure/);
  assert.match(instructions, /never universal zero distance or all-surface contact/);
  assert.match(instructions, /consume actual rejectedCandidate feedback/);
  assert.match(instructions, /only when getRestorationDesign and requestRestorationEdit are actually enabled/);
  assert.doesNotMatch(instructions, /Never prescribe numerical bone, fixture, screw or abutment parameters/);
  assert.doesNotMatch(instructions, /Current chat capability scope:/);
});

test('schema and direct execution deny unknown topics, traversal and model-supplied paths or case data', async () => {
  const { getDentalDesignGuidance: guidance } = createDentalDesignTools();
  const invalid = [
    {}, null, { topic: null }, { topic: 1 }, { topic: ['sources'] }, { topic: '' },
    ...['unknown', '../SKILL.md', '../../.env.local', '/etc/passwd', '%2e%2e%2f.env.local', '__proto__', 'constructor', 'sources.md', 'sources\u0000'].map(topic => ({ topic })),
    { topic: 'sources', path: '../../.env.local' }, { topic: 'sources', file: 'patient-scan.ply' },
    { topic: 'sources', snapshot: { parts: [{ positions: [987654.321] }] } },
  ];
  for (const input of invalid) {
    assert.equal(guidance.inputSchema.safeParse(input).success, false);
    await assert.rejects(guidance.execute(input));
  }
});

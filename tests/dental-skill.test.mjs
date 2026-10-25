import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { asSchema } from 'ai';
import { createDentalDesignTools, dentalGuidanceTopics, loadDentalDesignInstructions, MAX_DENTAL_DOCUMENT_BYTES } from '../server/dental-skill.ts';

test('trusted main skill loads with an explicit metadata-only chat capability scope', async () => {
  const main = await readFile(new URL('../skills/dental-restoration-design/SKILL.md', import.meta.url), 'utf8');
  const instructions = await loadDentalDesignInstructions();
  assert.ok(instructions.includes(main));
  assert.match(instructions, /GENERAL DESIGN KNOWLEDGE; not a patient observation/);
  assert.match(instructions, /CLI, mesh inspection, construction, editing, artifact generation, and placement workflows.*unavailable/);
  assert.match(instructions, /never execute or claim those operations/);
  assert.match(instructions, /do not establish patient-specific anatomy or replace fresh case-tool evidence/);
});

test('all allowlisted topics return bounded repository knowledge with independent provenance', async () => {
  const { getDentalDesignGuidance: guidance } = createDentalDesignTools();
  assert.equal(guidance.metadata.annotations.readOnlyHint, true);
  const schema = asSchema(guidance.inputSchema).jsonSchema;
  assert.deepEqual(schema.properties.topic.enum, dentalGuidanceTopics);
  assert.deepEqual(schema.required, ['topic']);
  assert.equal(schema.additionalProperties, false);
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
    assert.match(output.limitations.join(' '), /cannot access mesh files.*generate artifacts.*change the case/);
    assert.equal(Object.hasOwn(output, 'units'), false);
    assert.equal(Object.hasOwn(output, 'parts'), false);
    assert.equal(Object.hasOwn(output, 'teeth'), false);
  }
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

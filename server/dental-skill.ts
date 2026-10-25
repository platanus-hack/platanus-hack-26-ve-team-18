import { open } from 'node:fs/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { assistantToolCatalog } from '../src/assistant-context.ts';

// Fixed repository documents only. Neither the model nor request data supplies paths.
const skillRoot = new URL('../skills/dental-restoration-design/', import.meta.url);
export const dentalGuidanceTopics = [
  'clinical-considerations', 'component-parameters', 'geometry-workflow', 'concept-kit', 'ai-sdk-integration', 'sources',
] as const;
const referenceFiles = {
  'clinical-considerations': 'references/clinical-considerations.md',
  'component-parameters': 'references/component-parameters.md',
  'geometry-workflow': 'references/geometry-workflow.md',
  'concept-kit': 'references/concept-kit.md',
  'ai-sdk-integration': 'references/ai-sdk-integration.md',
  sources: 'references/sources.md',
} as const satisfies Record<typeof dentalGuidanceTopics[number], string>;
export const MAX_DENTAL_DOCUMENT_BYTES = 32_000;
const provenance = 'GENERAL DESIGN KNOWLEDGE; not a patient observation';
const inputSchema = z.object({ topic: z.enum(dentalGuidanceTopics) }).strict();

/** Bound reads as well as model output; never silently truncate instructions. */
async function readDocument(filename: 'SKILL.md' | typeof referenceFiles[keyof typeof referenceFiles]) {
  const file = await open(new URL(filename, skillRoot), 'r');
  try {
    const bytes = Buffer.alloc(MAX_DENTAL_DOCUMENT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_DENTAL_DOCUMENT_BYTES) throw new Error('Dental guidance exceeds its document limit.');
    const content = bytes.subarray(0, size).toString('utf8');
    if (!content.trim()) throw new Error('Dental guidance is empty.');
    return content;
  } finally { await file.close(); }
}

/** Trusted main instructions load on the host; references are read progressively. */
export async function loadDentalDesignInstructions() {
  const content = await readDocument('SKILL.md');
  return `Trusted repository skill: skills/dental-restoration-design/SKILL.md\n${provenance}.\n\n${content}\n\nCurrent chat capability scope: Use only tools present in the live catalog. When requestRestorationEdit is enabled, a revision-bound edit to an existing concept can be proposed; the host worker measures it and either applies it or rejects it without replacing the model. Read the host result before claiming any change. Without that tool, provide evidence interpretation and design guidance only. Raw mesh access, coding-agent CLI execution, arbitrary scan movement, new artifact generation and clinical placement approval remain unavailable. General design priors do not establish patient-specific anatomy or replace fresh case-tool evidence.`;
}

/** Generation starts with the exact component contract and evidence workflow already in context. */
export async function loadDentalGenerationInstructions() {
  const documents = [
    ['repository skill', 'SKILL.md'],
    ['clinical reference', 'references/clinical-considerations.md'],
    ['component parameter reference', 'references/component-parameters.md'],
    ['geometry workflow reference', 'references/geometry-workflow.md'],
  ] as const;
  const content = await Promise.all(documents.map(async ([label, filename]) =>
    `Trusted ${label}: skills/dental-restoration-design/${filename}\nGENERAL PRIOR KNOWLEDGE; not case evidence.\n${await readDocument(filename)}`));
  return `${content.join('\n\n')}\n\nNumeric literature context is never a patient prescription. Explicit component controls may describe hypothesized illustrative geometry in file units; they do not establish clinical fixture dimensions or placement. Use only the live generation tools: requestDraftComponents queues an exact design, and cannot read its future worker measurements or edit a constructed assembly. Actual component-support.pilar-enclosure, per-target contact bands, external crossings and gum exposure must come from the completed host result. Later restoration review can propose bounded repairs only when getRestorationDesign and requestRestorationEdit are actually enabled; the reference text does not enable those tools.`;
}

/** No case snapshot, filesystem tool, shell, or geometry executor is exposed. */
export function createDentalDesignTools() {
  const entry = assistantToolCatalog.find(entry => entry.name === 'getDentalDesignGuidance')!;
  // Validate direct calls too; tool() itself is only a typing helper.
  const execute = async (input: z.infer<typeof inputSchema>) => {
    const { topic } = inputSchema.parse(input);
    const source = `skills/dental-restoration-design/${referenceFiles[topic]}`;
    const common = {
      topic, source, provenance,
      limitations: [
        'This reference is general design knowledge, not case evidence or a patient observation. Use fresh case tools for every case-specific assertion.',
        'The reference reader cannot change the case. Separate revision-bound editing is available only when requestRestorationEdit is in the live catalog; its host result determines whether a change was applied. Raw mesh access, CLI execution and clinical placement approval remain unavailable.',
      ],
    };
    try { return { ...common, status: 'available' as const, content: await readDocument(referenceFiles[topic]) }; }
    catch { return { ...common, status: 'unavailable' as const, content: null, reason: 'The repository reference is unavailable or exceeds the bounded document limit. Do not claim it was read.' }; }
  };
  return {
    getDentalDesignGuidance: Object.assign(tool({
      title: entry.title,
      description: entry.description,
      inputSchema,
      execute,
      metadata: { annotations: { readOnlyHint: true } },
    }), { inputSchema, execute }),
  };
}

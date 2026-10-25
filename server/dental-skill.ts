import { open } from 'node:fs/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { assistantToolCatalog } from '../src/assistant-context.ts';

// Fixed repository documents only. Neither the model nor request data supplies paths.
const skillRoot = new URL('../skills/dental-restoration-design/', import.meta.url);
export const dentalGuidanceTopics = [
  'clinical-considerations', 'geometry-workflow', 'concept-kit', 'ai-sdk-integration', 'sources',
] as const;
const referenceFiles = {
  'clinical-considerations': 'references/clinical-considerations.md',
  'geometry-workflow': 'references/geometry-workflow.md',
  'concept-kit': 'references/concept-kit.md',
  'ai-sdk-integration': 'references/ai-sdk-integration.md',
  sources: 'references/sources.md',
} as const satisfies Record<typeof dentalGuidanceTopics[number], string>;
export const MAX_DENTAL_DOCUMENT_BYTES = 24_000;
const provenance = 'GENERAL DESIGN KNOWLEDGE; not a patient observation';
const inputSchema = z.object({ topic: z.enum(dentalGuidanceTopics) }).strict();

/** Bound reads as well as model output; never silently truncate instructions. */
async function readDocument(filename: string) {
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
  return `Trusted repository skill: skills/dental-restoration-design/SKILL.md\n${provenance}.\n\n${content}\n\nCurrent chat capability scope: Apply this skill only to evidence interpretation and design guidance. Coding-agent CLI, mesh inspection, construction, editing, artifact generation, and placement workflows in these documents are unavailable in this host. Explain the unmet capability when requested; never execute or claim those operations. General design priors do not establish patient-specific anatomy or replace fresh case-tool evidence.`;
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
        'The current chat reads metadata only. It cannot access mesh files, run the concept CLI, generate artifacts, place restorations, or change the case.',
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

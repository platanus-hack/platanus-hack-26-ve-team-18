import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createAssistantMiddleware } from './server/assistant.ts';
import { createToothIdentificationMiddleware } from './server/tooth-identification.ts';
import { createCasePlanningMiddleware } from './server/case-planning.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ANTHROPIC_');
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL;
  const toothModel = process.env.ANTHROPIC_TOOTH_MODEL || env.ANTHROPIC_TOOTH_MODEL;
  const planningModel = process.env.ANTHROPIC_PLANNING_MODEL || env.ANTHROPIC_PLANNING_MODEL;
  const middleware = createAssistantMiddleware({ apiKey, model });
  const teeth = createToothIdentificationMiddleware({ apiKey, model: toothModel });
  const planning = createCasePlanningMiddleware({ apiKey, model: planningModel });
  const assistant: Plugin = {
    name: 'local-case-assistant',
    configureServer(server) { server.middlewares.use(planning); server.middlewares.use(teeth); server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(planning); server.middlewares.use(teeth); server.middlewares.use(middleware); },
  };
  return { plugins: [react(), tailwindcss(), assistant] };
});

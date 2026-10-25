import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createAssistantMiddleware } from './server/assistant.ts';
import { createToothIdentificationMiddleware } from './server/tooth-identification.ts';
import { createCasePlanningMiddleware } from './server/case-planning.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ANTHROPIC_');
  const middleware = createAssistantMiddleware({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
  const teeth = createToothIdentificationMiddleware({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_TOOTH_MODEL });
  const planning = createCasePlanningMiddleware({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_PLANNING_MODEL });
  const assistant: Plugin = {
    name: 'local-case-assistant',
    configureServer(server) { server.middlewares.use(planning); server.middlewares.use(teeth); server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(planning); server.middlewares.use(teeth); server.middlewares.use(middleware); },
  };
  return { plugins: [react(), tailwindcss(), assistant] };
});

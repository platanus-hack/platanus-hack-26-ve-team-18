import { createRestorationSiteProposer } from './restoration-site';
self.onmessage = event => {
  const { id, fdis, parts, teeth, scans } = event.data;
  const specs = [], warnings = [];
  const propose = createRestorationSiteProposer(parts, teeth, scans);
  for (const fdi of fdis) {
    try { specs.push(propose(fdi)); }
    catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  }
  self.postMessage({ id, specs, warnings });
};

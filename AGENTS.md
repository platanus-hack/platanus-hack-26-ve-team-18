# Platanus v2

Keep this project focused on local mesh import, rendering, and collision inspection. The sibling `../platanus` app is independent; do not edit it as part of v2 work.

- Start empty. Never load a hardcoded model or a remote sample automatically.
- Keep the smallest useful implementation. No backend, AI, account system, or new dependencies without a concrete requirement.
- Preserve the shared coordinate system across imported files. Label distances as file units; never silently assume millimeters.
- Keep import, collision geometry, and presentation separate. Run expensive collision work in the worker and cancel stale work.
- Explain sampled distances and geometry limits honestly. Do not present vertex samples as exact contact area or overlap volume.
- Use the existing Tailwind setup and light blue/slate palette. Keep loading, empty, error, and WebGL recovery states usable.
- Run `pnpm test` and `pnpm build` after geometry or integration changes. Smoke-test import → render → collision colors → offset/reset in the browser before a demo.
- Keep secrets out of source; document any new environment variables in `.env.example`.

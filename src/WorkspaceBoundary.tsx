import { Component, type ReactNode } from 'react';

export class WorkspaceBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    const detail = error instanceof Error ? error.stack || error.message : typeof error === 'string' ? error : 'Unknown rendering error.';
    return { error: detail.slice(0, 8000) };
  }

  render() {
    if (this.state.error !== null) return <main className="fatal">
      <h1>The workspace couldn’t render.</h1>
      <p>Reload the viewer, then import your files again.</p>
      <button onClick={() => location.reload()}>Reload viewer</button>
      <details><summary>Error details</summary><pre>{this.state.error}</pre></details>
    </main>;
    return this.props.children;
  }
}

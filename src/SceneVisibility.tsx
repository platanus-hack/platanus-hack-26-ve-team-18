import type { ModelPart } from './models';
import { presentationArch, presentationOpacity, type ArchRole } from './presentation';

interface Props {
  parts: ModelPart[];
  opacities: Readonly<Record<string, number>>;
  onOpacity: (arch: ArchRole, opacity: number) => void;
  onReset: () => void;
}

export function SceneVisibility({ parts, opacities, onOpacity, onReset }: Props) {
  const arches = (['upper', 'lower'] as const).filter(role => parts.some(part => part.role === role));
  if (!arches.length) return null;
  return <div className="scene-visibility" role="group" aria-label="Jaw visibility">
    <span className="scene-visibility-title">View</span>
    {arches.map(arch => {
      const group = parts.filter(part => presentationArch(part, parts) === arch);
      const opacity = Math.round(Math.max(...group.map(part => presentationOpacity(part, opacities))) * 100);
      const label = arch === 'upper' ? 'Upper' : 'Lower';
      return <div className="jaw-control" key={arch}>
        <button type="button" aria-pressed={opacity > 0} aria-label={`${opacity > 0 ? 'Hide' : 'Show'} ${arch}`} title={`${opacity > 0 ? 'Set opacity to 0%' : 'Restore opacity to 100%'} · collision analysis stays active`} onClick={() => onOpacity(arch, opacity > 0 ? 0 : 1)}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2"/>{opacity === 0 && <path d="M3 3 17 17"/>}</svg>{label}
        </button>
        <input type="range" min="0" max="100" step="5" value={opacity} aria-label={`${label} opacity`} aria-valuetext={`${opacity}% opacity`} onChange={event => onOpacity(arch, event.target.valueAsNumber / 100)} />
        <output aria-label={`${label} opacity value`}>{opacity}%</output>
      </div>;
    })}
    <button type="button" className="scene-reset" onClick={onReset}>Show all</button>
  </div>;
}

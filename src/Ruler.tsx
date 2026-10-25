import { measurementLabel, type RulerState } from './measurement';
import './ruler.css';

export function RulerOverlay({ ruler, mmPerUnit }: { ruler: RulerState; mmPerUnit: number | null }) {
  const [a, b] = ruler.screenPoints;
  return <svg className="ruler-overlay" aria-hidden="true">
    {a && b && <>
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
      <text x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - 12} textAnchor="middle">{measurementLabel(ruler.distance!, mmPerUnit)}</text>
    </>}
    {ruler.screenPoints.map((point, index) => point && <g key={index}>
      <circle cx={point[0]} cy={point[1]} r="5" />
      <text x={point[0] + 10} y={point[1] + 17}>{index === 0 ? 'A' : 'B'}</text>
    </g>)}
  </svg>;
}

export function RulerReadout({ ruler, mmPerUnit, onClear, onStart }: { ruler: RulerState; mmPerUnit: number | null; onClear: () => void; onStart: () => void }) {
  return <div className="ruler-panel" aria-label="Distance ruler">
    <div className="ruler-result" role="status" aria-live="polite">
      <strong>{ruler.distance !== null ? measurementLabel(ruler.distance, mmPerUnit) : ruler.points.length ? 'Select point B' : ruler.cleared ? 'Measurement cleared — model changed' : 'Select point A'}</strong>
      <span>{ruler.distance !== null ? 'Straight-line distance · A → B' : ruler.enabled ? 'Click two surface points on any teeth or parts.' : 'Choose Measure to continue.'}</span>
    </div>
    {!!ruler.points.length && <p className="ruler-endpoints">{ruler.points.map((point, index) => `${index === 0 ? 'A' : 'B'}: ${point.name}`).join(' · ')}</p>}
    {ruler.screenPoints.some(point => !point) && <p className="ruler-note">Some endpoints are hidden in this view.</p>}
    <p className="ruler-note">{mmPerUnit !== null && Number.isFinite(mmPerUnit) && mmPerUnit > 0 ? `Scan scale: 1 file unit = ${mmPerUnit} mm.` : 'File units; scan scale is unset.'} Direct distance, not a path along the surface or minimum gap.</p>
    <div className="ruler-actions">
      {(ruler.points.length > 0 || ruler.cleared) && <button onClick={onClear}>Clear measurement</button>}
      {ruler.distance !== null && <button onClick={onStart}>New measurement</button>}
    </div>
  </div>;
}

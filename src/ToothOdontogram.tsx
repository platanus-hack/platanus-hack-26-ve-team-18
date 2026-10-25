import type { ToothCase } from './tooth-types';
import type { RestorationAssembly } from './restoration-types';

const UPPER_ARCH = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOWER_ARCH = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

interface ToothOdontogramProps {
  teeth?: ToothCase['teeth'];
  assemblies?: RestorationAssembly[];
  selectedFdi: number | null;
  onSelectFdi: (fdi: number) => void;
}

export function ToothOdontogram({
  teeth = {},
  assemblies = [],
  selectedFdi,
  onSelectFdi,
}: ToothOdontogramProps) {
  const isPlanned = (fdi: number) => {
    return assemblies.some(a => a.spec.fdi === fdi) || teeth[fdi]?.restoration === 'implant';
  };

  const isMissing = (fdi: number) => {
    return teeth[fdi]?.status === 'missing';
  };

  const isPresent = (fdi: number) => {
    return teeth[fdi]?.status === 'present';
  };

  const isThirdMolar = (fdi: number) => {
    return fdi % 10 === 8;
  };

  return (
    <div className="odontogram-container" aria-label="Odontograma interactivo FDI">
      <div className="odontogram-header">
        <div className="odontogram-title">
          <span>Odontograma</span>
          <span className="odontogram-badge">FDI</span>
        </div>
        <div className="odontogram-legend">
          <span className="legend-item"><i className="dot present" /> Presente</span>
          <span className="legend-item"><i className="dot missing" /> Ausente</span>
          <span className="legend-item"><i className="dot planned" /> Planificado</span>
        </div>
      </div>

      <div className="odontogram-scroll-wrapper">
        <div className="odontogram-rows">
          {[UPPER_ARCH, LOWER_ARCH].map((arch, rowIndex) => (
            <div className={`arch-row row-${rowIndex === 0 ? 'upper' : 'lower'}`} key={rowIndex}>
              <span className="arch-indicator">{rowIndex === 0 ? 'SUP' : 'INF'}</span>
              <div className="teeth-list">
                {arch.map((fdi, index) => {
                  const planned = isPlanned(fdi);
                  const missing = isMissing(fdi);
                  const present = isPresent(fdi);
                  const third = isThirdMolar(fdi);
                  const status = planned
                    ? 'planned'
                    : missing
                    ? 'missing'
                    : present
                    ? 'present'
                    : third
                    ? 'third-molar'
                    : 'neutral';
                  const isSelected = selectedFdi === fdi;
                  const isMolar = fdi % 10 >= 6;
                  const isCanine = fdi % 10 === 3;

                  return (
                    <button
                      key={fdi}
                      type="button"
                      className={`tooth-btn status-${status} ${isSelected ? 'selected' : ''} ${index === 7 ? 'midline-right' : ''}`}
                      onClick={() => onSelectFdi(fdi)}
                      aria-pressed={isSelected}
                      title={`Diente FDI ${fdi} · ${planned ? 'Implante planificado' : missing ? 'Ausente' : present ? 'Presente' : 'Diente natural'}`}
                      aria-label={`Diente FDI ${fdi}`}
                    >
                      <span className="tooth-fdi-label">{fdi}</span>
                      <svg viewBox="0 0 30 32" className="tooth-svg" aria-hidden="true">
                        <path
                          d={
                            isMolar
                              ? "M8 3Q3 3 3 10L4 23Q4 29 10 29L20 29Q26 29 26 23L27 10Q27 3 21 3L16 5L13 4Z"
                              : isCanine
                                ? "M15 2Q6 2 5 10L7 24Q8 29 15 30Q22 29 23 24L25 10Q24 2 15 2Z"
                                : "M9 3Q5 3 5 9L7 25Q8 29 15 29Q22 29 23 25L25 9Q25 3 21 3Z"
                          }
                        />
                        {isMolar ? (
                          <path className="tooth-groove" d="M8 10q7 9 14 0M15 8v17M9 21q6-7 12 0" />
                        ) : (
                          <path className="tooth-groove" d="M9 9q6 4 12 0M10 22q5-3 10 0" />
                        )}
                        {planned && <circle className="plan-marker" cx="24" cy="6" r="3.5" />}
                      </svg>
                    </button>
                  );
                })}
              </div>
              <span className="arch-side-label">{rowIndex === 0 ? 'D' : 'I'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

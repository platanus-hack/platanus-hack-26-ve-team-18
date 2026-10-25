import { useState, useMemo } from 'react';
import type { ModelPart } from './models';
import type { ToothCase } from './tooth-types';
import type { RestorationAssembly } from './restoration-types';
import { Viewport } from './Viewport';
import { ToothOdontogram } from './ToothOdontogram';
import { toothArch, toothName } from './teeth';
import './patient-view.css';

interface PatientViewProps {
  parts: ModelPart[];
  referenceParts?: ModelPart[];
  opacities: Readonly<Record<string, number>>;
  toothData: ToothCase;
  assemblies: RestorationAssembly[];
  selectedFdi: number | null;
  onSelectTooth: (fdi: number) => void;
  onClose: () => void;
}

export function toothNameEs(code: number): string {
  const quad = Math.floor(code / 10);
  const pos = code % 10;
  const names = [
    'Incisivo Central',
    'Incisivo Lateral',
    'Canino',
    'Primer Premolar',
    'Segundo Premolar',
    'Primer Molar',
    'Segundo Molar',
    'Tercer Molar (Muela del Juicio)',
  ];
  const side = quad === 1 || quad === 4 ? 'Derecho' : 'Izquierdo';
  const arch = code < 30 ? 'Superior' : 'Inferior';
  return `${names[pos - 1]} ${arch} ${side}`;
}

export function PatientView({
  parts,
  referenceParts = [],
  opacities: initialOpacities,
  toothData,
  assemblies,
  selectedFdi,
  onSelectTooth,
  onClose,
}: PatientViewProps) {
  // Layer visibility toggles
  const [showArch, setShowArch] = useState(true);
  const [showCrown, setShowCrown] = useState(true);
  const [showImplant, setShowImplant] = useState(true);
  const [showBone, setShowBone] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);

  // Default to first planned tooth or FDI 21 / 11 if none selected
  const activeFdi = useMemo(() => {
    if (selectedFdi && selectedFdi >= 11 && selectedFdi <= 48) return selectedFdi;
    const firstAssembly = assemblies[0]?.spec.fdi;
    if (firstAssembly) return firstAssembly;
    const firstMissing = Object.entries(toothData.teeth).find(([, r]) => r.status === 'missing');
    if (firstMissing) return Number(firstMissing[0]);
    return 21; // Default friendly upper central incisor
  }, [selectedFdi, assemblies, toothData.teeth]);

  // Find restoration assembly for the active tooth if any
  const assembly = useMemo(() => {
    return assemblies.find(a => a.spec.fdi === activeFdi);
  }, [assemblies, activeFdi]);

  const toothRecord = toothData.teeth[activeFdi];
  const isPlanned = !!assembly || toothRecord?.restoration === 'implant';
  const isMissing = toothRecord?.status === 'missing';
  const isPresent = toothRecord?.status === 'present';

  // Compute customized opacities for patient view layers
  const computedOpacities = useMemo(() => {
    const next: Record<string, number> = { ...initialOpacities };

    parts.forEach(part => {
      const isRestoration = part.id.includes('restoration') || part.restoration;
      const component = part.restoration?.component;

      if (!isRestoration) {
        next[part.id] = showArch ? (initialOpacities[part.id] ?? 1) : 0;
      } else if (component === 'crown') {
        next[part.id] = showCrown ? 1 : 0;
      } else {
        // fixture or abutment
        next[part.id] = showImplant ? 1 : 0;
      }
    });

    referenceParts.forEach(refPart => {
      next[refPart.id] = showBone ? (initialOpacities[refPart.id] ?? 0.5) : 0;
    });

    return next;
  }, [parts, referenceParts, initialOpacities, showArch, showCrown, showImplant, showBone]);

  const handleShare = () => {
    const url = new URL(window.location.href);
    url.hash = 'patient';
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    });
  };

  const whatsappMessage = encodeURIComponent(
    `Hola, estuve revisando mi plan de tratamiento 3D de Platanus Dental para el diente FDI ${activeFdi} (${toothNameEs(activeFdi)}). Quisiera coordinar los siguientes pasos.`
  );

  return (
    <div className="patient-container" aria-label="Portal de Consulta del Paciente">
      {/* Top Bar */}
      <header className="patient-topbar">
        <div className="patient-topbar-left">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>
              Platanus Dental <span className="brand-divider">/</span> <strong>Consulta 3D</strong>
            </span>
          </div>
          <div className="patient-title-group">
            <h1>Plan de Tratamiento y Restauración Guiada</h1>
            <p className="patient-subtitle">
              Visualización 3D interactiva para el paciente · Planificación asistida por IA y CBCT
            </p>
          </div>
        </div>

        <div className="patient-topbar-actions">
          <button
            type="button"
            className="patient-btn patient-btn-outline"
            onClick={handleShare}
            title="Copiar enlace para el paciente"
          >
            {copiedLink ? '✓ Enlace Copiado' : '🔗 Compartir Enlace'}
          </button>
          <a
            href={`https://wa.me/?text=${whatsappMessage}`}
            target="_blank"
            rel="noopener noreferrer"
            className="patient-btn patient-btn-whatsapp"
            style={{ textDecoration: 'none' }}
          >
            💬 Contactar por WhatsApp
          </a>
          <button
            type="button"
            className="patient-btn patient-btn-outline"
            onClick={onClose}
          >
            🩺 Modo Especialista
          </button>
        </div>
      </header>

      {/* Main Grid: Left 3D Viewport, Right Consultation Details */}
      <main className="patient-content-grid">
        {/* Left Column: 3D View */}
        <section className="patient-stage-card" aria-label="Visualizador 3D">
          <div className="stage-header">
            <span className="stage-title">
              <span className="dot present" />
              Modelo Digital Tridimensional
            </span>
            <div className="stage-controls">
              <span className="patient-subtitle">
                {parts.length} estructuras dentales cargadas
              </span>
            </div>
          </div>

          <div className="stage-viewport-wrapper">
            <Viewport
              parts={parts}
              referenceParts={referenceParts}
              opacities={computedOpacities}
              report={null}
              tolerance={0.2}
              selected={null}
              heatmap={false}
              wireframe={false}
              onProbe={() => {}}
              onImport={() => {}}
              compact={false}
            />
            <div className="stage-hint-badge">
              Gira con clic izquierdo · Zoom con rueda · Desplaza con clic derecho
            </div>
          </div>

          {/* Layer toggles */}
          <div className="stage-layers-bar" aria-label="Capas visibles">
            <span style={{ fontWeight: 600, marginRight: 4 }}>Capas:</span>
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={showArch}
                onChange={e => setShowArch(e.target.checked)}
              />
              <span className="layer-swatch teeth" />
              Tus dientes
            </label>
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={showCrown}
                onChange={e => setShowCrown(e.target.checked)}
              />
              <span className="layer-swatch crown" />
              Corona de circonio
            </label>
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={showImplant}
                onChange={e => setShowImplant(e.target.checked)}
              />
              <span className="layer-swatch implant" />
              Implante de titanio
            </label>
            {referenceParts.length > 0 && (
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={showBone}
                  onChange={e => setShowBone(e.target.checked)}
                />
                <span className="layer-swatch bone" />
                Hueso alveolar (CBCT)
              </label>
            )}
          </div>
        </section>

        {/* Right Column: Odontogram & Treatment Card */}
        <aside className="patient-details-card" aria-label="Detalles de la Consulta">
          {/* Odontogram Card */}
          <div className="consult-card">
            <ToothOdontogram
              teeth={toothData.teeth}
              assemblies={assemblies}
              selectedFdi={activeFdi}
              onSelectFdi={onSelectTooth}
            />
          </div>

          {/* Tooth Treatment Detail Card */}
          <div className="consult-card tooth-detail-card">
            <div className="detail-header-row">
              <div>
                <span className="patient-subtitle">Diente seleccionado</span>
                <h2 className="tooth-name-title">
                  FDI {activeFdi} · {toothNameEs(activeFdi)}
                </h2>
              </div>
              <span
                className={`tooth-status-pill ${
                  isPlanned ? 'planned' : isMissing ? 'missing' : 'present'
                }`}
              >
                {isPlanned ? 'Implante Planificado' : isMissing ? 'Espacio Ausente' : 'Diente Natural'}
              </span>
            </div>

            {isPlanned ? (
              <div className="procedure-summary-box">
                <div className="procedure-badge">
                  <span>✦</span> Restauración Fija Guiada por Computadora
                </div>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
                  Se ha planificado la colocación de un implante dental de titanio de alta precisión,
                  acompañado de una corona anatómica de circonio estético personalizada a tu mordida.
                </p>

                {assembly && (
                  <dl className="spec-list">
                    <div className="spec-item">
                      <dt>Fijación Ósea</dt>
                      <dd>Titanio biocompatible</dd>
                    </div>
                    <div className="spec-item">
                      <dt>Corona Definitiva</dt>
                      <dd>Circonio monolítico</dd>
                    </div>
                    <div className="spec-item">
                      <dt>Emergencia Gingival</dt>
                      <dd>Perfil estético natural</dd>
                    </div>
                    <div className="spec-item">
                      <dt>Cirugía Guiada</dt>
                      <dd>CBCT 3D milimétrico</dd>
                    </div>
                  </dl>
                )}
              </div>
            ) : isMissing ? (
              <div className="procedure-summary-box">
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
                  Este diente se encuentra actualmente ausente. La rehabilitación con un implante dental
                  evitará la pérdida de hueso y devolverá la función masticatoria óptima.
                </p>
              </div>
            ) : (
              <div className="procedure-summary-box">
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
                  Diente natural evaluado. Se encuentra en correcta alineación y no requiere intervención quirúrgica.
                </p>
              </div>
            )}

            {/* Timeline */}
            <div className="treatment-timeline">
              <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase' }}>
                Fases del Tratamiento
              </span>
              <div className="timeline-step completed">
                <div className="step-num">1</div>
                <div className="step-info">
                  <span className="step-title">Diagnóstico Digital 3D</span>
                  <span className="step-desc">Escaneo intraoral de alta definición y análisis de CBCT completados.</span>
                </div>
              </div>
              <div className="timeline-step current">
                <div className="step-num">2</div>
                <div className="step-info">
                  <span className="step-title">Colocación Quirúrgica Guiada</span>
                  <span className="step-desc">Fijación del implante de titanio con guía quirúrgica milimétrica mínimamente invasiva.</span>
                </div>
              </div>
              <div className="timeline-step">
                <div className="step-num">3</div>
                <div className="step-info">
                  <span className="step-title">Corona Estética Definitiva</span>
                  <span className="step-desc">Ajuste de la corona de circonio con color y textura idénticos a tus dientes naturales.</span>
                </div>
              </div>
            </div>

            {/* Clinic Card */}
            <div className="clinic-contact-card">
              <h3>¿Tienes dudas sobre tu procedimiento?</h3>
              <p>
                Tu especialista ha preparado esta simulación para garantizar el mejor resultado estético y funcional.
                Escríbenos para confirmar tu fecha quirúrgica o resolver inquietudes.
              </p>
              <a
                href={`https://wa.me/?text=${whatsappMessage}`}
                target="_blank"
                rel="noopener noreferrer"
                className="patient-btn patient-btn-whatsapp"
                style={{ textDecoration: 'none', alignSelf: 'flex-start' }}
              >
                💬 Chatear con mi Clínica
              </a>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

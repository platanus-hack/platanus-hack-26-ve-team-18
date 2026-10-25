import { useState, useMemo, useEffect } from 'react';
import type { ModelPart, Vec3 } from './models';
import type { ToothCase } from './tooth-types';
import type { RestorationAssembly, RestorationSpec } from './restoration-types';
import { Viewport } from './Viewport';
import { ToothOdontogram } from './ToothOdontogram';
import { toothName } from './teeth';
import { generateRestoration } from './restoration-geometry';
import { importModels } from './import-models';
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

const THETA = 0.165;
const COS_T = Math.cos(THETA);
const SIN_T = Math.sin(THETA);

const DEMO_SPEC: RestorationSpec = {
  version: 'implant-assembly/v1',
  fdi: 21,
  parentPartId: 'upper',
  anatomy: 'incisor',
  frame: {
    origin: [2.5, -21.5, 7.8] as Vec3,
    u: [1, 0, 0] as Vec3,
    v: [0, -COS_T, SIN_T] as Vec3,
    up: [0, -SIN_T, -COS_T] as Vec3,
  },
  anatomicalSigns: { mesial: -1, buccal: 1 },
  parameters: {
    fixture: { radius: 1.9, length: 11.5, depth: 1.5, taper: 0.15 },
    abutment: { radius: 1.7, height: 1.6, emergenceRadius: 2.0, angleX: 0, angleY: 0 },
    crown: { width: 8.0, depth: 6.8, height: 8.0, cuspHeight: 0.5, rotation: 0 },
  },
  provenance: 'clinician-entered',
  units: 'file units (u)',
  source: 'Demo patient restoration',
};

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
  const isDemoMode = parts.length === 0;

  // Layer visibility toggles
  const [showArch, setShowArch] = useState(true);
  const [showCrown, setShowCrown] = useState(true);
  const [showImplant, setShowImplant] = useState(true);
  const [showBone, setShowBone] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);
  const [demoArchParts, setDemoArchParts] = useState<ModelPart[]>([]);
  const [loadingMeshes, setLoadingMeshes] = useState(isDemoMode);

  // Default patient info
  const patientName = isDemoMode ? 'Sofia M.' : 'Paciente';
  const caseId = isDemoMode ? 'PLT-2026-084' : 'CASO-ACTIVO';
  const doctorNote = isDemoMode
    ? 'Evaluación y diagnóstico digital 3D de tus arcadas dentales. Ambas arcadas (superior e inferior) presentan adecuada alineación anatómica, contactos oclusales estables y tejidos gingivales saludables. Se recomienda mantener tu rutina de higiene y realizar control preventivo periódico.'
    : 'Evaluación y registro clínico digital de tus arcadas dentales.';

  const [internalSelectedFdi, setInternalSelectedFdi] = useState<number | null>(selectedFdi ?? 21);

  // In demo mode, load full upper and lower arches with realistic UV textures
  useEffect(() => {
    if (!isDemoMode) return;
    let cancelled = false;
    setLoadingMeshes(true);

    Promise.all([
      fetch('/patient-demo/upper.ply')
        .then(r => r.blob())
        .then(b => new File([b], 'upper.ply', { type: 'application/octet-stream' })),
      fetch('/patient-demo/upper.jpg')
        .then(r => r.blob())
        .then(b => new File([b], 'upper.jpg', { type: 'image/jpeg' })),
      fetch('/patient-demo/lower.ply')
        .then(r => r.blob())
        .then(b => new File([b], 'lower.ply', { type: 'application/octet-stream' })),
      fetch('/patient-demo/lower.jpg')
        .then(r => r.blob())
        .then(b => new File([b], 'lower.jpg', { type: 'image/jpeg' })),
    ])
      .then(files => importModels(files))
      .then(res => {
        if (!cancelled && res && res.parts.length > 0) {
          const tagged = res.parts.map(p => ({
            ...p,
            role: (p.name.includes('upper') ? 'upper' : 'lower') as 'upper' | 'lower',
          }));
          setDemoArchParts(tagged);
        }
      })
      .catch(err => {
        console.warn('Demo arches could not be loaded:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingMeshes(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);

  // Construct active parts for 3D viewing (in demo mode, render the clean textured dental arches)
  const activeParts = useMemo(() => {
    if (!isDemoMode) return parts;
    return demoArchParts;
  }, [isDemoMode, parts, demoArchParts]);

  // Synthetic tooth case for demo
  const effectiveTeeth = useMemo(() => {
    if (!isDemoMode && Object.keys(toothData.teeth).length > 0) return toothData.teeth;
    const teethMap: ToothCase['teeth'] = {};
    for (let fdi = 11; fdi <= 48; fdi++) {
      if (fdi % 10 >= 1 && fdi % 10 <= 8) {
        if (fdi % 10 === 8) {
          teethMap[fdi] = { status: 'unreviewed', restoration: 'none', note: 'Tercer molar ausente' };
        } else {
          teethMap[fdi] = { status: 'present', restoration: 'none', note: 'Diente natural sano' };
        }
      }
    }
    return teethMap;
  }, [isDemoMode, toothData.teeth]);

  // Default to FDI 21 or selected
  const activeFdi = (selectedFdi && selectedFdi >= 11 && selectedFdi <= 48)
    ? selectedFdi
    : (internalSelectedFdi && internalSelectedFdi >= 11 && internalSelectedFdi <= 48)
    ? internalSelectedFdi
    : 21;

  const handleSelectTooth = (fdi: number | null) => {
    setInternalSelectedFdi(fdi);
    if (fdi !== null) onSelectTooth?.(fdi);
  };

  // Selected tooth properties
  const isSelectedPlanned = activeParts.some(p => p.restoration && p.id.includes(String(activeFdi)));
  const isSelectedMissing = effectiveTeeth[activeFdi]?.status === 'missing';
  const isSelectedPresent = effectiveTeeth[activeFdi]?.status === 'present';

  // Compute customized opacities for layers
  const computedOpacities = useMemo(() => {
    const next: Record<string, number> = { ...initialOpacities };

    activeParts.forEach(part => {
      const isRestoration = part.id.includes('restoration') || part.id.startsWith('demo-') || part.restoration;
      const component = part.restoration?.component;

      if (!isRestoration) {
        next[part.id] = showArch ? (initialOpacities[part.id] ?? 0.85) : 0;
      } else if (component === 'crown') {
        next[part.id] = showCrown ? 1 : 0;
      } else {
        next[part.id] = showImplant ? 1 : 0;
      }
    });

    referenceParts.forEach(refPart => {
      next[refPart.id] = showBone ? (initialOpacities[refPart.id] ?? 0.5) : 0;
    });

    return next;
  }, [activeParts, referenceParts, initialOpacities, showArch, showCrown, showImplant, showBone]);

  const handleShare = () => {
    const url = new URL(window.location.href);
    url.hash = 'patient';
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    });
  };

  const whatsappMessage = encodeURIComponent(
    `Hola, soy ${patientName} y estuve revisando mi informe dental 3D de Céflow Dental (Caso ${caseId}). Quisiera coordinar mi cita de control preventivo.`
  );

  return (
    <div className="patient-medical-page" aria-label="Informe Clínico del Paciente">
      {/* Top Clinical Header Bar */}
      <div className="patient-nav-bar">
        <div className="patient-nav-inner">
          <div className="patient-brand-tag">
            <span className="brand-dot" />
            <span>PLATANUS DENTAL</span>
          </div>
          <div className="patient-nav-actions">
            <button type="button" className="btn-patient-ghost" onClick={handleShare}>
              {copiedLink ? '✓ Enlace Copiado' : '🔗 Compartir'}
            </button>
            <button type="button" className="btn-patient-doctor" onClick={onClose}>
              🩺 Modo Doctor
            </button>
          </div>
        </div>
      </div>

      {/* Main Single-Column Medical Sheet (Hoja Médica) */}
      <main className="patient-shell">
        {/* Document Header */}
        <header className="patient-header">
          <span className="patient-brand">PLATANUS DENTAL · INFORME CLÍNICO 3D</span>
          <h1>Informe para {patientName}</h1>
          <p>
            Caso #{caseId} · Compartido el 24 de octubre de 2026 · Planificación digital preliminar.
            No sustituye una consulta presencial.
          </p>
        </header>

        {/* Card 1: Notas de tu dentista */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">📝</span>
            Notas de tu dentista
          </h2>
          <p className="patient-note">{doctorNote}</p>
        </section>

        {/* Card 2: Tu revisión en fotos */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">📸</span>
            Tu revisión en fotos
          </h2>
          <div className="patient-photos">
            <figure>
              <img src="/patient-demo/photo-frontal.jpg" alt="Fotografía clínica frontal de tu boca" />
              <figcaption>Vista Frontal</figcaption>
            </figure>
            <figure>
              <img src="/patient-demo/photo-upper.jpg" alt="Fotografía oclusal de tu arcada superior" />
              <figcaption>Arcada Superior</figcaption>
            </figure>
            <figure>
              <img src="/patient-demo/photo-lower.jpg" alt="Fotografía oclusal de tu arcada inferior" />
              <figcaption>Arcada Inferior</figcaption>
            </figure>
          </div>
        </section>

        {/* Card 3: Tu odontograma */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">🦷</span>
            Tu odontograma
          </h2>
          <ToothOdontogram
            teeth={effectiveTeeth}
            assemblies={assemblies}
            selectedFdi={activeFdi}
            onSelectFdi={handleSelectTooth}
          />
          <div className="tooth-detail">
            <strong>
              Diente FDI {activeFdi} · {toothNameEs(activeFdi)}
              <span
                className={`status-chip ${
                  isSelectedPlanned ? 'planned' : isSelectedMissing ? 'missing' : 'present'
                }`}
              >
                {isSelectedPlanned
                  ? 'Plan de tratamiento'
                  : isSelectedMissing
                  ? 'Ausente estimado'
                  : 'Presente natural'}
              </span>
            </strong>
            <p className="tooth-quote">
              “Pieza dental natural en posición anatómica armónica, con esmalte íntegro y adecuada función oclusal en tu mordida.”
            </p>
          </div>
        </section>

        {/* Card 4: Tu modelo 3D interactivo */}
        <section className="patient-card patient-3d-card">
          <h2>
            <span className="card-icon">🧊</span>
            Tu modelo 3D interactivo
          </h2>
          <p className="patient-hint">
            Explora tu boca en 3D. Usa un dedo o el ratón para rotar, y pellizca para hacer zoom.
          </p>

          <div className="patient-viewport-box">
            {loadingMeshes && (
              <div className="patient-loading-overlay">
                <span className="spinner" />
                <span>Cargando modelo 3D de alta definición…</span>
              </div>
            )}
            <Viewport
              parts={activeParts}
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
          </div>

          {/* Layer toggles */}
          <div className="patient-layers-row">
            <label className="layer-item">
              <input
                type="checkbox"
                checked={showArch}
                onChange={e => setShowArch(e.target.checked)}
              />
              <span className="swatch arch" />
              Tus dientes ({activeParts.filter(p => !p.id.startsWith('demo-')).length ? 'Arcadas completas' : 'Modelo dental'})
            </label>
            {activeParts.some(p => p.restoration?.component === 'crown') && (
              <label className="layer-item">
                <input
                  type="checkbox"
                  checked={showCrown}
                  onChange={e => setShowCrown(e.target.checked)}
                />
                <span className="swatch crown" />
                Corona de circonio
              </label>
            )}
            {activeParts.some(p => p.restoration?.component === 'fixture') && (
              <label className="layer-item">
                <input
                  type="checkbox"
                  checked={showImplant}
                  onChange={e => setShowImplant(e.target.checked)}
                />
                <span className="swatch implant" />
                Implante de titanio
              </label>
            )}
          </div>
        </section>

        {/* Card 5: Tu evaluación diagnóstica */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">📋</span>
            Tu evaluación diagnóstica
          </h2>
          <div className="plan-list">
            <div>
              <strong>Diagnóstico Oclusal & Escaneo 3D</strong>
              <small>Arcadas superior e inferior registradas con máxima precisión en oclusión habitual</small>
            </div>
            <div>
              <strong>Evaluación Periodontal & Estética</strong>
              <small>Márgenes gingivales íntegros sin signos inflamatorios o recesión patológica</small>
            </div>
            <div>
              <strong>Protocolo Preventivo & Mantenimiento</strong>
              <small>Preservación de esmalte natural y control preventivo semestral recomendado</small>
            </div>
          </div>
          <p className="patient-hint">
            Métricas de tu caso: Arcada superior 78.4 mm · Distancia intercanina 34.2 mm · Oclusión estable.
          </p>
        </section>

        {/* Card 6: Fases de seguimiento preventivo */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">⏱️</span>
            Fases de seguimiento preventivo
          </h2>
          <div className="timeline-steps">
            <div className="timeline-item done">
              <span className="step-circle">1</span>
              <div>
                <strong>Escaneo Intraoral 3D & Fotografía Clínica</strong>
                <p>Digitalización fotorealista completa de arcadas y mordida completada.</p>
              </div>
            </div>
            <div className="timeline-item current">
              <span className="step-circle">2</span>
              <div>
                <strong>Análisis Funcional y Oclusal</strong>
                <p>Verificación de guías caninas, contactos interproximales y dinámica masticatoria.</p>
              </div>
            </div>
            <div className="timeline-item">
              <span className="step-circle">3</span>
              <div>
                <strong>Control Periódico y Limpieza Profesional</strong>
                <p>Cita de seguimiento preventivo recomendada en 6 meses para preservar tu sonrisa.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Card 7: WhatsApp Contact */}
        <section className="patient-card whatsapp-card">
          <h2>
            <span className="card-icon">💬</span>
            ¿Tienes dudas sobre tu revisión?
          </h2>
          <p className="patient-note">
            Tu odontólogo especialista ha preparado este informe digital para que conozcas tu salud dental. Si
            deseas agendar tu cita de control preventivo o hacer alguna pregunta, contáctanos directamente.
          </p>
          <a
            href={`https://wa.me/?text=${whatsappMessage}`}
            target="_blank"
            rel="noopener noreferrer"
            className="whatsapp-btn"
          >
            <span>💬</span> Escribe a tu clínica por WhatsApp
          </a>
        </section>

        {/* Footer */}
        <footer className="patient-footer">
          <span>Céflow Dental · Planificación Digital 3D</span>
          <span>·</span>
          <button type="button" className="btn-link" onClick={onClose}>
            Modo Especialista
          </button>
        </footer>
      </main>
    </div>
  );
}

import { useState, useMemo, useEffect } from 'react';
import type { ModelPart, Vec3 } from './models';
import type { ToothCase } from './tooth-types';
import type { RestorationAssembly, RestorationSpec } from './restoration-types';
import { Viewport } from './Viewport';
import { ToothOdontogram } from './ToothOdontogram';
import { toothArch, toothName } from './teeth';
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

const DEMO_SPEC: RestorationSpec = {
  version: 'implant-assembly/v1',
  fdi: 21,
  parentPartId: 'upper-arch',
  anatomy: 'incisor',
  frame: {
    origin: [0, 0, 0] as Vec3,
    u: [1, 0, 0] as Vec3,
    v: [0, 1, 0] as Vec3,
    up: [0, 0, 1] as Vec3,
  },
  parameters: {
    fixture: { radius: 1.9, length: 11.5, depth: 1.5, taper: 0.15 },
    abutment: { radius: 1.7, height: 2.5, emergenceRadius: 2.1, angleX: 0, angleY: 0 },
    crown: { width: 8.5, depth: 7.2, height: 10.0, cuspHeight: 1.2, rotation: 0 },
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

  // Default patient info
  const patientName = isDemoMode ? 'Sofia M.' : 'Paciente';
  const caseId = isDemoMode ? 'PLT-2026-084' : 'CASO-ACTIVO';
  const doctorNote = isDemoMode
    ? 'Evaluación y planificación para rehabilitación de pieza dental en sector anterosuperior (diente FDI 21). El reborde alveolar presenta adecuada disponibilidad ósea en el estudio tomográfico CBCT. Se planificó la colocación de un implante cónico de titanio biocompatible con carga diferida y la posterior confección de una corona estética de circonio anatómico con perfil de emergencia natural.'
    : 'Planificación de tratamiento dental y rehabilitación personalizada.';

  // In demo mode, load sample bite arch
  useEffect(() => {
    if (!isDemoMode) return;
    let cancelled = false;
    fetch('/patient-demo/bite1.ply')
      .then(res => {
        if (!res.ok) throw new Error('No se pudo cargar la arcada de demostración');
        return res.blob();
      })
      .then(blob => {
        if (cancelled) return;
        const file = new File([blob], 'bite1.ply', { type: 'application/octet-stream' });
        return importModels([file]);
      })
      .then(res => {
        if (!cancelled && res && res.parts.length > 0) {
          setDemoArchParts(res.parts.map(p => ({ ...p, role: 'upper' as const })));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);

  // Construct active parts for 3D viewing
  const activeParts = useMemo(() => {
    if (!isDemoMode) return parts;

    // Generate demo 3D restoration parts (fixture, abutment, crown for FDI 21)
    const demoMeshes = generateRestoration(DEMO_SPEC);
    const generatedParts: ModelPart[] = demoMeshes.map(mesh => ({
      id: `demo-${mesh.component}`,
      name:
        mesh.component === 'crown'
          ? 'Corona de circonio FDI 21'
          : mesh.component === 'abutment'
          ? 'Pilar protésico'
          : 'Implante de titanio Ø3.8×11.5mm',
      fileName: `demo-${mesh.component}.stl`,
      positions: mesh.positions,
      normals: mesh.normals,
      triangles: mesh.triangles,
      vertices: mesh.vertices,
      closed: mesh.closed,
      dimensions: mesh.dimensions,
      offset: [0, 0, 0] as Vec3,
      rotation: [0, 0, 0] as Vec3,
      visible: true,
      restoration: {
        component: mesh.component,
        assemblyId: 'demo-assembly',
        parentPartId: 'upper-arch',
      },
    }));

    return [...demoArchParts, ...generatedParts];
  }, [isDemoMode, parts, demoArchParts]);

  // Synthetic tooth case for demo
  const effectiveTeeth = useMemo(() => {
    if (!isDemoMode && Object.keys(toothData.teeth).length > 0) return toothData.teeth;
    const teethMap: ToothCase['teeth'] = {};
    for (let fdi = 11; fdi <= 48; fdi++) {
      if (fdi % 10 >= 1 && fdi % 10 <= 8) {
        if (fdi === 21) {
          teethMap[fdi] = { status: 'missing', restoration: 'implant', note: 'Implante planificado' };
        } else if (fdi % 10 === 8) {
          teethMap[fdi] = { status: 'unreviewed', restoration: 'none', note: 'Tercer molar ausente' };
        } else {
          teethMap[fdi] = { status: 'present', restoration: 'none', note: '' };
        }
      }
    }
    return teethMap;
  }, [isDemoMode, toothData.teeth]);

  // Default to FDI 21 or selected
  const activeFdi = selectedFdi && selectedFdi >= 11 && selectedFdi <= 48 ? selectedFdi : 21;

  // Selected tooth properties
  const isSelectedPlanned = activeFdi === 21 || effectiveTeeth[activeFdi]?.restoration === 'implant';
  const isSelectedMissing = effectiveTeeth[activeFdi]?.status === 'missing';
  const isSelectedPresent = effectiveTeeth[activeFdi]?.status === 'present';

  // Compute customized opacities for layers
  const computedOpacities = useMemo(() => {
    const next: Record<string, number> = { ...initialOpacities };

    activeParts.forEach(part => {
      const isRestoration = part.id.includes('restoration') || part.id.startsWith('demo-') || part.restoration;
      const component = part.restoration?.component;

      if (!isRestoration) {
        next[part.id] = showArch ? (initialOpacities[part.id] ?? 1) : 0;
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
    `Hola, soy ${patientName} y estuve revisando mi informe dental 3D de Platanus Dental (Caso ${caseId}) para el diente FDI ${activeFdi} (${toothNameEs(activeFdi)}). Quisiera coordinar los siguientes pasos.`
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
              <img src="/patient-demo/frontal.jpg" alt="Fotografía clínica frontal de tu boca" />
              <figcaption>Vista Frontal</figcaption>
            </figure>
            <figure>
              <img src="/patient-demo/upper.jpg" alt="Fotografía oclusal de tu arcada superior" />
              <figcaption>Arcada Superior</figcaption>
            </figure>
            <figure>
              <img src="/patient-demo/lower.jpg" alt="Fotografía oclusal de tu arcada inferior" />
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
            onSelectFdi={onSelectTooth}
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
                  ? 'Plan de implante'
                  : isSelectedMissing
                  ? 'Ausente estimado'
                  : 'Presente natural'}
              </span>
            </strong>
            {isSelectedPlanned ? (
              <p className="tooth-quote">
                “Pieza planificada para rehabilitación con implante cónico de titanio grado 4 y corona
                anatómica de circonio estético personalizada a tu mordida.”
              </p>
            ) : isSelectedMissing ? (
              <p className="tooth-quote">“Espacio edéntulo evaluado para posible restauración protésica.”</p>
            ) : (
              <p className="tooth-quote">“Diente natural sano sin necesidad de intervención invasiva.”</p>
            )}
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
              Tus dientes
            </label>
            <label className="layer-item">
              <input
                type="checkbox"
                checked={showCrown}
                onChange={e => setShowCrown(e.target.checked)}
              />
              <span className="swatch crown" />
              Corona de circonio
            </label>
            <label className="layer-item">
              <input
                type="checkbox"
                checked={showImplant}
                onChange={e => setShowImplant(e.target.checked)}
              />
              <span className="swatch implant" />
              Implante de titanio
            </label>
          </div>
        </section>

        {/* Card 5: Tu plan */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">📋</span>
            Tu plan de tratamiento
          </h2>
          <div className="plan-list">
            <div>
              <strong>Implante FDI 21</strong>
              <small>Incisivo Central Superior Izquierdo · Ø3.8 × 11.5 mm (Titanio)</small>
            </div>
            <div>
              <strong>Pilar Protésico Anatómico</strong>
              <small>Conexión cónica interna anti-rotacional · Altura 2.5 mm</small>
            </div>
            <div>
              <strong>Corona Definitiva Estética</strong>
              <small>Circonio monolítico de alta translucidez · FDI 21</small>
            </div>
          </div>
          <p className="patient-hint">
            Métricas de tu caso: Arcada superior 78.4 mm · Distancia intercanina 34.2 mm · Oclusión estable.
          </p>
        </section>

        {/* Card 6: Fases del procedimiento */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">⏱️</span>
            Fases del procedimiento
          </h2>
          <div className="timeline-steps">
            <div className="timeline-item done">
              <span className="step-circle">1</span>
              <div>
                <strong>Diagnóstico Digital 3D & CBCT</strong>
                <p>Escaneo intraoral de alta definición y verificación tomográfica completada.</p>
              </div>
            </div>
            <div className="timeline-item current">
              <span className="step-circle">2</span>
              <div>
                <strong>Cirugía Guiada Mínimamente Invasiva</strong>
                <p>Fijación del implante de titanio mediante férula quirúrgica de precisión milimétrica.</p>
              </div>
            </div>
            <div className="timeline-item">
              <span className="step-circle">3</span>
              <div>
                <strong>Corona Estética Definitiva</strong>
                <p>Colocación de la corona de circonio translúcido con textura y color idénticos a tus dientes.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Card 7: WhatsApp Contact */}
        <section className="patient-card whatsapp-card">
          <h2>
            <span className="card-icon">💬</span>
            ¿Tienes dudas sobre tu plan?
          </h2>
          <p className="patient-note">
            Tu odontólogo especialista ha preparado este informe digital para que conozcas cada detalle. Si
            deseas agendar tu cita quirúrgica o hacer alguna pregunta, contáctanos directamente.
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
          <span>Platanus Dental v2 · Planificación Digital 3D</span>
          <span>·</span>
          <button type="button" className="btn-link" onClick={onClose}>
            Modo Especialista
          </button>
        </footer>
      </main>
    </div>
  );
}

import { useState, useMemo, useEffect } from 'react';
import type { ModelPart } from './models';
import type { ToothCase } from './tooth-types';
import type { RestorationAssembly } from './restoration-types';
import { Viewport } from './Viewport';
import { ToothOdontogram } from './ToothOdontogram';
import { toothNameEs } from './teeth';
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
  const [demoAttempt, setDemoAttempt] = useState(0);
  const hasCaseParts = parts.length > 0 || referenceParts.length > 0;
  const isDemoMode = demoAttempt > 0 && !hasCaseParts;

  // Layer visibility toggles
  const [showArch, setShowArch] = useState(true);
  const [showCrown, setShowCrown] = useState(true);
  const [showImplant, setShowImplant] = useState(true);
  const [showBone, setShowBone] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);
  const [demoArchParts, setDemoArchParts] = useState<ModelPart[]>([]);
  const [loadingMeshes, setLoadingMeshes] = useState(false);
  const [demoError, setDemoError] = useState('');

  // Example patient information is only shown after explicitly loading the demo.
  const patientName = isDemoMode ? 'Sofia M.' : 'Paciente';
  const caseId = 'PLT-2026-084';

  const [internalSelectedFdi, setInternalSelectedFdi] = useState<number | null>(selectedFdi ?? 21);

  // Never fetch sample assets merely because the current case is empty.
  useEffect(() => {
    if (!isDemoMode) {
      setDemoArchParts([]);
      setLoadingMeshes(false);
      setDemoError('');
      if (hasCaseParts) setDemoAttempt(0);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoadingMeshes(true);
    setDemoError('');

    const loadFile = async (name: string, type: string) => {
      const response = await fetch(`/patient-demo/${name}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load ${name}`);
      return new File([await response.blob()], name, { type });
    };

    Promise.all([
      loadFile('upper.ply', 'application/octet-stream'),
      loadFile('upper.jpg', 'image/jpeg'),
      loadFile('lower.ply', 'application/octet-stream'),
      loadFile('lower.jpg', 'image/jpeg'),
    ])
      .then(files => cancelled ? null : importModels(files))
      .then(res => {
        if (!cancelled && res && res.parts.length > 0) {
          const tagged = res.parts.map(p => ({
            ...p,
            role: (p.name.includes('upper') ? 'upper' : 'lower') as 'upper' | 'lower',
          }));
          setDemoArchParts(tagged);
        }
      })
      .catch(() => {
        if (!cancelled) setDemoError('No se pudo cargar el modelo de demostración. Puedes reintentarlo.');
      })
      .finally(() => {
        if (!cancelled) setLoadingMeshes(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isDemoMode, demoAttempt, hasCaseParts]);

  // Construct active parts for 3D viewing (in demo mode, render the clean textured dental arches)
  const activeParts = useMemo(() => {
    if (!isDemoMode) return parts;
    return demoArchParts;
  }, [isDemoMode, parts, demoArchParts]);

  // Synthetic tooth case for demo
  const effectiveTeeth = useMemo(() => {
    if (!isDemoMode) return toothData.teeth;
    const teethMap: ToothCase['teeth'] = {};
    for (let fdi = 11; fdi <= 48; fdi++) {
      if (fdi % 10 >= 1 && fdi % 10 <= 8) {
        if (fdi % 10 === 8) {
          teethMap[fdi] = { status: 'unreviewed', restoration: 'none', note: 'Sin registro en la demostración' };
        } else {
          teethMap[fdi] = { status: 'present', restoration: 'none', note: 'Diente natural (ejemplo)' };
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
  const selectedTooth = effectiveTeeth[activeFdi];
  const selectedStatus = selectedTooth?.status;
  const selectedStatusLabel = selectedStatus === 'missing' ? 'Ausente (registrado)'
    : selectedStatus === 'present' ? 'Presente (registrado)'
    : selectedStatus === 'not-scanned' ? 'No escaneado' : 'Sin revisar';

  // Compute customized opacities for layers
  const computedOpacities = useMemo(() => {
    const next: Record<string, number> = { ...initialOpacities };

    activeParts.forEach(part => {
      const isRestoration = !!part.restoration;
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
    isDemoMode
      ? `Hola, estuve revisando la demostración de Céflow Dental (Caso de ejemplo ${caseId}, ${patientName}). Quisiera más información.`
      : 'Hola, estuve revisando la vista 3D de mi caso en Céflow Dental. Quisiera consultar con mi odontólogo.'
  );

  return (
    <div className="patient-medical-page" aria-label="Informe Clínico del Paciente">
      {/* Top Clinical Header Bar */}
      <div className="patient-nav-bar">
        <div className="patient-nav-inner">
          <div className="patient-brand-tag">
            <span className="brand-logo-wrap" aria-label="Céflow">
              <img src="/brand/ceflow-logo-navy.png" alt="Céflow" className="ceflow-logo ceflow-logo--light" />
              <img src="/brand/ceflow-logo-periwinkle.png" alt="Céflow" className="ceflow-logo ceflow-logo--dark" />
            </span>
            <span className="patient-brand-sub">DENTAL</span>
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
          <div className="patient-brand">
            <span className="brand-logo-wrap" aria-label="Céflow">
              <img src="/brand/ceflow-logo-navy.png" alt="Céflow" className="ceflow-logo ceflow-logo--light" />
              <img src="/brand/ceflow-logo-periwinkle.png" alt="Céflow" className="ceflow-logo ceflow-logo--dark" />
            </span>
            <span className="patient-header-badge">{isDemoMode ? 'Demostración · datos de ejemplo' : 'VISTA DEL CASO 3D'}</span>
          </div>
          <h1>Informe para {patientName}</h1>
          <p>
            {isDemoMode
              ? `Caso de ejemplo #${caseId} · Fotografías, notas y registros ilustrativos.`
              : 'Vista de los archivos y registros disponibles del caso.'}
            {' '}No sustituye una consulta presencial.
          </p>
        </header>

        {/* Card 1: Case guidance or explicitly requested sample notes */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">📝</span>
            {isDemoMode ? 'Notas de tu dentista (ejemplo)' : hasCaseParts ? 'Escaneos importados' : 'Sin escaneos importados'}
          </h2>
          <p className="patient-note">
            {isDemoMode
              ? 'Ejemplo ilustrativo de seguimiento preventivo. Las notas y el odontograma de esta demostración no son una evaluación de tu caso.'
              : hasCaseParts
              ? 'Esta vista muestra tus archivos importados y los registros del odontograma. No hay notas clínicas generales disponibles.'
              : 'Usa Modo Doctor para importar tus propios archivos. También puedes cargar una demostración con datos de ejemplo.'}
          </p>
          {!isDemoMode && !hasCaseParts && (
            <button type="button" className="btn-patient-doctor" onClick={() => setDemoAttempt(attempt => attempt + 1)}>
              Cargar demostración
            </button>
          )}
        </section>

        {/* Card 2: Tu revisión en fotos */}
        {isDemoMode && <section className="patient-card">
          <h2>
            <span className="card-icon">📸</span>
            Tu revisión en fotos (ejemplo)
          </h2>
          <div className="patient-photos">
            <figure>
              <img src="/patient-demo/photo-frontal.jpg" alt="Fotografía frontal de demostración" />
              <figcaption>Vista Frontal</figcaption>
            </figure>
            <figure>
              <img src="/patient-demo/photo-upper.jpg" alt="Fotografía de demostración de la arcada superior" />
              <figcaption>Arcada Superior</figcaption>
            </figure>
            <figure>
              <img src="/patient-demo/photo-lower.jpg" alt="Fotografía de demostración de la arcada inferior" />
              <figcaption>Arcada Inferior</figcaption>
            </figure>
          </div>
        </section>}

        {/* Card 3: Tu odontograma */}
        <section className="patient-card">
          <h2>
            <span className="card-icon">🦷</span>
            Tu odontograma
          </h2>
          {!isDemoMode && <p className="patient-hint">Los dientes sin registro permanecen sin revisar.</p>}
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
                className={`status-chip ${selectedStatus === 'present' || selectedStatus === 'missing' ? selectedStatus : ''}`}
              >
                {selectedStatusLabel}
              </span>
            </strong>
            <p className="tooth-quote">
              {selectedTooth?.note || 'No hay notas registradas para este diente.'}
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
          {isDemoMode && demoError && <div role="alert">
            <p>{demoError}</p>
            <button type="button" className="btn-patient-doctor" onClick={() => setDemoAttempt(attempt => attempt + 1)}>
              Reintentar demostración
            </button>
          </div>}

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
              onImport={onClose}
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
              Tus dientes ({isDemoMode ? 'Modelo de demostración' : 'Escaneos importados'})
            </label>
            {activeParts.some(p => p.restoration?.component === 'crown') && (
              <label className="layer-item">
                <input
                  type="checkbox"
                  checked={showCrown}
                  onChange={e => setShowCrown(e.target.checked)}
                />
                <span className="swatch crown" />
                Corona (concepto)
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
                Implante (concepto)
              </label>
            )}
          </div>
        </section>

        {/* Card 5: Tu evaluación diagnóstica */}
        {isDemoMode && <section className="patient-card">
          <h2>
            <span className="card-icon">📋</span>
            Tu evaluación diagnóstica (ejemplo)
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
            Datos ilustrativos; no hay mediciones verificadas para este caso de ejemplo.
          </p>
        </section>}

        {/* Card 6: Fases de seguimiento preventivo */}
        {isDemoMode && <section className="patient-card">
          <h2>
            <span className="card-icon">⏱️</span>
            Fases de seguimiento preventivo (ejemplo)
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
        </section>}

        {/* Card 7: WhatsApp Contact */}
        <section className="patient-card whatsapp-card">
          <h2>
            <span className="card-icon">💬</span>
            ¿Tienes dudas sobre tu revisión?
          </h2>
          <p className="patient-note">
            {isDemoMode
              ? 'Estás explorando una demostración con datos de ejemplo. Puedes compartir una consulta por WhatsApp.'
              : 'Puedes compartir una consulta sobre los archivos y registros disponibles con tu odontólogo por WhatsApp.'}
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

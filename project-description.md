# Platanus Dental v2 — Planificación de Implantes y Restauración 3D Asistida por IA

> **Track:** 🧊 Three-Dimensional  
> **Platanus Hack 26: Caracas ft. Yummy — Team 18**  
> **Demo en vivo:** [https://platanus-p2.onrender.com](https://platanus-p2.onrender.com)  
> **Código:** [https://github.com/Doble-2/platanus-hack-p2](https://github.com/Doble-2/platanus-hack-p2)

---

## 💡 El Problema
La odontología digital moderna para implantes y prótesis fija depende de software CAD/CAM legacy (exocad, exoplan, 3Shape) con barreras críticas:
- **Costos astronómicos:** Licencias anuales superiores a **$15.000 USD** con bloqueos de dongle físico y costos por caso exportado.
- **Hardware privativo:** Exigen estaciones de trabajo de escritorio con GPUs Nvidia de alta gama; imposibles de usar en Mac, laptops ligeras o tablets.
- **Falta de comprensión del paciente:** Los odontólogos planifican en interfaces saturadas de ingeniería; el paciente no comprende el valor de un implante guiado y rechaza presupuestos por miedo o desconfianza.

---

## 🚀 Nuestra Solución: Platanus Dental v2
Una plataforma web 3D de ingeniería de precisión que procesa **todo el cómputo geométrico localmente en el navegador del cliente mediante Web Workers multihilo**, asistida por visión multimodal de frontera (Claude 3.5 Sonnet) y con un portal de consulta diseñado para pacientes.

### 1. Motor 3D en el Cliente (Zero-Latency Web Workers)
- **Registro y Alineación Oclusal:** Algoritmos ICP y árboles KD acelerados en Web Workers para relacionar arcadas superior, inferior y mordidas estáticas.
- **Detección de Colisiones & Penetración en Tiempo Real:** Medición de holguras de contacto y distancias interproximales con precisión de décimas de milímetro.
- **Tomografía CBCT & DICOM Nativa:** Decodificación de volúmenes DICOM directamente en el cliente, extracción de superficies óseas por Marching Cubes y visualización ortogonal sincronizada.

### 2. Generación Paramétrica de Prótesis e Implantes
- **Ensamblaje Anatómico Completo:** Posicionamiento tridimensional de implante (fixture de titanio), pilar protésico transmucoso y corona estética de circonio.
- **Ajuste y Guardarraíles Clínicos:** Guardarraíles de seguridad biológica (espacio biológico, profundidad subcrestal y ángulos límite de pilar) validados matemáticamente.
- **Edición Asistida por IA Multimodal:** Claude Sonnet 3.5 inspecciona capturas renderizadas 3D de alta resolución y sugiere adaptaciones clínicas.

### 3. Portal Interactivo del Paciente (`#patient`)
- **Odontograma FDI Interactivo:** Mapa dental visual de 32 piezas que permite al paciente explorar el estado de su boca (dientes sanos, ausencias y restauraciones planificadas).
- **Visualizador 3D Intuitivo:** Controles simplificados para observar el futuro implante y corona estética en 3D desde cualquier dispositivo.
- **Control de Capas:** Opciones sencillas para encender/apagar dientes, corona estética, implante de titanio y hueso tomográfico.
- **Explicación Clínica en Lenguaje Claro:** Desglose del procedimiento paso a paso, fases de tratamiento, beneficios biológicos y botón directo para consultas por WhatsApp con la clínica.

---

## 🧪 Calidad, Robustez y Pruebas
- **1.026 Tests Unitarios & de Integración (100% Pass):** Suite exhaustiva que verifica cálculo de mallas, serialización DICOM, guardarraíles protésicos y flujos de edición asistida.
- **Pruebas End-to-End con Playwright:** Cobertura automatizada sobre el shell clínico, montaje del visor 3D, navegación hacia el portal del paciente y validación del odontograma interactivo.
- **Cero dependencias pesadas en servidor:** Todo el renderizado y la computación geométrica se ejecutan en WebGL y Web Workers sin requerir servidores GPU costosos.

---

## 🛠️ Stack Tecnológico
- **Frontend & 3D:** React 19, TypeScript, Three.js, Vite, Web Workers API, CSS Tokens.
- **Inteligencia Artificial:** Anthropic Claude 3.5 Sonnet vía Vercel AI SDK (visión multimodal y herramientas clínicas estructuradas con Zod).
- **Procesamiento Médico:** Parser DICOM en WebAssembly/Workers, Marching Cubes, KD-Tree collision detection.
- **Testing & E2E:** Node.js native test runner con type-stripping (`pnpm test`), Playwright (`pnpm test:e2e`).
- **Despliegue:** Render Cloud (Docker preview containerizado, HTTP/2, auto-deploy en main).

---

## 👥 Equipo (Team 18)
- **Ángel Calderón** ([@doble-2](https://github.com/doble-2))
- **Luis Anibal Olivares Zárraga** ([@anibaldbxd](https://github.com/anibaldbxd))
- **Vicente Herrera** ([@vicenteluquez271-dev](https://github.com/vicenteluquez271-dev))
- **Marcelo León** ([@marcebollin](https://github.com/marcebollin))
- **Ariana Torres** ([@arianactorres](https://github.com/arianactorres))

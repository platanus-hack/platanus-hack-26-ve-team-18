# Céflow — Planificación Odontológica 3D Automatizada

> **Track:** 🧊 Three-Dimensional  
> **Platanus Hack 26: Caracas ft. Yummy — Team 18**  
> **Demo en vivo:** [https://cenflow-ph.onrender.com](https://cenflow-ph.onrender.com)  
> **Portal de Paciente:** [https://cenflow-ph.onrender.com/#patient](https://cenflow-ph.onrender.com/#patient)  
> **Código fuente:** [https://github.com/Doble-2/platanus-hack-p2](https://github.com/Doble-2/platanus-hack-p2)

---

## ⚡ En 1 palabra
**Planificación.**

---

## 🧭 Origen
**Céflow** nace para revolucionar la planificación odontológica en casos complejos, reduciendo procesos de semanas a unas pocas horas. Transformamos mecanismos manuales e ineficientes en flujos digitales de alta precisión milimétrica.

---

## 📖 Historia
Al vivir de cerca el tiempo que se pierde en tareas manuales, repetitivas y costosas para proyectar un caso, identificamos una gran oportunidad para transformar la planificación clínica. Unimos la experiencia médica directa con el desarrollo tecnológico de vanguardia para crear la solución que el especialista siempre necesitó.

---

## 🛠️ Servicio
Servicio de **visualización 3D y planificación clínica automatizada**, diseñada para optimizar radicalmente el flujo de trabajo de odontólogos especialistas.

Permite cargar insumos digitales estándar (escaneos intraorales, tomografías CBCT DICOM, fotografías clínicas) y obtener en minutos segmentación anatómica, cálculo de mordida y colisiones en tiempo real, guardarraíles protésicos y una hoja de consulta 3D interactiva para el paciente.

---

## ✨ Fortalezas Clave
- **Adaptación y visualización a diferentes casos:** Soporta arcadas completas, registros de mordida estáticos y dinámicos, tomografías óseas y piezas unitarias o múltiples.
- **Eficiencia operativa y ahorro de costos:** Reduce el 80% del trabajo manual repetitivo del especialista, eliminando licencias privativas de más de $15.000 USD y hardware GPU especializado.
- **Optimización del Margen de Ganancia:** Permite al especialista atender a un mayor volumen de pacientes al liberar tiempo administrativo y de diseño manual exhaustivo.
- **Diseñado por y para odontólogos:** Al contar con un odontólogo en nuestro equipo fundador, garantizamos que la interfaz resuelva problemas clínicos diarios reales con el lenguaje del especialista.
- **Aumento en la Tasa de Aceptación de Tratamientos:** La simulación visual 3D interactiva permite explicar el caso de forma clara y pedagógica al paciente, generando mayor confianza y acelerando la aprobación del presupuesto.
- **Reducción del Error Humano:** Al estandarizar la medición y el trazado de la arcada/mordida mediante algoritmos matemáticos deterministas, se disminuye la probabilidad de imprecisiones en el diagnóstico inicial.
- **Compatibilidad con insumos estándar de la industria:** Centraliza en un solo lugar fotografías clínicas, archivos de escáner intraoral (`.STL`, `.OBJ`, `.PLY` con texturas fotorrealistas) y tomografías computarizadas (`DICOM Part 10`).

---

## ⚖️ Análisis Estratégico y Mitigación de Debilidades

### 1. Responsabilidad Clínica y Validación Médica Final
- **Reto:** Al tratarse de diagnósticos y proyecciones de salud, el software no puede asumir la responsabilidad médica por un diagnóstico erróneo si el algoritmo propone una medición equivocada.
- **Impacto:** Necesidad de un marco legal riguroso y términos de uso explícitos.
- **Enfoque Céflow:** Céflow se posiciona como una **herramienta de soporte a la planificación clínica**. El control y la aprobación del plan de tratamiento siempre recaen sobre el odontólogo, quien revisa, edita y aprueba las proyecciones en pantalla antes de su ejecución clínica.

### 2. Resistencia al Cambio en el Sector Odontológico Tradicional
- **Reto:** El sector a veces muestra resistencia a cambiar sus flujos de trabajo establecidos o a confiar plenamente en herramientas automatizadas.
- **Impacto:** Tiempos de venta más largos y necesidad de capacitación inicial.
- **Enfoque Céflow:** Al tener un odontólogo en nuestro equipo, la herramienta habla el mismo lenguaje del especialista y se integra como un **asistente inteligente**, no como un reemplazo. El objetivo no es sustituir el criterio médico, sino **adelantar el 80% de su trabajo de planificación que suele ser repetitivo y tedioso**.

---

## 💡 Inspiración
Nos inspira el compromiso inquebrantable de los profesionales de la salud, quienes dedican su vida a devolver la funcionalidad, la estética y la confianza a sus pacientes. Soñamos y construimos un futuro donde la tecnología elimine las barreras operativas y el tiempo perdido en el consultorio.

---

## 🎯 Ventaja Frente a la Competencia
Frente a las suites CAD legacy de escritorio (como *exocad*, *3Shape* o *exoplan*):
1. **Funcionalidades y Costos:** Cero licencias de $15.000 USD/año, cero dongles físicos USB, cero servidores con GPUs caras dedicadas. Todo corre en la web.
2. **Menor Complejidad de Uso:** Curva de aprendizaje inmediata, interfaz limpia y reactiva, sin configuraciones complejas de ingeniería.

---

## 🎭 Personalidad de Marca
- **Analítica, milimétrica y ágil.**
- **Serena y confiable bajo presión.**
- **Vanguardista e innovadora.**

---

## 🔬 Arquitectura Técnica
- **Motor Geométrico en el Cliente:** Aceleración mediante Web Workers multihilo en background. Ejecuta algoritmos de colisión BVH, árboles KD, registro ICP y Marching Cubes sin latencia de red.
- **Inteligencia Artificial Multimodal:** Claude 3.5 Sonnet a través de Vercel AI SDK, ejecutando análisis estructurado de capturas 3D multi-vista sin exponer datos sensibles del paciente.
- **Portal del Paciente (`#patient`):** Hoja médica digital con odontograma interactivo FDI de 32 piezas, render 3D de arcadas con texturas fotorrealistas y canal directo de resolución de dudas vía WhatsApp.
- **1.031 Tests Unitarios (100% Pass) & 9 Tests E2E con Playwright:** Cobertura exhaustiva de precisión geométrica, parsing DICOM, flujos de usuario y soporte móvil.

---

## 👥 Equipo (Team 18)
- **Ángel Calderón** ([@doble-2](https://github.com/doble-2))
- **Luis Anibal Olivares Zárraga** ([@anibaldbxd](https://github.com/anibaldbxd))
- **Vicente Herrera** ([@vicenteluquez271-dev](https://github.com/vicenteluquez271-dev))
- **Marcelo León** ([@marcebollin](https://github.com/marcebollin))
- **Ariana Torres** ([@arianactorres](https://github.com/arianactorres))

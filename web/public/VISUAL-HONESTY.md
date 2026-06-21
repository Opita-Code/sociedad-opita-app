# Honestidad visual — Sociedad Opita

> El monumento cultural vivo de Tello, Huila, declara abiertamente qué
> imágenes muestra, de dónde vienen, y qué no son.

## ¿Por qué este documento existe?

Sociedad Opita es un monumento a un pueblo real de 12.908 habitantes en
el valle del Magdalena, Huila, Colombia. La premisa es habitar el pueblo
— su gente, sus muletillas, su plaza, su río. Las imágenes de este sitio
son de tres tipos, declarados honestamente.

No mostramos:
- Imágenes AI como si fueran fotografía documental.
- Imágenes de otros pueblos presentadas como Tello.
- Retratos de personas reales sin consentimiento.

## 1. Fotografía real de Wikimedia Commons (CC-BY-SA-4.0)

Las fotos del sitio marcadas como "Wikimedia Commons" son **62 fotografías
reales** de municipios del mismo terreno andino-Magdalena que Tello:
Neiva, Gigante, San Agustín, Yaguará, Guadalupe, Acevedo, Pitalito.
Son CC-BY-SA-4.0 (algunas CC-BY-3.0 o CC-BY-2.0 puntuales). Cada una
tiene su `.txt` sidecar con autor, URL original, licencia y fecha.

**Por qué se usan**: Tello no tiene presencia fotográfica pública
significativa. La categoría `Category:Tello` en Wikimedia Commons
contiene solo 3 archivos (bandera, escudo, mapa de ubicación). El
artículo de Wikipedia sobre Tello está etiquetado como
"Artículos sin imagen en entidad subnacional".

**Lo que SÍ son**: la verdad de cómo se ve un pueblo andino del valle
del Magdalena — la misma tierra, el mismo clima, la misma arquitectura
colonial, las mismas técnicas agrícolas, el mismo cielo.

**Lo que NO son**: fotos de Tello mismo. Son la familia visual de
Tello, no son Tello.

Las 6 fotos que aparecen en producción (con atribución completa en su
caption) son:

| Archivo servido | Foto fuente | Concepto | Autor / Commons |
|---|---|---|---|
| `/hero-tello-landscape.jpg` | `Landscape near Gigante, Colombia 01` | Valle andino del Magdalena, 21:9 panorámica | Bernard Gagnon (Bgag) · CC-BY-SA-4.0 |
| `/plaza-similar-tello.jpg` | `Panorámica de los adornos navideños` | Plaza pública del Huila con adornos | (ver Commons) · CC-BY-SA-4.0 |
| `/tile-ventana.jpg` | `Entrada biblioteca departamental Olegario Rivera, Neiva` | Arquitectura civil colonial republicana | (ver Commons) · CC-BY-SA-4.0 |
| `/tile-puente.jpg` | `Río Magdalena, Colombia 04` | Río Magdalena — conexión | (ver Commons) · CC-BY-SA-4.0 |
| `/tile-replica.jpg` | `Landscape of Huila Departement, Colombia 01` | Paisaje departamental andino | (ver Commons) · CC-BY-SA-4.0 |
| `/tile-taller.jpg` | `Horno típico del Huila` | Taller de cocina artesanal huilense | (ver Commons) · CC-BY-SA-4.0 |

Atribución completa de las 62 fotos en
[`references/tello/README.md`](https://github.com/anomalyco/sociedad-opita-app-v2/blob/main/references/tello/README.md).

## 2. Retratos AI-generated (declarados honestamente)

Dos retratos del sitio son generados por IA, **no son fotografía
documental**, y se declaran en cada aparición con un caption visible:

| Persona | Archivo | Estilo | Disclosed as |
|---|---|---|---|
| Doña Prudencia | `/persona-dona-prudencia.jpg` | B/N documental inspirado en Benjamín de la Calle y Nereo López | "Retrato AI — no fotográfico documental" |
| Don Eliécer | `/persona-don-eliecer.jpg` | Mismo estilo | "Retrato AI — no fotográfico documental" |

**Por qué se usan**: estos dos retratos pasaron la v2 inspection como
BORDERLINE (no PASS, pero aceptables con declaración). La alternativa
era eliminarlos, pero Doña Prudencia y Don Eliécer son personajes
centrales de la simulación y dejar el espacio vacío era peor que
mostrar el retrato con su declaración honesta.

**Lo que SÍ son**: interpretaciones arquetípicas de los personajes
documentados en `api/src/personas.ts`. Capturan el rol, la edad, la
dignidad del personaje.

**Lo que NO son**: fotografías documentales. No son personas reales.
No deben usarse para identificar a nadie.

**Cuándo se reemplazan**: cuando se contrate fotografía real de Tello
con consentimiento explícito, o cuando haya fondos para fotografía
profesional commissioned ($200–500 USD por sesión). Hasta entonces,
la declaración visible en el sitio es la única frontera honesta.

## 3. Marcadores tipográficos como placeholders honestos

Siete personajes del sitio aparecen con un marcador SVG de una sola
letra en serif sobre fondo arena (`#faf6ed`). Sin fotografía, sin
retrato AI, sin decoración.

| Persona | Archivo | Letra |
|---|---|---|
| Doña Rosa Elvira | `/persona-dona-rosa.svg` | R |
| Padre Cecilio | `/persona-padre-cecilio.svg` | C |
| Jhon Eliécer | `/persona-jhon-eliecer.svg` | E |
| Don Octavio | `/persona-don-octavio.svg` | O |
| Don Emigdio | `/persona-don-emigdio.svg` | E |
| Jhon Jairo | `/persona-jhon-jairo.svg` | J |
| Jhon Fredy | `/persona-jhon-fredy.svg` | F |

**Por qué**: aún no tenemos retratos para estos 7 personajes. El
marcador tipográfico es honest placeholder hasta que llegue fotografía
real con consentimiento. Decir "no tenemos foto" con una letra es
mejor que inventar una imagen.

Don Rosalío aparece como un círculo con su inicial (sin marcador SVG
separado). Mantiene el código pre-existente del sitio.

## 4. Lo que NO está en el sitio (decisiones deliberadas)

- **Las 15 imágenes AI marcadas como AI_SLOP** (15 de las 17 generadas
  en `maria-outputs/candidates/`) **no se usan**. Pasaron la inspection
  visual como AI_SLOP: anatomía incorrecta, ojos muertos, fondo
  derretido, falta de dignidad documental. El operador del proyecto
  decidió que prefería marcadores tipográficos honestos a imágenes
  AI que mienten sobre lo que son.
- **No hay foto de Tello mismo** porque no existe en archivo público
  abierto. Esto no se compensa con AI. Se compensa con fotos de la
  familia visual andina-Magdalena (Wikimedia, CC-BY-SA).
- **No hay foto de personas reales de Tello** sin consentimiento
  explícito. Esto es no-negociable.

## La sustancia es el corpus, no las imágenes

El verdadero contenido de Sociedad Opita es el **corpus
markitdown-tuned** (106 artefactos en
`references/markitdown-corpus/`):

- 10 diálogos validados por hablante nativo del opita.
- 41 perfiles psicométricos (Big Five + Lomnitz + Dunbar).
- 249 ways de OpenStreetMap del casco urbano de Tello.
- CSV del DANE CNPV 2018 con proyección 2025.
- 8 reportes de Artesanías de Colombia (1995–2022).
- 204 papers académicos filtrados por relevancia real.
- BibTeX, paper, ground truth ZIP — todo bajo CC-BY-4.0 cuando se
  asigne DOI.

Las imágenes son decoración honesta. La ciencia, la historia, la
economía, las muletillas — todo está en el corpus, accesible,
verificable, abierto.

## Compromiso

- No fabricamos imágenes de personas reales.
- No mostramos imágenes de Tello que no sean de Tello sin declarar.
- No usamos AI slop como si fuera realidad.
- Cada visual es trazable a su fuente y a su licencia.
- Donde no hay fuente honesta, usamos marcador tipográfico.

## Cómo verificar

- Cada foto Wikimedia en el sitio tiene un `<figcaption>` con su
  título, autor y licencia visible.
- Cada retrato AI en el sitio tiene un caption "Retrato AI — no
  fotográfico documental" en color `opita-verriondo`.
- Cada marcador SVG se declara como "Sin retrato — placeholder
  tipográfico".
- La asignación de cada archivo en `web/public/` está documentada
  arriba. La fuente original está en `references/tello/` (62 fotos)
  y `references/maria-outputs/candidates/` (17 AI candidates,
  2 usadas).

## Versión

- Documento creado: 2026-06-20
- Versión: 1.0 (sustitución inicial de AI slop por visuales honestos)
- Próxima revisión: cuando llegue fotografía real de Tello con
  consentimiento.

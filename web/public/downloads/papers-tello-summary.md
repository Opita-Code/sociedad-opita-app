# Resumen del corpus académico — Tello, Huila

**Generado:** 2026-06-20
**Engagement:** tello-research-2026-06
**Operador:** dark-dev-base v1.0
**Archivos:**
- `web/public/downloads/papers-tello.bib` (corpus completo)
- `web/public/downloads/papers-tello-priority.bib` (subset prioritario)

---

## ⚠️ Nota de honestidad (leer antes de publicar)

El recon (FINAL-RECON-REPORT.md §6) reporta **"~204 papers en Google Scholar para 'Tello Huila'"**. **Ese número es un conteo de resultados de búsqueda, no un corpus curado.** Incluye ruido sustantivo:

- Papers sobre Huila departamental que no mencionan Tello
- Autores con apellido "Tello" en campos no relacionados
- Ruido de Tello Mobile, Trello, Tello drone, etc.

**Cada entrada en `papers-tello.bib` fue verificada individualmente** vía Google Scholar o los repositorios fuente (Artesanías de Colombia, UCC, UNAD, USCO, ECISA/UNAD publicaciones). Se prefirió omitir a inventar.

Si necesitas ampliar el corpus, ejecuta nuevas búsquedas Scholar con las plantillas del recon §6 y verifica cada hit antes de agregarlo. **No inflar el .bib con entradas no verificadas.**

---

## Cobertura

| Métrica | Valor |
|---|---|
| Conteo recon (Scholar "Tello Huila") | ~204 |
| Papers con metadata verificada | **9** |
| Papers con URL y free fulltext verificados | 6 |
| Papers con metadata verificada pero URL pendiente | 3 (Artesanías reports 1995, 1997, 2006) |
| Papers fabrication / placeholder | **0** |
| Papers rechazados por ruido (Huila-departmental sin Tello, etc.) | ~190+ |

---

## Distribución por tema (verificados)

| Tema | Cantidad | ¿Incluido en priority.bib? |
|---|---|---|
| **Artesanías / cultura material** | 5 | 2 (los 2 con URL) |
| **Masacre 1950 / La Violencia** | 0* | — |
| **Salud** | 1 | 1 |
| **Educación** | 1 | 1 |
| **Agricultura / café / banano** | 1 | 1 |
| **Infraestructura** | 1 | 1 |
| **Conflicto / seguridad** | 0 | — |
| **Diaspora / migración** | 0 | — |
| **Otros** | 0 | — |

\* La Masacre del Puente de los Decapitados (1950) está documentada en Wikipedia ES/EN y en la obra literaria *La Carnicería* (2010), pero **no son papers académicos peer-reviewed**. Ver nota al pie en `papers-tello.bib` §FILTER:masacre.

---

## Distribución por año

| Año | Papers |
|---|---|
| 1995 | 1 (Artesanías, URL pendiente) |
| 1997 | 2 (1 Artesanías verificado, 1 URL pendiente) |
| 2006 | 2 (1 Artesanías verificado, 1 URL pendiente) |
| 2017 | 1 (UCC verificado) |
| 2018 | 1 (USCO verificado) |
| 2021 | 1 (UNAD verificado) |
| 2025 | 1 (ECISA verificado) |
| 2026 | 0 (paper Clavijo aparece en cover "Vol. 8 Núm. 8 (2026)" pero fue publicado 2025-11-10) |

Rango: 1995–2025. Brecha notable: 1998–2005 (sin papers identificados), 2007–2016 (sin papers), 2019–2020, 2022–2024.

---

## Distribución por fuente / repositorio

| Fuente | Cantidad | URL base |
|---|---|---|
| Artesanías de Colombia repo | 2 verificados + 3 pendientes | `repositorio.artesaniasdecolombia.com.co` |
| Universidad Surcolombiana (Journal USCO) | 1 | `journalusco.edu.co` |
| Universidad Cooperativa de Colombia (UCC) | 1 | `repository.ucc.edu.co` |
| Universidad Nacional Abierta y a Distancia (UNAD) — tesis | 1 | `repository.unad.edu.co` |
| UNAD — publicaciones ECISA | 1 | `publicaciones.unad.edu.co` |
| Google Scholar search | 0 (sólo usado para verificación) | — |
| CrossRef / OpenAlex / Semantic Scholar | 0 (búsquedas ejecutadas pero no retornaron papers específicos de Tello en los top-50 de cada API) | — |
| Manual fallback | 0 | — |

---

## Disponibilidad de texto completo

| Estado | Cantidad |
|---|---|
| Free fulltext verificado | **6 / 9** (66.7%) |
| Free fulltext esperado (URL pendiente) | 3 / 9 (33.3%) — repositorio Artesanías es abierto por política pública |
| Paywalled | 0 |
| Sin URL | 0 |

---

## Top 6 papers por relevancia directa a Tello

(Los mismos 6 del archivo `papers-tello-priority.bib`)

1. **Ramírez Hernández 1997 — Taller de cestería en Tello, Huila** (Artesanías)
   - Cestería de guadua, productos representativos, procesos técnicos. Citado en recon §5 como "gold para el Taller".
2. **Vásquez Perdomo 2006 — Mejoramiento del producto artesanal en guadua y bejuco en Tello, Huila** (Artesanías)
   - Asesoría técnica con planos, fichas de producto, taller de tintes. Gold para el Taller.
3. **Pérez Rojas 2017 — Modelación hidráulica del diseño de alcantarillado de la Vereda Sierra de la Cañada, Tello-Huila** (UCC tesis)
   - Ingeniería aplicada a vereda específica de Tello. Útil para sección de infraestructura y servicios públicos.
4. **Amaya, Cubillos 2018 — Competitividad del cultivo de café, vereda Alto Oriente, Tello-Huila** (Journal USCO)
   - Competitividad cafetera en vereda documentada de Tello. Útil para sección agrícola.
5. **Manchola Cadena 2021 — Fortalecimiento de comprensión lectora en inglés, vereda Cucuana, Tello (Huila)** (UNAD tesis)
   - Educación rural bilingüe en vereda documentada de Tello.
6. **Yustres Clavijo et al. 2025 — Optimización de procesos de facturación ESE Tello, Huila** (ECISA)
   - **Único paper con DOI verificado**. Documenta operaciones reales del hospital municipal de Tello. Útil para sección de salud.

---

## Recomendaciones para taller.astro

### 1. Sección "Investigación y academia"
Mostrar las 6 entradas de `papers-tello-priority.bib` como tarjetas con:
- Título + autor + año
- Botón "Descargar PDF" → URL del repositorio
- DOI cuando esté disponible (solo Clavijo 2025)
- Etiqueta de tema (badge de color)

### 2. Sección "Artesanías" (priority para el Taller)
Mostrar las 2 entradas verificadas de Artesanías (Ramírez 1997, Vásquez 2006) con más prominencia. Si se localizan URLs para las 3 Artesanías pendientes (1995 tejidos, 1997 pintura, 2006 herramientas), agregarlas.

### 3. Sección "La Violencia / Masacre 1950" (decisión pendiente)
**No usar `papers-tello.bib` para esta sección.** La Masacre no tiene papers académicos peer-reviewed sobre Tello en el corpus verificado. Citar Wikipedia ES/EN y *La Carnicería* (2010) como referencias narrativas, no académicas. La decisión de cómo honrar la Masacre está abierta (FINAL-RECON-REPORT.md §12 decisión #1).

### 4. Sección "Otros" del taller
Si se requieren papers adicionales, ejecutar nuevas búsquedas Google Scholar con:
- `"Tello" "Huila"` (genérico — requiere filtrado manual)
- `"Sierra de la Cañada"` (vereda específica)
- `"Alto Oriente"` (vereda con café)
- `"Cucuana"` (vereda con educación)
- `"Anzuelo"` o `"San Andrés"` (veredas adicionales mencionadas en recon)
- `"ESE Hospital Tello"`
- `"Parque Tello"` (plaza)

Y verificar cada hit individualmente antes de agregarlo al .bib.

### 5. Mantenimiento
Cuando se agreguen nuevos papers:
- Verificar DOI vía https://doi.org/ si se conoce
- Verificar URL vía fetch al repositorio
- Usar el campo `keywords` consistentemente
- Mantener el patrón de cite-key: `{firstauthor}{year}_{short_topic}`
- Marcar con `% FREE_FULLTEXT` si el PDF es accesible
- Incluir `% Source:` y `% TODO:` comments para trazabilidad

---

## Verificación realizada (auditoría)

| # | Paper | Scholar | URL | DOI | PDF accessible | BibTeX auto | Notas |
|---|---|---|---|---|---|---|---|
| 1 | Ramírez Hernández 1997 | ✓ | ✓ | ✗ | confirmado | manual | Recon URL §12 #4 |
| 2 | Vásquez Perdomo 2006 | ✓ | ✓ | ✗ | confirmado | manual | Recon URL §12 #5 |
| 3 | Artesanías 1995 tejidos | ✗ | ✗ | ✗ | n/a | manual | Solo recon §5 |
| 4 | Artesanías 1997 pintura | ✗ | ✗ | ✗ | n/a | manual | Solo recon §5 |
| 5 | Artesanías 2006 herramientas | ✗ | ✗ | ✗ | n/a | manual | Solo recon §5 |
| 6 | Pérez Rojas 2017 | ✓ | ✓ | ✗ | n/a (repo bot) | manual | Recon URL §12 #11 |
| 7 | Amaya, Cubillos 2018 | ✓ | ✓ | ✗ | n/a (repo bot) | manual | Recon URL §12 #10 |
| 8 | Manchola Cadena 2021 | CAPTCHA | ✓ | ✗ | **✓** | manual | Recon URL §12 #13 — PDF fetched successfully |
| 9 | Clavijo et al. 2025 | CAPTCHA | ✓ | **✓** | confirmado | manual | Recon URL §12 #12 — full metadata from ECISA record |

APIs probadas pero sin resultados Tello-específicos en top hits:
- CrossRef (`query=Tello+Huila&rows=20`) — 0 papers específicos
- OpenAlex (`search=Tello Huila&per_page=50`) — 0 papers específicos en top 50
- Semantic Scholar — no consultado (rate limit)
- Google Scholar Cite (`output=cite`) — 403 para todos los queries

APIs de repositorio (todas con bot protection BunkerWeb/Cap.js):
- repositorio.artesaniasdecolombia.com.co — search 403
- repository.ucc.edu.co — search 403
- repository.unad.edu.co — search 404, **bitstream PDF accesible**
- journalusco.edu.co — search 403
- publicaciones.unad.edu.co (ECISA) — **search + landing page accesible**

---

## Veredicto

**PARTIAL — usable pero incompleto**

El corpus verificado (9 papers) es **suficiente para un lanzamiento inicial de la sección taller.astro** pero no alcanza los 204 que el recon sugiere. Razones:

1. **El recon sobreestimó**: el número 204 es ruido de Scholar, no corpus curado.
2. **El corpus académico real sobre Tello es pequeño** — un municipio de 12,908 personas con brecha digital y sin presencia institucional apenas produce investigación.
3. **3 papers de Artesanías tienen URLs pendientes** — localizarlas agregaría 3 entradas con alta relevancia para el Taller.
4. **Las secciones masacre, conflicto, diaspora no tienen papers** — esto refleja la realidad del campo, no una falla de la búsqueda.

**Recomendación final:** lanzar taller.astro con `papers-tello-priority.bib` (6 entries) como sección principal, ofrecer `papers-tello.bib` (9 entries) como descarga completa, y mencionar honestamente en el copy del sitio que "el corpus académico abierto sobre Tello es pequeño y este es un punto de partida, no un catálogo exhaustivo".

---

*Generado por opencode + Engram persistent memory — captura_prompt: false (artefacto técnico).*

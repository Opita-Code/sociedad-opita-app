# Sociedad Opita — Monumento Digital Vivo

> El primer monumento digital vivo de una comunidad colombiana. Tello, Huila.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥22.12-green.svg)](https://nodejs.org/)

## ¿Qué es?

Sociedad Opita simula una sociedad rural colombiana (Tello, Huila) con 41 personas documentadas con Big Five, Lomnitz y Dunbar. El simulador genera diálogos validados por hablante nativo del dialecto *opita*. Es un **monumento digital**: la primera copia preservable de una forma de hablar que se esta perdiendo.

## Stack (alineado con el ecosistema Opita-Code)

| Capa | Tecnología |
|---|---|
| **Frontend** | Astro 6 + React 19 islands + Tailwind 4 |
| **Backend** | SST v3 + TypeScript + Hono + AWS Lambda |
| **Streaming AI** | [`@opita/ocais`](https://github.com/Opita-Code/ocais) SDK |
| **Storage** | AWS DynamoDB (sesiones, personas) |
| **Deploy FE** | GitHub Actions + AWS S3 + CloudFront |
| **Deploy BE** | GitHub Actions + SST v3 |
| **CI** | GitHub Actions (lint, typecheck, test) |
| **Tests FE** | Playwright |
| **Tests BE** | Vitest |

## Estructura

```
sociedad-opita-app/
├── web/                  # Astro 6 + Tailwind 4 (frontend)
│   ├── src/
│   │   ├── pages/        # /, /ventana, /puente, /replica, /taller
│   │   ├── layouts/
│   │   ├── components/
│   │   └── styles/
│   ├── astro.config.mjs
│   └── package.json
├── api/                  # SST v3 + TypeScript (backend)
│   ├── src/
│   │   ├── api.ts        # Hono handler
│   │   ├── personas.ts   # 10 de las 41 personas validadas
│   │   └── lib/
│   ├── sst.config.ts     # SST config (Lambda + DynamoDB + Router)
│   ├── tests/
│   └── package.json
└── .github/workflows/
    ├── ci.yml
    ├── deploy-web.yml    # s3 sync + cloudfront invalidation
    └── deploy-api.yml    # sst deploy
```

## Desarrollo local

### Frontend

```bash
cd web
npm install
npm run dev   # http://localhost:4321
```

### Backend

```bash
cd api
npm install
npm run dev   # sst dev (live Lambda en local)
```

## Deploy

### Web (S3 + CloudFront)

Push a `main` dispara el workflow `deploy-web.yml`. Build con Astro + sync a S3 + invalidation de CloudFront.

### API (SST)

Push a `main` dispara el workflow `deploy-api.yml`. Ejecuta `sst deploy --stage prod` que crea:
- Lambda Function con Function URL
- 2 DynamoDB tables (Sessions, Personas)
- Router con custom domain `api.sociedad.opitacode.com`

**Primera vez**: SST pide confirmacion interactivamente. Despues, deploy es automatico.

## Variables de entorno

### Para la API

```bash
# Obligatorio
DEEPSEEK_API_KEY=sk-...

# Opcional (default: https://api.deepseek.com/v1)
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

### GitHub Secrets requeridos

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DEEPSEEK_API_KEY` (para el workflow deploy-api)

## URLs

| Recurso | URL |
|---|---|
| **Producción** | https://sociedad.opitacode.com |
| **API** | https://api.sociedad.opitacode.com (SST Router) |
| **Paper académico** | https://github.com/nicourrutia98/sociedad-opita |
| **Ecosistema Opita-Code** | https://github.com/Opita-Code |

## Repos relacionados (ecosistema Opita-Code)

- [`Opita-Code/ocais`](https://github.com/Opita-Code/ocais) — SDK de streaming AI (usado en Ventana)
- [`Opita-Code/opita-links`](https://github.com/Opita-Code/opita-links) — Acortador de URLs (convención del ecosistema)
- [`Opita-Code/www.opitacode.com`](https://github.com/Opita-Code/www.opitacode.com) — Landing de la empresa (referencia del patron Astro + S3+CloudFront)

## Licencia

- **Codigo**: MIT
- **Personas, ground-truth, datos biograficos**: CC-BY-4.0
- **Paper**: CC-BY-4.0
- **Uso comercial** del benchmark requiere atribucion al autor.

## Contacto

Juan Nicolas Urrutia Salcedo · [GitHub](https://github.com/nicourrutia98) · [Instagram](https://instagram.com/nico98urrutia) · Neiva, Huila, Colombia

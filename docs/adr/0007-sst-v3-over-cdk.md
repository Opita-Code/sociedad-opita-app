# ADR-0007: SST v3 sobre AWS CDK

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

Necesitamos **Infrastructure as Code** para el stack de Sociedad
Opita:

- 1 Lambda function (arm64, 2048 MB, 60 s)
- 1 Lambda Function URL
- 3 DynamoDB tables (con 2 GSIs en una)
- 1 Router con custom domain
- 1 SST Secret (DEEPSEEK_API_KEY)
- CloudWatch logs + alarms

Las opciones principales en 2026 son:

| Opción | Lenguaje | Curva | Live dev | Ecosistema Opita-Code |
|--------|----------|-------|----------|------------------------|
| **AWS CDK** | TypeScript / Python / Go | Media-alta | ✗ (requiere `cdk synth`) | Mixto (www usa CDK) |
| **SST v3** | TypeScript (constructs) | Baja | ✓ (`sst dev` con Live Lambda) | Sí (opita-links usa SST) |
| **Terraform** | HCL | Media | ✗ | No |
| **Pulumi** | TypeScript / Python / Go | Media | Parcial | No |
| **AWS SAM** | YAML / TS | Baja | ✓ (`sam local`) | No |

## Decision

Adoptamos **SST v3** (`sst ^3.14`) como IaC del backend.

- `api/sst.config.ts` declara el stack completo: app, run(),
  resources.
- `sst dev` levanta Live Lambda local con hot reload (cambios en
  `api/src/*` se reflejan en < 1 s, sin re-deploy).
- `sst deploy --stage prod` crea/actualiza la stack en AWS.
- `sst.Secret` cifra secretos en SSM SecureString (Polish R5).
- Link automático de resources a las functions (DynamoDB
  permissions, env vars) sin IAM boilerplate.

Por qué SST sobre CDK:

- **`sst dev` es Live Lambda real**: no es `sam local` ni un
  emulador — es una función Lambda de verdad ejecutándose en tu
  máquina, con hot reload del código TypeScript. El dev loop es:
  editar `api/src/handlers/dialogue.ts` → save → curl al endpoint
  local → 800 ms. Sin `cdk synth`, sin `cdk deploy`, sin 3 minutos
  de espera.
- **Constructs tipados**: `sst.aws.Function`, `sst.aws.Dynamo`,
  `sst.aws.Router` son componentes de primera clase con tipos
  generados. CDK tiene L2 constructs (excelentes también) pero
  SST abstrae un nivel más (router, secrets, link) que reduce
  boilerplate.
- **Ecosistema Opita-Code**: [`opita-links`](https://github.com/Opita-Code/opita-links)
  ya está en SST. Reutilizamos patrones, debugging,
  troubleshooting. Migrar a CDK rompería consistencia.
- **Cero TypeScript boilerplate**: SST genera `.sst/platform/config.d.ts`
  con tipos para todos los resources. CDK también lo hace
  (`cdk synth` → `cdk.out`), pero SST lo hace on-demand sin
  paso explícito.
- **Cost**: SST es gratis (open source). CDK también. No hay
  diferencia.

## Consequences

**Más fácil**:

- **Dev loop brutal**: `sst dev` + editar código + curl. Iteración
  de 5–10 s entre cambio y test, vs 2–3 min con CDK
  (`cdk synth && cdk deploy`).
- **Secretos cifrados sin pensar**: `new sst.Secret("DeepSeekApiKey")`
  + `sst secret set` lo configura todo. En CDK esto requiere
  SecretsManager o SSM + IAM + rotación manual.
- **Link automático**: `link: [sessionsTable, personasTable, stateTable]`
  en la función configura IAM permissions + env vars sin código
  boilerplate. CDK requiere `table.grantReadWriteData(fn)` +
  `new iam.Role` + `new iam.Policy` + `attachInlinePolicy`.
- **Router con custom domain out-of-the-box**: `sst.aws.Router`
  crea el API Gateway / CloudFront / ACM cert / Route53 en un
  recurso. En CDK esto son 4+ constructs.
- **Ecosistema compartido**: si `opita-links` descubre un bugfix
  o patrón, lo replicamos directo.
- **`sst remove --stage prod` limpio**: borra todo en orden
  correcto. En CDK, `cdk destroy` deja IAM roles y CloudWatch
  logs huérfanos que hay que limpiar a mano.

**Más difícil**:

- **Vendor lock-in SST**: SST es open source pero tiene un SaaS
  opcional (`sst.console`) para observabilidad. El core es 100%
  self-hosted, pero el vendor existe.
- **TypeScript-only**: SST no soporta Python ni Go. Si el
  operador quiere escribir Lambdas en Python (como hace
  HuggingFace con `transformers`), no puede. Aceptable porque
  nuestro backend es 100% TS.
- **Documentación SST a veces dispersa**: SST cambia rápido
  (v2 → v3 fue un breaking change grande). Algunos patterns
  en Stack Overflow son obsoletos.
- **`sst dev` requiere credenciales AWS válidas** porque Live
  Lambda ejecuta en tu cuenta (no localmente). Coste de
  iteración = ~$0.001 por sesión de dev.
- **Cold-start de `sst dev` primera vez**: el primer `sst dev`
  sube un stack "dev" a tu cuenta AWS (~30–60 s). Subsecuentes
  son instantáneos porque el stack ya existe.

**Trade-off cuantificado**: pagamos vendor lock-in (SST) y TS-only
por (a) dev loop 30x más rápido, (b) menos boilerplate, (c)
consistencia con el ecosistema. Para un proyecto single-operator
con un solo lenguaje, el cálculo es obvio.

## Alternatives considered

- **AWS CDK**:
  - ✓ Más maduro, mejor documentado, más "AWS-native".
  - ✗ Dev loop lento (`cdk synth && cdk deploy` = 2-3 min).
  - ✗ Boilerplate de IAM y permissions. Más líneas de código
    para el mismo stack.
  - ✗ Inconsistencia con el ecosistema (opita-links usa SST).
  - **Rechazado** por dev loop + boilerplate + ecosistema.

- **Terraform**:
  - ✓ Multi-cloud, popular, buen ecosystem de módulos.
  - ✗ Lenguaje HCL, otro stack mental.
  - ✗ No hay Live Lambda nativo.
  - ✗ El proyecto no es multi-cloud — no hay razón para pagar
    el costo de Terraform.
  - **Rechazado** por HCL + single-cloud.

- **Pulumi**:
  - ✓ TypeScript IaC, similar a CDK en concepto.
  - ✗ Ecosistema Opita-Code no lo usa.
  - ✗ Live Lambda peor que SST (Pulumi tiene `pulumi dev` pero
    es más limitado).
  - **Rechazado** por ecosistema.

- **AWS SAM**:
  - ✓ Live local nativo (`sam local`).
  - ✗ YAML o JSON, no TypeScript puro.
  - ✗ Menos expressivo para custom domains, secrets, links.
  - ✗ Ecosistema Opita-Code no lo usa.
  - **Rechazado** por YAML + ecosistema.

- **No IaC (CloudFormation manual / Console)**:
  - ✗ State drift garantizado, no se puede versionar, no se puede
    replicar.
  - **Rechazado** por inviabilidad operacional.

## Pointers

- [`api/sst.config.ts`](../../api/sst.config.ts) — Definición del stack SST
- [`api/alarms.config.ts`](../../api/alarms.config.ts) — Manifest de alarms (typed, listo para wire-up)
- [`DEPLOY-RUNBOOK.md`](../../DEPLOY-RUNBOOK.md) — Procedimiento `sst deploy`
- [Opita-Code/opita-links](https://github.com/Opita-Code/opita-links) — Ejemplo de SST en el ecosistema
- [ADR-0002: CloudFront+S3+Lambda](0002-cloudfront-s3-lambda-over-cloudflare-pages.md) — El stack que SST orquesta

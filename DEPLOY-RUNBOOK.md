# Deploy Runbook — Sociedad Opita

> **Last reviewed**: Polish R5 (security hardening). All commands assume
> `sst@^3.19.3`, `pnpm@9` for `api/`, `npm@10` for `web/`, AWS region `us-east-1`.

## Pre-deploy checklist

### Code quality

- [ ] All PRs merged to `main` via squash (preserves linear history).
- [ ] CI green on the merge commit: API typecheck + test, Web astro check + build.
- [ ] No diff in `api/src/api.ts:98` or `api/sst.config.ts:1` (these only
      resolve once `sst dev` has generated `.sst/platform/config.d.ts` —
      they are tolerated by CI and reviewers; see `tsconfig.json` exclude).
- [ ] No diff in `api/src/llm/`, `api/src/rag/`, `api/src/state/`,
      `api/src/handlers/dialogue.ts` (frozen PR #5–#9 + R5 integration
      code), `api/src/context/`, `api/src/personas.ts`.
- [ ] No diff in `web/src/pages/{index,replica,taller,ventana,puente}.astro`
      (visual honesty is established — no styling drift).

### Database (DynamoDB)

- [ ] `SociedadOpitaState` removal policy = `retain` (prod stage is
      configured `removal: "retain"` in `sst.config.ts:18`).
- [ ] TTL on `expiresAt` (epoch seconds, 90 days for CONV items).
- [ ] GSIs (`byPersona`, `byTime`) projections match access patterns:
      - `byPersona`: `personaId` (HASH) + `sk` (RANGE) — events per persona
      - `byTime`:    `tsBucket` (HASH) + `ts` (RANGE) — ventana events per month
- [ ] `Sessions` and `Personas` tables — removal = `remove` (ephemeral
      bootstrap data, regenerable from seed).

### Lambda (API)

- [ ] **Memory**: `2048 MB` (BGE-M3 q8 ONNX ~600 MB + activations +
      Hono 4 runtime + Node 22 stdlib).
- [ ] **Timeout**: `60 seconds` (BGE-M3 cold-start ~5–8 s on a fresh
      container, plus DeepSeek API round-trip with 3× exp backoff).
- [ ] **Architecture**: `arm64` (Graviton2 = ~34 % better price/perf
      vs `x86_64` per AWS Lambda pricing docs; no native x86 deps in
      our Node 22 + Hono 4 stack). Fixed in Polish R7.
- [ ] **Concurrency**: reserved = `10` (cost cap; prevents runaway
      spend if abused / DoS). Lambda + DDB are pay-per-call. Fixed
      in Polish R7.
- [ ] **Env vars**: `DDB_TABLE`, `DEEPSEEK_API_KEY` (SST Secret), `DEEPSEEK_BASE_URL`,
      `CORPUS_PATH`, `STAGE`. See [Secrets](#secrets) below for the
      `sst secret set` procedure (Polish R5).
- [ ] **Link**: `[sessionsTable, personasTable, stateTable]`.
- [ ] **URL**: enabled with CORS allowing `https://sociedad.opitacode.com`
      (configured in `api/src/api.ts:28` with `Max-Age: 600` and
      `Allow-Credentials: false` hardening from Polish R5).
- [ ] **Logging**: JSON format, 1-month retention (cost-controlled).

### Frontend (static)

- [ ] `npm run build` clean (0 errors, 0 warnings).
- [ ] `npm run check` clean (`astro check` + `tsc --noEmit`).
- [ ] All 5 routes built: `/`, `/replica`, `/taller`, `/ventana`, `/puente`
      (plus `/pronto` 404 stub). Each < 50 KB.
- [ ] No new visual slop (visual honesty principle — see archive
      `monumento-cultural-v2.md`).
- [ ] WhatsApp bridge link present: `wa.me/573126126085`.
- [ ] S3 + CloudFront OAI configured; bucket is **not** public.

### Observability

- [ ] CloudWatch log group retention: 1 month (configured in `sst.config.ts:88`).
- [ ] CloudWatch alarms configured (see [Alarms](#alarms) section).
- [ ] SNS topic for alarms (operator's email).
- [ ] Dashboard widget: cost/day, invocations, error rate.

---

## Deploy procedure

### 1. Frontend (S3 + CloudFront)

The current production deployment is static-site only — `web/dist/` is
synced to the `sociedad-opita-app-prod` S3 bucket and fronted by a
CloudFront distribution (id placeholder: `E9NPTPSJGKRMQ`).

```bash
cd web
npm ci
npm run build
# Dry-run first; verify the diff is sane.
aws s3 sync dist s3://sociedad-opita-app-prod --delete --dryrun \
  --cache-control "public, max-age=300, s-maxage=3600" --exclude "*.map"
# Then real deploy.
aws s3 sync dist s3://sociedad-opita-app-prod --delete \
  --cache-control "public, max-age=300, s-maxage=3600" --exclude "*.map"
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/*"
# Verify
curl -sS -o /dev/null -w "%{http_code}\n" https://sociedad.opitacode.com/
# Expect 200. If 5xx → check CloudFront origin shield + S3 bucket policy.
```

### 2. Backend (Lambda via SST)

> **Polish R7 note**: this round is **prep**, not deploy. The Lambda
> has never been deployed to AWS. Run the first `sst deploy` from a
> workstation with AWS SSO credentials (or `AWS_PROFILE` env var).
> The deploy must use `architecture: "arm64"` (REQ-7.1) — that is
> now set explicitly in `sst.config.ts`.

```bash
cd api
pnpm install --frozen-lockfile
pnpm typecheck       # pre-existing errors tolerated
pnpm test -- --run   # 215/215 must be green
pnpm sst deploy --stage prod
# Verify
curl -sS https://api.sociedad.opitacode.com/health
# Expect: {"status":"ok",...}
```

### 3. Database (DynamoDB via SST)

- `SociedadOpitaState`, `Sessions`, and `Personas` tables are created
  automatically on the first `sst deploy --stage prod` (because the
  `sst.aws.Dynamo` resources are in `sst.config.ts`).
- `removal: "retain"` for prod means tables survive a `sst remove` —
  destroy them only manually via the AWS console if you really mean it.

---

## Rollback procedure

### Frontend (S3 versioning must be enabled on the bucket)

```bash
# List versions of index.html to find the previous good one.
aws s3api list-object-versions \
  --bucket sociedad-opita-app-prod \
  --prefix index.html \
  --query "Versions[?IsLatest].[VersionId,LastModified]" \
  --output table
# Copy the previous version to current.
aws s3api copy-object \
  --bucket sociedad-opita-app-prod \
  --copy-source "sociedad-opita-app-prod/index.html?versionId=<OLD_ID>" \
  --key index.html \
  --metadata-directive REPLACE
# Invalidate CloudFront so the rollback is visible immediately.
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/index.html" "/*.html" "/assets/*"
# Verify
curl -sS -o /dev/null -w "%{http_code}\n" https://sociedad.opitacode.com/
```

### Backend (SST keeps the last 5 versions of each function)

```bash
cd api
# Option A: re-deploy the previous git tag.
git checkout v2.0.0   # or whatever was the last known-good
pnpm sst deploy --stage prod
git checkout main

# Option B: use the SST console (sst.console) → select the previous
# function version → "Make active".
```

### Database (DDB)

- **Do not** delete the table — TTL auto-expires CONV items after 90
  days. If you need to wipe state, use `aws dynamodb delete-item` per
  `pk`/`sk` for the affected scope only.
- Reverting a destructive schema change requires a forward-only
  migration; the current single-table design is intentionally additive
  (new `sk` prefixes do not break old readers).

---

## Alarms

The alarm spec lives in `api/alarms.config.ts` (typed manifest, ready
to be wired into `sst.config.ts` in a follow-up round using
`aws.cloudwatch.MetricAlarm` from Pulumi). For now, configure these
manually in the CloudWatch console — the table is the source of truth.

---

## Secrets

Polish R5 (security hardening) migrated `DEEPSEEK_API_KEY` from
`process.env` directly to SST's encrypted `sst.Secret`. The
`api/src/llm/provider.ts` code is unchanged — it still reads
`process.env.DEEPSEEK_API_KEY`; SST interpolates the secret value
into the Lambda's environment at deploy time.

### Setting the secret

```bash
# One-time, per AWS account:
cd api
pnpm sst secret set DeepSeekApiKey sk-...
# (paste the DeepSeek API key when prompted)
```

SST stores the secret encrypted in `.sst/` (gitignored). For
`prod` and any custom stage, the secret is uploaded to AWS SSM
Parameter Store (SecureString) on the first `sst deploy`. **Do not
commit the secret to `.env`** — `.env` is for local-dev only and
SST will not read it for secrets in `prod`.

### Local dev

For local dev (`pnpm sst dev`), the same secret is read from SST's
state file. The lambda's environment is populated with the secret
value at deploy time. If you want to override for testing, you can
still drop a `DEEPSEEK_API_KEY=` line into `api/.env` — the SST
secret takes precedence in `sst dev` runs.

### Rollback

If the secret lookup fails (e.g., SSM throttled on cold start), the
Lambda will boot with `DEEPSEEK_API_KEY=""` and the provider will
fail loudly on the first dialogue request with a 4xx. Rollback =
revert `sst.config.ts` to the previous `process.env.DEEPSEEK_API_KEY
|| ""` pattern. No data loss.

---

## Deferred (Phase 2): per-persona rate limit

Polish R5 WU-5 proposed a per-persona token bucket on top of the
existing per-IP limiter in `api/src/llm/rate-limiter.ts`. This was
**deferred** because the rate-limiter file is part of the frozen
PR #5 contract. Phase 2 plan:

- Add a second `TokenBucket` instance keyed by `persona_id` (capacity
  100, refill 100 / 3600 s ≈ 0.0278/sec) in a NEW file
  `api/src/llm/per-persona-rate-limiter.ts` so we don't touch
  `rate-limiter.ts`.
- Wire it into `api/src/handlers/dialogue.ts` between the
  validator pass and the LLM call. Both buckets (per-IP and
  per-persona) must pass; otherwise return `429` with
  `Retry-After: <seconds>`.
- The per-persona bucket prevents a single persona from absorbing
  the entire 10/minute per-IP budget (e.g., one user asking Doña
  Rosa 10 questions in a row).

Polish R7 already caps total Lambda concurrency at 10, so the
abuse case is bounded at the infra layer. Per-persona is a
fairness improvement, not a security necessity.

---



| Alarm                                       | Threshold                | Period   | Action                                                                 |
|---------------------------------------------|--------------------------|----------|------------------------------------------------------------------------|
| Lambda errors (ApiFn)                       | > 1 % over 5 datapoints  | 1 min    | Page operator; check CloudWatch logs; rollback if > 5 %.                |
| Lambda duration P95 (ApiFn)                 | > 30 s over 5 datapoints | 1 min    | Bump memory to 3 GB or investigate RAG cold-start; check DDB latency.   |
| Lambda throttles (ApiFn)                    | > 0 over 5 datapoints    | 1 min    | Reserved concurrency cap of 10 hit — request quota increase.           |
| Lambda concurrent executions (ApiFn)        | > 9 over 5 datapoints    | 1 min    | Approaching cap — investigate hot-key / retry storm.                   |
| DynamoDB throttles (SociedadOpitaState)     | > 0 over 5 datapoints    | 1 min    | Review GSI projection; add DAX cache or back off.                       |
| DynamoDB consumed read units                | > 100 / 5 min            | 5 min    | Check for hot partition on `byPersona`.                                |
| S3 4xx errors (sociedad-opita-app-prod)     | > 10 / min               | 1 min    | Check CloudFront logs; verify OAI + bucket policy.                      |
| CloudFront 5xx                              | > 1 % over 5 datapoints  | 5 min    | Origin unhealthy — check S3 / Lambda health endpoints.                 |
| Cost (estimated charges)                    | > $5 / day               | daily    | Check invocations; look for abuse or runaway loop.                      |

### SNS topic for alarms

```bash
aws sns create-topic --name sociedad-opita-alarms
aws sns subscribe \
  --topic-arn "arn:aws:sns:us-east-1:<ACCOUNT_ID>:sociedad-opita-alarms" \
  --protocol email \
  --notification-endpoint "operator@example.com"
```

After subscribing, confirm the email and reference the topic ARN in
each alarm's `Actions` → `SNS` configuration.

---

## On-call

- **Primary**: Juan Nicolás Urrutia Salcedo (operator).
- **Backup**: none — solo project.
- **Slack channel**: N/A.
- **Pager rotation**: N/A.
- **Incident response SLA**: < 24 h acknowledgement, < 72 h mitigation.

---

## Pointers

- `api/sst.config.ts` — SST v3 stack (Lambda, DDB, Router, env vars, **SST Secret** for `DEEPSEEK_API_KEY` — Polish R5).
- `api/src/api.ts` — Hono app + CORS middleware (Polish R5: `Max-Age: 600`, `Allow-Credentials: false`).
- `api/src/handlers/dialogue.ts` — POST /v1/dialogue (integrates the Polish R5 validator).
- `api/src/handlers/validation.ts` — Polish R5: typed input validation (whitelist, length caps, time regex, conv_id regex, control char stripping).
- `api/src/context/builder.ts` — Polish R5: `sanitizeUserInput()` strips role markers + control chars from the query; system prompt carries an injection-defense clause.
- `api/alarms.config.ts` — typed CloudWatch alarm manifest.
- `DEPLOY-RUNBOOK.md` — this file.
- `.github/workflows/ci.yml` — typecheck + test + build on every PR / push to `main`.
- `.github/workflows/deploy-web.yml` — S3 sync (legacy; replaced by `deploy-prod.yml`).
- `.github/workflows/deploy-api.yml` — SST deploy (manual dispatch only).
- `.github/workflows/deploy-prod.yml` — canonical S3 + CloudFront deploy.
- `.sdd/archive/monumento-cultural-v2.md` — origin of REQ-7.1 deviation and Polish R7.
- `.sdd/monumento-cultural-v2/spec.md` — REQ-7.1 spec (1024 MB / arm64 / 30 s).

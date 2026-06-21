/**
 * CloudWatch alarm manifest — Sociedad Opita API.
 *
 * Polish R7 (deployment hardening): declares the alarms that the
 * production stack SHOULD have on first deploy. These are intentionally
 * exported as a typed spec rather than instantiated as Pulumi resources
 * here, because wiring `aws.cloudwatch.MetricAlarm` against
 * `sst.aws.Function` requires access to the function's `arn` (only
 * resolved at deploy time) and a careful `dependsOn` graph.
 *
 * The intended wiring (deferred to R8 or whenever the operator runs the
 * first real `sst deploy --stage prod`) is:
 *
 * ```ts
 * // api/sst.config.ts (inside run())
 * const { buildAlarms } = await import("./alarms.config.js");
 * const alarmSpecs = buildAlarms({
 *   functionName: apiFn.nodes.function.name,
 *   tableName: stateTable.name,
 * });
 * for (const spec of alarmSpecs) {
 *   new aws.cloudwatch.MetricAlarm(`Alarm-${spec.name}`, spec.args);
 * }
 * ```
 *
 * For now, configure the alarms manually in the CloudWatch console —
 * the table at the bottom of `DEPLOY-RUNBOOK.md` is the source of truth.
 */

export type AlarmThreshold = {
  readonly name: string;
  readonly description: string;
  readonly metricName: string;
  readonly namespace: "AWS/Lambda" | "AWS/DynamoDB" | "AWS/S3" | "AWS/CloudFront" | "AWS/Billing";
  readonly statistic: "Average" | "Sum" | "Maximum" | "SampleCount";
  readonly period: number;
  readonly evaluationPeriods: number;
  readonly threshold: number;
  readonly comparisonOperator:
    | "GreaterThanOrEqualToThreshold"
    | "GreaterThanThreshold"
    | "LessThanThreshold"
    | "LessThanOrEqualToThreshold";
  readonly treatMissingData: "missing" | "ignore" | "breaching" | "notBreaching";
  readonly dimensions?: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly unit?: "Percent" | "Count" | "Seconds" | "Milliseconds" | "None";
};

export type BuildAlarmsInput = {
  readonly functionName: string;
  readonly tableName: string;
  readonly bucketName?: string;
  readonly distributionId?: string;
};

export function buildAlarms(input: BuildAlarmsInput): ReadonlyArray<AlarmThreshold> {
  const fnDimensions = [{ FunctionName: input.functionName }];
  const tableDimensions = [{ TableName: input.tableName }];

  return [
    // ── Lambda (ApiFn) ─────────────────────────────────────────
    {
      name: "ApiFn-ErrorRate-High",
      description: "Lambda error rate > 1% over 5 minutes — investigate CloudWatch logs.",
      metricName: "Errors",
      namespace: "AWS/Lambda",
      statistic: "Sum",
      period: 60,
      evaluationPeriods: 5,
      threshold: 1,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      dimensions: fnDimensions,
      unit: "Count",
    },
    {
      name: "ApiFn-DurationP95-High",
      description: "Lambda duration P95 > 30s — possible RAG cold-start or DDB hotspot.",
      metricName: "Duration",
      namespace: "AWS/Lambda",
      statistic: "Maximum",
      period: 60,
      evaluationPeriods: 5,
      threshold: 30_000,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      dimensions: fnDimensions,
      unit: "Milliseconds",
    },
    {
      name: "ApiFn-Throttles-Any",
      description: "Lambda throttled at least once in 5 minutes — reserved cap of 10 hit.",
      metricName: "Throttles",
      namespace: "AWS/Lambda",
      statistic: "Sum",
      period: 60,
      evaluationPeriods: 5,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      dimensions: fnDimensions,
      unit: "Count",
    },
    {
      name: "ApiFn-Concurrency-NearCap",
      description: "Lambda concurrent executions >= 9 — approaching the reserved cap of 10.",
      metricName: "ConcurrentExecutions",
      namespace: "AWS/Lambda",
      statistic: "Maximum",
      period: 60,
      evaluationPeriods: 5,
      threshold: 9,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "notBreaching",
      dimensions: fnDimensions,
      unit: "Count",
    },

    // ── DynamoDB (SociedadOpitaState) ──────────────────────────
    {
      name: "StateTable-Throttles-Any",
      description: "DynamoDB throttled at least once in 5 minutes — review GSI design.",
      metricName: "ThrottledRequests",
      namespace: "AWS/DynamoDB",
      statistic: "Sum",
      period: 60,
      evaluationPeriods: 5,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      dimensions: tableDimensions,
      unit: "Count",
    },
    {
      name: "StateTable-ConsumedReadCapacity-High",
      description: "DDB read capacity > 100 in 5 minutes — possible hot partition on byPersona.",
      metricName: "ConsumedReadCapacityUnits",
      namespace: "AWS/DynamoDB",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 100,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      dimensions: tableDimensions,
      unit: "Count",
    },

    // ── S3 (frontend) — optional, only if bucket provided ──────
    ...(input.bucketName
      ? [
          {
            name: "FrontendS3-4xx-High",
            description: "S3 4xx errors > 10/min — verify CloudFront OAI + bucket policy.",
            metricName: "4xxErrors",
            namespace: "AWS/S3" as const,
            statistic: "Sum" as const,
            period: 60,
            evaluationPeriods: 1,
            threshold: 10,
            comparisonOperator: "GreaterThanThreshold" as const,
            treatMissingData: "notBreaching" as const,
            dimensions: [{ BucketName: input.bucketName }],
            unit: "Count" as const,
          },
        ]
      : []),

    // ── CloudFront (frontend) — optional ───────────────────────
    ...(input.distributionId
      ? [
          {
            name: "CloudFront-5xx-High",
            description: "CloudFront 5xx > 1% over 5 datapoints — origin unhealthy.",
            metricName: "5xxErrorRate",
            namespace: "AWS/CloudFront" as const,
            statistic: "Average" as const,
            period: 300,
            evaluationPeriods: 5,
            threshold: 1,
            comparisonOperator: "GreaterThanThreshold" as const,
            treatMissingData: "breaching" as const,
            dimensions: [{ DistributionId: input.distributionId }],
            unit: "Percent" as const,
          },
        ]
      : []),
  ];
}

/**
 * Approximate monthly cost ceiling for billing alarm.
 *
 * The threshold is in USD; AWS EstimatedCharges is reported in cents
 * for `Statistic = Maximum` and units must be `USD`. CloudWatch
 * publishes this metric with `Unit = None` and value = USD, so we
 * compare directly.
 */
export const BILLING_ALARM = {
  name: "Billing-EstimatedCharges-Daily",
  description: "Estimated daily charges > $5 — review invocations / look for abuse.",
  metricName: "EstimatedCharges",
  namespace: "AWS/Billing",
  statistic: "Maximum",
  period: 86_400, // 1 day
  evaluationPeriods: 1,
  threshold: 5,
  comparisonOperator: "GreaterThanThreshold" as const,
  treatMissingData: "notBreaching" as const,
  dimensions: [{ Currency: "USD" }],
  unit: "None" as const,
} as const satisfies AlarmThreshold;

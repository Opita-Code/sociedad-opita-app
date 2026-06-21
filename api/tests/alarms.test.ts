import { describe, it, expect } from "vitest";
import { buildAlarms, BILLING_ALARM } from "../alarms.config";

describe("buildAlarms (Polish R7 deployment hardening)", () => {
  it("emits the 4 Lambda alarms + 2 DDB alarms for the minimal input", () => {
    const alarms = buildAlarms({
      functionName: "ApiFn",
      tableName: "SociedadOpitaState",
    });
    expect(alarms).toHaveLength(6);
    expect(alarms.map((a) => a.name)).toEqual([
      "ApiFn-ErrorRate-High",
      "ApiFn-DurationP95-High",
      "ApiFn-Throttles-Any",
      "ApiFn-Concurrency-NearCap",
      "StateTable-Throttles-Any",
      "StateTable-ConsumedReadCapacity-High",
    ]);
  });

  it("adds S3 + CloudFront alarms when bucket and distribution are provided", () => {
    const alarms = buildAlarms({
      functionName: "ApiFn",
      tableName: "SociedadOpitaState",
      bucketName: "sociedad-opita-app-prod",
      distributionId: "E9NPTPSJGKRMQ",
    });
    expect(alarms).toHaveLength(8);
    const names = alarms.map((a) => a.name);
    expect(names).toContain("FrontendS3-4xx-High");
    expect(names).toContain("CloudFront-5xx-High");
  });

  it("scopes Lambda + DDB alarms to the given function/table names", () => {
    const alarms = buildAlarms({
      functionName: "CustomFnName",
      tableName: "CustomTableName",
    });
    const fn = alarms.find((a) => a.name === "ApiFn-ErrorRate-High");
    expect(fn?.dimensions).toEqual([{ FunctionName: "CustomFnName" }]);
    const tbl = alarms.find((a) => a.name === "StateTable-Throttles-Any");
    expect(tbl?.dimensions).toEqual([{ TableName: "CustomTableName" }]);
  });

  it("uses sensible thresholds (REQ-7.1: 30s duration, 1% errors)", () => {
    const alarms = buildAlarms({
      functionName: "ApiFn",
      tableName: "SociedadOpitaState",
    });
    const duration = alarms.find((a) => a.name === "ApiFn-DurationP95-High");
    expect(duration?.threshold).toBe(30_000);
    expect(duration?.unit).toBe("Milliseconds");
    const errors = alarms.find((a) => a.name === "ApiFn-ErrorRate-High");
    expect(errors?.comparisonOperator).toBe("GreaterThanThreshold");
    expect(errors?.threshold).toBe(1);
  });

  it("throttles alarm is wired to detect any throttling (threshold=0)", () => {
    const alarms = buildAlarms({
      functionName: "ApiFn",
      tableName: "SociedadOpitaState",
    });
    const throttles = alarms.find((a) => a.name === "ApiFn-Throttles-Any");
    expect(throttles?.threshold).toBe(0);
    expect(throttles?.comparisonOperator).toBe("GreaterThanThreshold");
    expect(throttles?.evaluationPeriods).toBe(5);
  });

  it("concurrency alarm warns before hitting the reserved cap of 10", () => {
    const alarms = buildAlarms({
      functionName: "ApiFn",
      tableName: "SociedadOpitaState",
    });
    const conc = alarms.find((a) => a.name === "ApiFn-Concurrency-NearCap");
    expect(conc?.threshold).toBe(9);
    expect(conc?.comparisonOperator).toBe("GreaterThanOrEqualToThreshold");
  });
});

describe("BILLING_ALARM (Polish R7 cost control)", () => {
  it("triggers on >$5/day estimated charges in USD", () => {
    expect(BILLING_ALARM.threshold).toBe(5);
    expect(BILLING_ALARM.namespace).toBe("AWS/Billing");
    expect(BILLING_ALARM.metricName).toBe("EstimatedCharges");
    expect(BILLING_ALARM.dimensions).toEqual([{ Currency: "USD" }]);
    expect(BILLING_ALARM.statistic).toBe("Maximum");
  });
});

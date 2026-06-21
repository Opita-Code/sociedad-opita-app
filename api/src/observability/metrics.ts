/**
 * Metrics — Polish R6 observability.
 *
 * CloudWatch Embedded Metric Format (EMF). One stdout line per emit;
 * Lambda's CloudWatch agent parses the JSON shape and turns it into
 * CloudWatch metrics without any agent install on the function.
 *
 * Spec: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 *
 * Why EMF instead of the AWS SDK `PutMetricData` API:
 *  - EMF is a single stdout write per metric. No SDK call, no IAM scope,
 *    no extra latency, no extra cold-start cost.
 *  - The metric value, dimensions, namespace, and unit all live in the
 *    same JSON line — CloudWatch parses them atomically.
 *  - Each emit is flushed immediately. No batching window, no risk of
 *    losing the last 5s of metrics on a cold kill.
 *
 * Dimension cardinality discipline: we deliberately cap the dimension
 * set to {route, method, status, status_code, persona_id, model}. We
 * never accept user-controlled values (IPs, query strings, conv_id)
 * as dimensions because that would blow up CloudWatch's first-class
 * dimension limit (~10 unique values per metric per hour is fine,
 * thousands is not).
 */
export interface MetricDimensions {
  [key: string]: string;
}

interface EmfMetric {
  Name: string;
  Unit: string;
}

interface EmfMetadata {
  Timestamp: number;
  CloudWatchMetrics: {
    Namespace: string;
    Dimensions: string[][];
    Metrics: EmfMetric[];
  };
}

interface EmfDoc {
  _aws: EmfMetadata;
  [key: string]: unknown;
}

const NAMESPACE = "SociedadOpita";

class MetricsClient {
  increment(name: string, value: number = 1, dimensions: MetricDimensions = {}): void {
    this.emit(name, value, "Count", dimensions);
  }

  histogram(name: string, value: number, dimensions: MetricDimensions = {}): void {
    this.emit(name, value, "Milliseconds", dimensions);
  }

  private emit(name: string, value: number, unit: string, dimensions: MetricDimensions): void {
    const dimKeys = Object.keys(dimensions);
    const doc: EmfDoc = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: {
          Namespace: NAMESPACE,
          Dimensions: [dimKeys],
          Metrics: [{ Name: name, Unit: unit }],
        },
      },
      [name]: value,
      ...dimensions,
    };
    console.log(JSON.stringify(doc));
  }
}

export const metrics = new MetricsClient();

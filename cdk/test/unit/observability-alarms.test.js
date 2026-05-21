'use strict';

// Guard test for issue #50 + #109 + #113 + #114 + #130:
// observability-stack wires several CloudWatch alarms. Originally
// (#50) all 7 alarms were single account-wide constructs with
// hardcoded names. Subsequent PRs broke account-wide aggregation
// problems by switching to per-function / per-table loops:
//   #109  → LambdaErrorAlarm-<fn>, LambdaDurationAlarm-<fn>, DynamoThrottleAlarm-<table>
//   #113  → WebSocketClientErrorAlarm + WebSocketExecutionErrorAlarm
//   #130  → LambdaThrottleAlarm-<fn>
// Three alarms remain as single-instance: ApiErrorRateAlarm,
// Api4xxRateAlarm, and the WS pair.
//
// Full stack synth requires httpApi/webSocketApi/main-Table/connections-
// Table props — heavyweight to mock. Source-level grep is fine here.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../lib/observability-stack.js'),
  'utf8',
);

function alarmBlockFor(constructId) {
  const start = SRC.indexOf(`new cloudwatch.Alarm(this, '${constructId}'`);
  if (start === -1) {
    throw new Error(`missing Alarm: ${constructId}`);
  }
  const closeIdx = SRC.indexOf('});', start);
  return SRC.slice(start, closeIdx + 3);
}

describe('Observability alarms (issues #50, #109, #113, #114, #130)', () => {
  test('singleton alarms (API-level + WS pair) are declared', () => {
    const expectedSingletons = [
      'ApiErrorRateAlarm',
      'Api4xxRateAlarm',
      'WebSocketClientErrorAlarm',
      'WebSocketExecutionErrorAlarm',
    ];
    for (const id of expectedSingletons) {
      expect(SRC).toContain(`new cloudwatch.Alarm(this, '${id}'`);
    }
  });

  test('per-function Lambda alarms (Errors / Duration / Throttles) are templated', () => {
    // The construct IDs are template-literal expressions like
    // `LambdaErrorAlarm-${fnName}` — assert each template exists.
    expect(SRC).toContain('new cloudwatch.Alarm(this, `LambdaErrorAlarm-${fnName}`');
    expect(SRC).toContain('new cloudwatch.Alarm(this, `LambdaDurationAlarm-${fnName}`');
    expect(SRC).toContain('new cloudwatch.Alarm(this, `LambdaThrottleAlarm-${fnName}`');
  });

  test('per-table DDB throttle alarms are templated', () => {
    expect(SRC).toContain('new cloudwatch.Alarm(this, `DynamoThrottleAlarm-${table.node.id}`');
  });

  test('per-DLQ message-visible alarms are templated', () => {
    // From #121
    expect(SRC).toContain('new cloudwatch.Alarm(this, `${label}MessagesAlarm`');
  });

  test('Api4xxRateAlarm watches AWS/ApiGateway 4xx, threshold 50 over 2 eval periods', () => {
    const block = alarmBlockFor('Api4xxRateAlarm');
    expect(block).toMatch(/namespace:\s*'AWS\/ApiGateway'/);
    expect(block).toMatch(/metricName:\s*'4xx'/);
    expect(block).toMatch(/threshold:\s*50/);
    expect(block).toMatch(/evaluationPeriods:\s*2/);
  });

  test('WebSocketClientErrorAlarm watches AWS/ApiGateway ClientError', () => {
    const block = alarmBlockFor('WebSocketClientErrorAlarm');
    expect(block).toMatch(/namespace:\s*'AWS\/ApiGateway'/);
    expect(block).toMatch(/metricName:\s*'ClientError'/);
  });

  test('WebSocketExecutionErrorAlarm watches AWS/ApiGateway ExecutionError', () => {
    const block = alarmBlockFor('WebSocketExecutionErrorAlarm');
    expect(block).toMatch(/namespace:\s*'AWS\/ApiGateway'/);
    expect(block).toMatch(/metricName:\s*'ExecutionError'/);
  });

  test('singleton alarms publish to alarmTopic via SnsAction', () => {
    expect(SRC).toMatch(/api4xxAlarm\.addAlarmAction\(new cloudwatchActions\.SnsAction\(alarmTopic\)\)/);
    expect(SRC).toMatch(/wsClientErrorAlarm\.addAlarmAction\(new cloudwatchActions\.SnsAction\(alarmTopic\)\)/);
    expect(SRC).toMatch(/wsExecutionErrorAlarm\.addAlarmAction\(new cloudwatchActions\.SnsAction\(alarmTopic\)\)/);
  });

  test('per-function loops attach an SnsAction in the loop body', () => {
    // Each per-fn loop creates an alarm, then calls .addAlarmAction with SnsAction.
    // Three loops total: Errors, Duration, Throttles.
    const snsActionMatches = SRC.match(/addAlarmAction\(new cloudwatchActions\.SnsAction\(alarmTopic\)\)/g) || [];
    // Should be at least 3 loop-internal calls + 3+ singleton calls (ApiErrorRate,
    // Api4xx, both WS, DLQ loop, DDB loop). Lower-bound conservative: ≥6.
    expect(snsActionMatches.length).toBeGreaterThanOrEqual(6);
  });

  test('no Lambda alarm uses the old single-instance LambdaThrottleAlarm name (#130 tripwire)', () => {
    // The old account-wide alarm name was 'LambdaThrottleAlarm' (no template).
    // After #130, only the templated `LambdaThrottleAlarm-${fnName}` should exist.
    // Match the bare single-quoted form to make sure it's not back.
    expect(SRC).not.toContain("new cloudwatch.Alarm(this, 'LambdaThrottleAlarm'");
  });

  test('no Lambda alarm uses the old single-instance LambdaErrorRateAlarm/LambdaDurationAlarm names (#109 tripwire)', () => {
    expect(SRC).not.toContain("new cloudwatch.Alarm(this, 'LambdaErrorRateAlarm'");
    expect(SRC).not.toContain("new cloudwatch.Alarm(this, 'LambdaDurationAlarm'");
  });

  test('no DDB alarm uses the old single-instance DynamoThrottleAlarm name (#109 tripwire)', () => {
    expect(SRC).not.toContain("new cloudwatch.Alarm(this, 'DynamoThrottleAlarm'");
  });

  test('no WS alarm uses the deprecated WebSocketFailureAlarm/ConnectError name (#113 tripwire)', () => {
    expect(SRC).not.toContain("new cloudwatch.Alarm(this, 'WebSocketFailureAlarm'");
    expect(SRC).not.toContain("'ConnectError'");
  });
});

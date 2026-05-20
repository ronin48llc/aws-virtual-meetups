'use strict';

// Guard test for issue #50: two CloudWatch alarms (Lambda Throttles +
// API 4xx) must remain wired in observability-stack alongside the
// existing five. Full stack synth requires httpApi/webSocketApi/main-
// Table/connectionsTable props — heavyweight to mock. Same source-level
// pattern as PR #43's lambda-timeouts test.

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

describe('Observability alarms (issue #50)', () => {
  test('all 7 expected alarms are declared', () => {
    const expected = [
      'ApiErrorRateAlarm',
      'LambdaErrorRateAlarm',
      'DynamoThrottleAlarm',
      'WebSocketFailureAlarm',
      'LambdaDurationAlarm',
      'LambdaThrottleAlarm',   // new
      'Api4xxRateAlarm',       // new
    ];
    for (const id of expected) {
      expect(SRC).toContain(`new cloudwatch.Alarm(this, '${id}'`);
    }
  });

  test('LambdaThrottleAlarm watches AWS/Lambda Throttles, threshold > 0', () => {
    const block = alarmBlockFor('LambdaThrottleAlarm');
    expect(block).toMatch(/namespace:\s*'AWS\/Lambda'/);
    expect(block).toMatch(/metricName:\s*'Throttles'/);
    expect(block).toMatch(/threshold:\s*0/);
    expect(block).toMatch(/comparisonOperator:\s*cloudwatch\.ComparisonOperator\.GREATER_THAN_THRESHOLD/);
  });

  test('Api4xxRateAlarm watches AWS/ApiGateway 4xx, threshold 50 over 2 eval periods', () => {
    const block = alarmBlockFor('Api4xxRateAlarm');
    expect(block).toMatch(/namespace:\s*'AWS\/ApiGateway'/);
    expect(block).toMatch(/metricName:\s*'4xx'/);
    expect(block).toMatch(/threshold:\s*50/);
    expect(block).toMatch(/evaluationPeriods:\s*2/);
  });

  test('both new alarms publish to alarmTopic via SnsAction', () => {
    expect(SRC).toMatch(/lambdaThrottleAlarm\.addAlarmAction\(new cloudwatchActions\.SnsAction\(alarmTopic\)\)/);
    expect(SRC).toMatch(/api4xxAlarm\.addAlarmAction\(new cloudwatchActions\.SnsAction\(alarmTopic\)\)/);
  });
});

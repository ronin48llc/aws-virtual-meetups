'use strict';

// Issue #113: the previous WebSocketFailureAlarm referenced
// `ConnectError`, which is not a real CloudWatch metric for API
// Gateway v2 WebSocket APIs. The alarm sat in INSUFFICIENT_DATA
// forever. This file regresses against that bug — assert the
// alarms use the actual metric names (ClientError, ExecutionError)
// with the correct (ApiId + Stage) dimensions.
//
// Kept in its own file to avoid a merge conflict with the parallel
// observability-stack.test.js introduced by #109.

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const { ObservabilityStack } = require('../../lib/observability-stack');

function buildTemplate() {
  const app = new App();
  const parent = new Stack(app, 'TestParent', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const mainTable = new dynamodb.Table(parent, 'TestMainTable', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  });
  const connectionsTable = new dynamodb.Table(parent, 'TestConnectionsTable', {
    partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
  });
  const stack = new ObservabilityStack(app, 'TestObsWs', {
    env: { account: '123456789012', region: 'us-east-1' },
    mainTable,
    connectionsTable,
  });
  return Template.fromStack(stack);
}

describe('ObservabilityStack — WebSocket failure alarms (#113)', () => {
  let template;

  beforeAll(() => {
    template = buildTemplate();
  });

  test('synthesizes a ClientError alarm with ApiId + Stage dimensions', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const clientErrorAlarm = Object.values(alarms).find((a) =>
      a.Properties.MetricName === 'ClientError' && a.Properties.Namespace === 'AWS/ApiGateway'
    );
    expect(clientErrorAlarm).toBeDefined();

    const dimNames = clientErrorAlarm.Properties.Dimensions.map((d) => d.Name).sort();
    expect(dimNames).toEqual(['ApiId', 'Stage']);
  });

  test('synthesizes an ExecutionError alarm with ApiId + Stage dimensions', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const execErrorAlarm = Object.values(alarms).find((a) =>
      a.Properties.MetricName === 'ExecutionError' && a.Properties.Namespace === 'AWS/ApiGateway'
    );
    expect(execErrorAlarm).toBeDefined();

    const dimNames = execErrorAlarm.Properties.Dimensions.map((d) => d.Name).sort();
    expect(dimNames).toEqual(['ApiId', 'Stage']);
  });

  test('NO alarm references the non-existent ConnectError metric (#113 tripwire)', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const connectErrorAlarms = Object.values(alarms).filter((a) =>
      a.Properties.MetricName === 'ConnectError'
    );
    expect(connectErrorAlarms).toEqual([]);
  });

  test('ClientError alarm includes a stage value (not just the dimension key)', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const clientErrorAlarm = Object.values(alarms).find((a) =>
      a.Properties.MetricName === 'ClientError' && a.Properties.Namespace === 'AWS/ApiGateway'
    );
    expect(clientErrorAlarm).toBeDefined();
    const stageDim = clientErrorAlarm.Properties.Dimensions.find((d) => d.Name === 'Stage');
    expect(stageDim).toBeDefined();
    expect(typeof stageDim.Value).toBe('string');
    expect(stageDim.Value.length).toBeGreaterThan(0);
  });
});

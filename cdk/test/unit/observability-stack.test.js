'use strict';

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const { ObservabilityStack } = require('../../lib/observability-stack');

// Issue #109: alarms must scope to platform resources via FunctionName /
// TableName dimensions. Without dimensions, AWS/Lambda Errors and
// AWS/DynamoDB ThrottledRequests aggregate across the entire account.

// Function names carry the env suffix (withEnv in api-stack.js); tests
// synth without -c env so the default 'dev' applies.
const PLATFORM_LAMBDAS = [
  'VirtualMeetup-EventCrud-dev',
  'VirtualMeetup-SessionManager-dev',
  'VirtualMeetup-TokenGenerator-dev',
  'VirtualMeetup-Signup-dev',
  'VirtualMeetup-WsConnect-dev',
  'VirtualMeetup-WsDisconnect-dev',
  'VirtualMeetup-WsSignaling-dev',
];

function buildStack() {
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
  const stack = new ObservabilityStack(app, 'TestObs', {
    env: { account: '123456789012', region: 'us-east-1' },
    mainTable,
    connectionsTable,
  });
  return Template.fromStack(stack);
}

describe('ObservabilityStack — alarm dimension scoping (#109)', () => {
  let template;

  beforeAll(() => {
    template = buildStack();
  });

  describe('per-function Lambda error alarms', () => {
    test.each(PLATFORM_LAMBDAS)('alarm for %s scopes to FunctionName', (fnName) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `${fnName}-Errors`,
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Dimensions: Match.arrayWith([
          { Name: 'FunctionName', Value: fnName },
        ]),
      });
    });
  });

  describe('per-function Lambda duration alarms', () => {
    test.each(PLATFORM_LAMBDAS)('p99 duration alarm for %s scopes to FunctionName', (fnName) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `${fnName}-Duration`,
        Namespace: 'AWS/Lambda',
        MetricName: 'Duration',
        ExtendedStatistic: 'p99',
        Threshold: 5000,
        Dimensions: Match.arrayWith([
          { Name: 'FunctionName', Value: fnName },
        ]),
      });
    });
  });

  describe('per-table DDB throttle alarms', () => {
    test('synthesizes a TableName-scoped throttle alarm for the main table', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/DynamoDB',
        MetricName: 'ThrottledRequests',
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'TableName' }),
        ]),
      });
    });

    test('exactly 2 DDB throttle alarms (main + connections)', () => {
      // No selector beyond namespace+metric, so use findResources and filter.
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const ddbThrottleAlarms = Object.values(alarms).filter((alarm) => {
        const m = alarm.Properties;
        return m.Namespace === 'AWS/DynamoDB' && m.MetricName === 'ThrottledRequests';
      });
      expect(ddbThrottleAlarms.length).toBe(2);
      ddbThrottleAlarms.forEach((alarm) => {
        const tableName = alarm.Properties.Dimensions.find((d) => d.Name === 'TableName');
        expect(tableName).toBeDefined();
        expect(tableName.Value).toBeTruthy();
      });
    });
  });

  describe('regression — no unscoped Lambda or DDB alarms', () => {
    test('no Lambda alarm omits the FunctionName dimension', () => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const lambdaAlarms = Object.values(alarms).filter((alarm) =>
        alarm.Properties.Namespace === 'AWS/Lambda'
      );
      lambdaAlarms.forEach((alarm) => {
        const dims = alarm.Properties.Dimensions || [];
        const hasFnName = dims.some((d) => d.Name === 'FunctionName');
        expect(hasFnName).toBe(true);
      });
    });

    test('no DDB alarm omits the TableName dimension', () => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const ddbAlarms = Object.values(alarms).filter((alarm) =>
        alarm.Properties.Namespace === 'AWS/DynamoDB'
      );
      ddbAlarms.forEach((alarm) => {
        const dims = alarm.Properties.Dimensions || [];
        const hasTableName = dims.some((d) => d.Name === 'TableName');
        expect(hasTableName).toBe(true);
      });
    });
  });
});

describe('alarm email subscribers', () => {
  function synth(context) {
    const { App, Stack } = require('aws-cdk-lib');
    const dynamodb = require('aws-cdk-lib/aws-dynamodb');
    const app = new App({ context });
    const parent = new Stack(app, 'Parent', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const mainTable = new dynamodb.Table(parent, 'Main', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    });
    const connectionsTable = new dynamodb.Table(parent, 'Conn', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
    });
    return Template.fromStack(new ObservabilityStack(app, 'Obs', {
      env: { account: '123456789012', region: 'us-east-1' },
      mainTable,
      connectionsTable,
    }));
  }

  test('comma-separated -c alarmEmails string subscribes each address', () => {
    const template = synth({ alarmEmails: 'a@example.com, b@example.com' });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'a@example.com',
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'b@example.com',
    });
  });

  test('prod without alarmEmails refuses to synth', () => {
    expect(() => synth({ env: 'prod' })).toThrow(/alarmEmails/);
  });

  test('prod with alarmEmails synths', () => {
    expect(() => synth({ env: 'prod', alarmEmails: 'ops@example.com' })).not.toThrow();
  });
});

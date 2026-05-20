'use strict';

// Issue #121: PublicationDLQ and EmailDLQ have 14-day retention but no
// alarms. Messages accumulate silently; operators only find out a meetup
// never published or a reminder never went out when a user complains.
// observability-stack now creates one alarm per DLQ on
// AWS/SQS ApproximateNumberOfMessagesVisible > 0.
//
// Kept separate from the parallel observability-stack.test.js and
// observability-ws-alarms.test.js to avoid merge conflicts with #109/#113.

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const sqs = require('aws-cdk-lib/aws-sqs');
const { ObservabilityStack } = require('../../lib/observability-stack');

function buildTemplate({ withDlqs = true } = {}) {
  const app = new App();
  const parent = new Stack(app, 'TestParentDlqAlarm', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const mainTable = new dynamodb.Table(parent, 'TestMainTable', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  });
  const connectionsTable = new dynamodb.Table(parent, 'TestConnectionsTable', {
    partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
  });

  const props = {
    env: { account: '123456789012', region: 'us-east-1' },
    mainTable,
    connectionsTable,
  };

  if (withDlqs) {
    props.publicationDlq = new sqs.Queue(parent, 'TestPubDlq', {
      queueName: 'TestVirtualMeetup-PublicationDLQ',
    });
    props.emailDlq = new sqs.Queue(parent, 'TestEmailDlq', {
      queueName: 'TestVirtualMeetup-EmailDLQ',
    });
  }

  const stack = new ObservabilityStack(app, 'TestObsDlqAlarm', props);
  return Template.fromStack(stack);
}

describe('ObservabilityStack — DLQ alarms (#121)', () => {
  describe('with both DLQs provided', () => {
    let template;
    beforeAll(() => {
      template = buildTemplate({ withDlqs: true });
    });

    test('creates exactly 2 SQS-namespace alarms', () => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const sqsAlarms = Object.values(alarms).filter(
        (a) => a.Properties.Namespace === 'AWS/SQS'
      );
      expect(sqsAlarms.length).toBe(2);
    });

    test('PublicationDLQ alarm exists with QueueName dimension', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: Match.stringLikeRegexp('VirtualMeetup-.*-PublicationDLQ-MessagesVisible'),
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 0,
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'QueueName' }),
        ]),
      });
    });

    test('EmailDLQ alarm exists with QueueName dimension', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: Match.stringLikeRegexp('VirtualMeetup-.*-EmailDLQ-MessagesVisible'),
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 0,
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'QueueName' }),
        ]),
      });
    });

    test('DLQ alarms fire on >0 messages (Maximum statistic, GreaterThanThreshold)', () => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const dlqAlarms = Object.values(alarms).filter(
        (a) => a.Properties.Namespace === 'AWS/SQS'
      );
      dlqAlarms.forEach((alarm) => {
        expect(alarm.Properties.Statistic).toBe('Maximum');
        expect(alarm.Properties.ComparisonOperator).toBe('GreaterThanThreshold');
        expect(alarm.Properties.Threshold).toBe(0);
      });
    });
  });

  describe('without DLQs (back-compat for isolated unit tests)', () => {
    test('stack still synthesizes with zero SQS alarms', () => {
      const template = buildTemplate({ withDlqs: false });
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const sqsAlarms = Object.values(alarms).filter(
        (a) => a.Properties.Namespace === 'AWS/SQS'
      );
      expect(sqsAlarms.length).toBe(0);
    });
  });
});

'use strict';

// Issue #115: the recording bucket must have eventBridgeEnabled:true so
// the PublicationStack's EventBridge Rule (RecordingCreatedRule) actually
// fires when IVS Composition writes metadata.json. Without it, no
// publication ever happens.
//
// Kept in its own file to avoid a merge conflict with the parallel
// streaming-stack.test.js introduced by #101.

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { StreamingStack } = require('../../lib/streaming-stack');

describe('StreamingStack — recording bucket EventBridge wiring (#115)', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const stack = new StreamingStack(app, 'TestStreamingEBStack');
    template = Template.fromStack(stack);
  });

  test('recording bucket synthesizes NotificationConfiguration with EventBridge enabled', () => {
    // CDK adds a Custom Resource (BucketNotificationsHandler) when
    // eventBridgeEnabled:true is set on the bucket. The Custom Resource
    // installs the NotificationConfiguration on the bucket via the AWS SDK
    // at deploy-time. So we assert the Custom Resource exists and has an
    // EventBridgeConfiguration in its props.
    const custom = template.findResources('Custom::S3BucketNotifications');
    const entries = Object.values(custom);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const recordingBucketNotification = entries.find((r) => {
      const notif = r.Properties && r.Properties.NotificationConfiguration;
      return notif && notif.EventBridgeConfiguration !== undefined;
    });
    expect(recordingBucketNotification).toBeDefined();
  });

  test('recording bucket has BLOCK_ALL public access (regression — unchanged)', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

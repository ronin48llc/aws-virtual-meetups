'use strict';

// Tests for issue #52: the recordings bucket emits server access logs
// to a separate retained log bucket. Both must be present in the
// synthesized template with the right linkage.

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { StreamingStack } = require('../../lib/streaming-stack');

function synth() {
  const app = new App();
  const stack = new StreamingStack(app, 'TestStreamingStackAccessLogs');
  return Template.fromStack(stack);
}

describe('StreamingStack recording bucket server access logs (issue #52)', () => {
  test('three S3 buckets exist (recordings + S3 access-logs target + CloudFront access-logs target)', () => {
    // #139 added RecordingAccessLogsBucket (S3 server access logs); #59
    // had already added RecordingDistributionAccessLogsBucket (CloudFront
    // access logs). Both are RETAIN'd log sinks alongside the main
    // RecordingBucket. The test originally asserted exactly 2 buckets,
    // which broke once the CloudFront log bucket landed.
    const template = synth();
    template.resourceCountIs('AWS::S3::Bucket', 3);
  });

  test('recording bucket has LoggingConfiguration pointing at a destination bucket', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LoggingConfiguration: Match.objectLike({
        DestinationBucketName: Match.anyValue(),
        LogFilePrefix: 'recordings/',
      }),
    });
  });

  test('access-logs bucket has 365-day expiration and abort-incomplete-multipart rules', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ExpireAccessLogs',
            ExpirationInDays: 365,
            AbortIncompleteMultipartUpload: Match.objectLike({ DaysAfterInitiation: 7 }),
          }),
        ]),
      },
    });
  });

  test('access-logs bucket is RETAIN on destroy and has S3-managed encryption', () => {
    const template = synth();
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({
                SSEAlgorithm: 'AES256',
              }),
            }),
          ]),
        }),
      }),
    });
  });
});

'use strict';

// Tests for issue #58: the recording CloudFront distribution must emit
// access logs to a separate retained bucket. Written as its own file
// to avoid merge conflicts with PR #27's lifecycle tests and PR #53's
// S3-access-logs tests against the same stack.

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { StreamingStack } = require('../../lib/streaming-stack');

function synth() {
  const app = new App();
  const stack = new StreamingStack(app, 'TestStreamingStackCfLogs');
  return Template.fromStack(stack);
}

describe('StreamingStack recording CloudFront access logs (issue #58)', () => {
  test('recording distribution has Logging configured with the recording-cf/ prefix', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: Match.objectLike({
          Bucket: Match.anyValue(),
          Prefix: 'recording-cf/',
        }),
      }),
    });
  });

  test('a bucket exists with OBJECT_WRITER ownership (required for CloudFront log delivery)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      OwnershipControls: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({ ObjectOwnership: 'ObjectWriter' }),
        ]),
      }),
    });
  });

  test('CF access logs bucket has 365-day expiration + multipart abort', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ExpireRecordingDistributionAccessLogs',
            ExpirationInDays: 365,
            AbortIncompleteMultipartUpload: Match.objectLike({ DaysAfterInitiation: 7 }),
          }),
        ]),
      },
    });
  });
});

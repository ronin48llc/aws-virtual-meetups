'use strict';

// Tests for issue #54: the SPA CloudFront distribution must emit
// access logs to a separate retained bucket. Written as its own file
// to avoid a merge conflict with PR #39's frontend-stack.test.js
// (which lands the cache-policy assertions).

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { FrontendStack } = require('../../lib/frontend-stack');

function synth() {
  const app = new App();
  const stack = new FrontendStack(app, 'TestFrontendAccessLogStack', {});
  return Template.fromStack(stack);
}

describe('FrontendStack CloudFront access logs (issue #54)', () => {
  test('distribution has Logging configured with a non-empty Bucket and Prefix', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: Match.objectLike({
          Bucket: Match.anyValue(),
          Prefix: 'frontend/',
        }),
      }),
    });
  });

  test('access-logs bucket exists with OBJECT_WRITER ownership (required for CloudFront)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      OwnershipControls: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({ ObjectOwnership: 'ObjectWriter' }),
        ]),
      }),
    });
  });

  test('access-logs bucket has 365-day expiration + multipart abort', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ExpireFrontendAccessLogs',
            ExpirationInDays: 365,
            AbortIncompleteMultipartUpload: Match.objectLike({ DaysAfterInitiation: 7 }),
          }),
        ]),
      },
    });
  });

  test('access-logs bucket is RETAIN on destroy', () => {
    const template = synth();
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({
        OwnershipControls: Match.anyValue(),
      }),
    });
  });
});

'use strict';

// Tests for issue #38: the SPA distribution must not cache responses
// (stable filenames + no Cache-Control => stale shells after deploy).

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { FrontendStack } = require('../../lib/frontend-stack');

function synth() {
  const app = new App();
  const stack = new FrontendStack(app, 'TestFrontendStack', {});
  return Template.fromStack(stack);
}

describe('FrontendStack CloudFront cache policy (issue #38)', () => {
  // CachePolicy.CACHING_DISABLED is a CloudFront managed policy with a known
  // fixed UUID across all accounts.
  const CACHING_DISABLED_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

  test('default behavior uses the managed CACHING_DISABLED policy', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          CachePolicyId: CACHING_DISABLED_POLICY_ID,
        }),
      }),
    });
  });

  test('default behavior still redirects HTTP to HTTPS', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });
});

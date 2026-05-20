'use strict';

/**
 * Verifies the CloudFront ResponseHeadersPolicy introduced for issue #3.
 * The policy attaches CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
 * and Referrer-Policy to every response from the frontend distribution.
 */

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { FrontendStack } = require('../../lib/frontend-stack');

describe('FrontendStack — CloudFront security response headers (issue #3)', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const stack = new FrontendStack(app, 'TestFrontendStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('creates a ResponseHeadersPolicy with a stack-scoped name', () => {
    // Issue #105 changed the policy name from the hardcoded
    // 'VirtualMeetup-FrontendSecurityHeaders' to a stack-scoped form so
    // multiple stacks (dev/prod) can coexist without name collisions.
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: Match.stringLikeRegexp('^VirtualMeetupFrontendSecurityHeaders-'),
      }),
    });
  });

  test('sets a Content-Security-Policy with default-src self', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'"),
            Override: true,
          }),
        }),
      }),
    });
  });

  test('CSP whitelists the IVS Web Broadcast SDK and jsdelivr CDN for script-src', () => {
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const policy = Object.values(policies)[0];
    const csp = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain('web-broadcast.live-video.net');
    expect(csp).toContain('cdn.jsdelivr.net');
    expect(csp).toMatch(/script-src[^;]*'self'/);
  });

  test('CSP blocks framing with frame-ancestors none', () => {
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const policy = Object.values(policies)[0];
    const csp = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test('omits Strict-Transport-Security on the no-cert stack', () => {
    // Issue #105 made HSTS conditional: only set when a real cert + custom
    // domain are wired (otherwise HSTS on a shared *.cloudfront.net domain
    // would lock other apps into HTTPS-only). The with-cert path is covered
    // by the "with custom domain + certificate" describe block in
    // frontend-stack.test.js.
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.absent(),
        }),
      }),
    });
  });

  test('sets X-Frame-Options to DENY', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          FrameOptions: Match.objectLike({
            FrameOption: 'DENY',
            Override: true,
          }),
        }),
      }),
    });
  });

  test('sets X-Content-Type-Options nosniff', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentTypeOptions: Match.objectLike({
            Override: true,
          }),
        }),
      }),
    });
  });

  test('sets Referrer-Policy to strict-origin-when-cross-origin', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ReferrerPolicy: Match.objectLike({
            ReferrerPolicy: 'strict-origin-when-cross-origin',
            Override: true,
          }),
        }),
      }),
    });
  });

  test('CloudFront distribution attaches the security headers policy on the default behavior', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
      }),
    });
  });
});

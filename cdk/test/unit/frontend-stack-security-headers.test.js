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

  test('creates a ResponseHeadersPolicy named VirtualMeetup-FrontendSecurityHeaders', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: 'VirtualMeetup-FrontendSecurityHeaders',
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

  test('sets Strict-Transport-Security with one-year max-age + includeSubdomains + preload', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 365 * 24 * 60 * 60,
            IncludeSubdomains: true,
            Preload: true,
            Override: true,
          }),
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

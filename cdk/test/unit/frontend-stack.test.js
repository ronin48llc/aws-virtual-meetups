'use strict';

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { FrontendStack } = require('../../lib/frontend-stack');

// Issue #105: the frontend CloudFront distribution must ship baseline
// security response headers (HSTS conditional on real domain;
// X-Frame-Options, X-Content-Type-Options, Referrer-Policy always).

describe('FrontendStack — security headers (#105)', () => {
  describe('without custom domain (auto-assigned *.cloudfront.net)', () => {
    let template;

    beforeAll(() => {
      const app = new App();
      const stack = new FrontendStack(app, 'TestFrontendNoCert', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      template = Template.fromStack(stack);
    });

    test('creates a ResponseHeadersPolicy', () => {
      template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
    });

    test('policy includes ContentTypeOptions with override', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: Match.objectLike({
            ContentTypeOptions: { Override: true },
          }),
        },
      });
    });

    test('policy includes FrameOptions DENY with override', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: Match.objectLike({
            FrameOptions: { FrameOption: 'DENY', Override: true },
          }),
        },
      });
    });

    test('policy includes ReferrerPolicy strict-origin-when-cross-origin', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: Match.objectLike({
            ReferrerPolicy: {
              ReferrerPolicy: 'strict-origin-when-cross-origin',
              Override: true,
            },
          }),
        },
      });
    });

    test('policy OMITS StrictTransportSecurity on the *.cloudfront.net domain', () => {
      // HSTS would lock the shared CloudFront domain into a year-long
      // HTTPS-only state across every app using it — only set when a
      // real ACM cert + custom domain are wired.
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.absent(),
          }),
        },
      });
    });

    test('distribution defaultCacheBehavior references the policy', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: Match.objectLike({
            ResponseHeadersPolicyId: Match.anyValue(),
          }),
        },
      });
    });
  });

  describe('with custom domain + certificate (HSTS enabled)', () => {
    let template;

    beforeAll(() => {
      // Construct minimal stand-ins for hostedZone + certificate. The
      // FrontendStack uses targets.CloudFrontTarget which needs a real
      // HostedZone instance, so build a parent stack with one.
      const { Stack } = require('aws-cdk-lib');
      const route53 = require('aws-cdk-lib/aws-route53');
      const acm = require('aws-cdk-lib/aws-certificatemanager');

      const app = new App();
      const parent = new Stack(app, 'TestParent', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const hostedZone = new route53.HostedZone(parent, 'TestZone', {
        zoneName: 'example.invalid',
      });
      // ACM cert built with no validation — synth-only test, no deployment.
      const certificate = acm.Certificate.fromCertificateArn(
        parent, 'TestCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id'
      );

      const stack = new FrontendStack(app, 'TestFrontendWithCert', {
        env: { account: '123456789012', region: 'us-east-1' },
        hostedZone,
        certificate,
        domainNames: ['example.invalid'],
      });
      template = Template.fromStack(stack);
    });

    test('policy INCLUDES StrictTransportSecurity when custom domain is wired', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 365 * 24 * 60 * 60,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            },
          }),
        },
      });
    });
  });
});

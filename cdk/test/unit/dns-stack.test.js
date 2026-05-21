'use strict';

// Issue #147: DnsStack must fail loudly at synth-time if hostedZoneId or
// domainName context is missing — the previous defaults
// ('YOUR_HOSTED_ZONE_ID' / 'yourdomain.com') let synth succeed with
// placeholder values, deferring failure to a slow CloudFormation
// rollback when the cert validation hit a nonexistent zone.

const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { DnsStack } = require('../../lib/dns-stack');

describe('DnsStack — synth-time deploy safety (#147)', () => {
  test('throws when hostedZoneId context is missing', () => {
    const app = new App({ context: { domainName: 'example.invalid' } });
    expect(() => new DnsStack(app, 'TestDnsNoZone')).toThrow(/hostedZoneId/);
  });

  test('throws when hostedZoneId is the placeholder', () => {
    const app = new App({
      context: { hostedZoneId: 'YOUR_HOSTED_ZONE_ID', domainName: 'example.invalid' },
    });
    expect(() => new DnsStack(app, 'TestDnsPlaceholderZone')).toThrow(/hostedZoneId/);
  });

  test('throws when domainName context is missing', () => {
    const app = new App({ context: { hostedZoneId: 'Z01ABCDEFGHIJ' } });
    expect(() => new DnsStack(app, 'TestDnsNoDomain')).toThrow(/domainName/);
  });

  test('throws when domainName is the placeholder', () => {
    const app = new App({
      context: { hostedZoneId: 'Z01ABCDEFGHIJ', domainName: 'yourdomain.com' },
    });
    expect(() => new DnsStack(app, 'TestDnsPlaceholderDomain')).toThrow(/domainName/);
  });

  test('synthesizes a Certificate resource when both context values are provided', () => {
    const app = new App({
      context: { hostedZoneId: 'Z01ABCDEFGHIJ', domainName: 'example.invalid' },
    });
    const stack = new DnsStack(app, 'TestDnsOk', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'example.invalid',
      SubjectAlternativeNames: ['*.example.invalid'],
    });
  });
});

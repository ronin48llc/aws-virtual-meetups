const { Stack, CfnOutput } = require('aws-cdk-lib');
const route53 = require('aws-cdk-lib/aws-route53');
const acm = require('aws-cdk-lib/aws-certificatemanager');

/**
 * DNS Stack for the Virtual Meetup Platform.
 *
 * Looks up the existing Route53 hosted zone for awsvirtualmeetups.com (created
 * by the Route53 domain registrar) and creates an ACM certificate covering the
 * apex domain and wildcard (*.awsvirtualmeetups.com), validated via DNS.
 *
 * Exports hostedZone and certificate for cross-stack use by FrontendStack,
 * ApiStack, and EmailStack.
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4
 */
class DnsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // -------------------------------------------------------
    // Route53 Public Hosted Zone (lookup existing)
    // The domain is registered in Route53, so the hosted zone already exists.
    // Requirements: 1.1, 1.2, 1.3
    //
    // Issue #147: synth-time validation. The previous default
    // ('YOUR_HOSTED_ZONE_ID' / 'yourdomain.com') let synth succeed with
    // placeholder values, deferring failure 10+ minutes into CloudFormation
    // when the cert tried to validate against a nonexistent zone. Fail
    // loudly with an actionable message instead.
    // -------------------------------------------------------
    const hostedZoneId = this.node.tryGetContext('hostedZoneId');
    const domainName = this.node.tryGetContext('domainName');
    if (!hostedZoneId || hostedZoneId === 'YOUR_HOSTED_ZONE_ID') {
      throw new Error(
        'DnsStack: -c hostedZoneId=<Z...> is required. Find your zone ID with:\n' +
        '  aws route53 list-hosted-zones-by-name --dns-name <your-domain.com>'
      );
    }
    if (!domainName || domainName === 'yourdomain.com') {
      throw new Error('DnsStack: -c domainName=<your-domain.com> is required.');
    }

    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: hostedZoneId,
      zoneName: domainName,
    });

    // -------------------------------------------------------
    // ACM Certificate (apex + wildcard, DNS-validated)
    // Requirements: 2.1, 2.2, 2.3, 2.4
    // -------------------------------------------------------
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    // -------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route53 Hosted Zone ID for awsvirtualmeetups.com',
    });

    new CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM certificate ARN for TLS termination',
    });
  }
}

module.exports = { DnsStack };

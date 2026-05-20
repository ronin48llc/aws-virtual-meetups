const { Stack, CfnOutput, RemovalPolicy } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const route53 = require('aws-cdk-lib/aws-route53');
const targets = require('aws-cdk-lib/aws-route53-targets');
const { WafConstruct } = require('./waf-construct');

/**
 * Frontend stack for the Virtual Meetup Platform.
 *
 * Creates an S3 bucket for SPA hosting and a CloudFront distribution
 * with Origin Access Identity for secure access. Custom error responses
 * route 403/404 to index.html for client-side routing.
 *
 * WAF WebACL (CLOUDFRONT scope) is attached for DDoS/rate-limit protection.
 *
 * Optional props for custom domain support:
 * - hostedZone: Route53 hosted zone for creating A record aliases
 * - certificate: ACM certificate for CloudFront TLS termination
 * - domainNames: Array of alternate domain names for the distribution
 *
 * Requirements: 20.2, 3.1, 3.2, 3.3, 3.4, 3.5
 */
class FrontendStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // -------------------------------------------------------
    // S3 Bucket for SPA hosting
    // -------------------------------------------------------
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // -------------------------------------------------------
    // CloudFront Origin Access Identity (OAI)
    // -------------------------------------------------------
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(
      this,
      'FrontendOAI',
      {
        comment: 'OAI for Virtual Meetup Platform frontend bucket',
      }
    );

    // Grant CloudFront OAI read access to the S3 bucket
    this.frontendBucket.grantRead(originAccessIdentity);

    // -------------------------------------------------------
    // WAF WebACL (CLOUDFRONT scope) for DDoS protection
    // -------------------------------------------------------
    const waf = new WafConstruct(this, 'FrontendWaf', {
      scope: 'CLOUDFRONT',
    });

    // -------------------------------------------------------
    // CloudFront Distribution
    // Requirements: 3.1, 3.2
    // -------------------------------------------------------
    const { hostedZone, certificate, domainNames } = props;

    const distributionProps = {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(this.frontendBucket, {
          originAccessIdentity,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // CachePolicy.CACHING_DISABLED: every viewer request goes to S3.
        // The SPA's JS/CSS asset names are NOT content-hashed (frontend/
        // index.html references js/app.js, css/styles.css by stable name),
        // so the default CACHING_OPTIMIZED policy (24h DefaultTTL) would
        // serve stale shells for up to a day after each deploy. Latency
        // hit at this scale (~50ms) is acceptable; once the build emits
        // hashed asset filenames, switch this back to CACHING_OPTIMIZED
        // and add a short-TTL behavior for *.html / `/`. See issue #38.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: waf.webAcl.attrArn,
    };

    // Add custom domain configuration if certificate and domainNames are provided
    if (domainNames && certificate) {
      distributionProps.domainNames = domainNames;
      distributionProps.certificate = certificate;
    }

    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', distributionProps);

    // -------------------------------------------------------
    // Route53 A Record Aliases (custom domain)
    // Requirements: 3.3, 3.4, 3.5
    // -------------------------------------------------------
    if (hostedZone && domainNames) {
      domainNames.forEach((domainName, index) => {
        new route53.ARecord(this, `AliasRecord${index}`, {
          zone: hostedZone,
          recordName: domainName,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(this.distribution)
          ),
        });
      });
    }

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'DistributionUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront distribution URL for the frontend SPA',
    });

    new CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      description: 'S3 bucket name for frontend assets',
    });
  }
}

module.exports = { FrontendStack };

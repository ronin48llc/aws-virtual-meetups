const { Construct } = require('constructs');
const { CfnOutput } = require('aws-cdk-lib');
const wafv2 = require('aws-cdk-lib/aws-wafv2');

/**
 * Reusable WAF WebACL construct for protecting public-facing endpoints.
 *
 * Supports two scopes:
 * - REGIONAL: For API Gateway REST/WebSocket APIs
 * - CLOUDFRONT: For CloudFront distributions (must be deployed in us-east-1)
 *
 * Includes:
 * - IP rate-limiting (100 req/min unauthenticated, 500 req/min authenticated)
 * - AWS Managed Rules (Common, SQLi, Known Bad Inputs)
 * - Size restriction rule (4KB max body for WebSocket payloads)
 * - 5-minute block on rate limit breach with HTTP 429 response
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4
 */
class WafConstruct extends Construct {
  /**
   * @param {Construct} scope
   * @param {string} id
   * @param {Object} props
   * @param {string} props.scope - WAF scope: 'REGIONAL' or 'CLOUDFRONT'
   * @param {string[]} [props.resourceArns] - ARNs of resources to associate (REGIONAL only)
   */
  constructor(scope, id, props = {}) {
    super(scope, id);

    const wafScope = props.scope || 'REGIONAL';

    // Custom response body for 429 Too Many Requests
    const customResponseBodies = {
      RateLimitExceeded: {
        contentType: 'APPLICATION_JSON',
        content: JSON.stringify({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again in 5 minutes.',
          statusCode: 429,
        }),
      },
    };

    // -------------------------------------------------------
    // WAF WebACL
    // -------------------------------------------------------
    this.webAcl = new wafv2.CfnWebACL(this, 'WebACL', {
      name: `${id}-WebACL`,
      scope: wafScope,
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${id}-WebACL`,
        sampledRequestsEnabled: true,
      },
      customResponseBodies,
      rules: [
        // Rule 1: IP Rate Limit - Unauthenticated (100 requests per 5 minutes = ~100/min)
        // WAF evaluates rate over 5-minute windows, so 100 req/min = 500 per 5 min window
        this._createUnauthenticatedRateLimitRule(),

        // Rule 2: IP Rate Limit - Authenticated (500 requests per 5 minutes = ~500/min)
        // WAF evaluates rate over 5-minute windows, so 500 req/min = 2500 per 5 min window
        this._createAuthenticatedRateLimitRule(),

        // Rule 3: AWS Managed Rules - Common Rule Set (XSS, etc.)
        this._createManagedRuleGroup('AWSManagedRulesCommonRuleSet', 'AWS', 10),

        // Rule 4: AWS Managed Rules - SQL Injection
        this._createManagedRuleGroup('AWSManagedRulesSQLiRuleSet', 'AWS', 20),

        // Rule 5: AWS Managed Rules - Known Bad Inputs
        this._createManagedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 'AWS', 30),

        // Rule 6: AWS Managed Rules - Amazon IP Reputation List
        // Free, AWS-curated block list of IPs currently flagged by AWS
        // threat intel (botnets, scanners, recent-attack sources). See #40.
        this._createManagedRuleGroup('AWSManagedRulesAmazonIpReputationList', 'AWS', 35),

        // Rule 7: Size Restriction - 4KB max body for WebSocket/Chat payloads
        this._createSizeRestrictionRule(),
      ],
    });

    // -------------------------------------------------------
    // WebACL Associations (REGIONAL scope only)
    // -------------------------------------------------------
    if (wafScope === 'REGIONAL' && props.resourceArns) {
      props.resourceArns.forEach((arn, index) => {
        new wafv2.CfnWebACLAssociation(this, `WebACLAssociation${index}`, {
          resourceArn: arn,
          webAclArn: this.webAcl.attrArn,
        });
      });
    }

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'WebACLArn', {
      value: this.webAcl.attrArn,
      description: `WAF WebACL ARN (${wafScope})`,
    });
  }

  /**
   * Strict rate limit for public (unauthenticated) endpoints.
   *
   * Issue #97: the previous scope-down filtered by "Authorization header
   * starts with Bearer", which WAF cannot validate as a real JWT. An
   * attacker who added `Authorization: Bearer x` slipped into the lenient
   * authenticated bucket (500/min) instead of the strict 100/min bucket —
   * 5x DoS amplification against `GET /events` and `GET /events/{id}`.
   *
   * Fix: scope-down by URI path. The strict limit applies to known-public
   * paths regardless of headers. Authenticated routes (sit behind Cognito
   * authorizer) fall through to the lenient global limit; fake bearer
   * tokens are 401'd at the authorizer before reaching any Lambda, so the
   * lenient bucket can't be meaningfully abused there.
   *
   * 100 requests per minute = 500 per 5-minute WAF evaluation window.
   * Blocks with HTTP 429 for 5 minutes on breach.
   */
  _createUnauthenticatedRateLimitRule() {
    return {
      name: 'RateLimitPublicEndpoints',
      priority: 1,
      action: {
        block: {
          customResponse: {
            responseCode: 429,
            customResponseBodyKey: 'RateLimitExceeded',
          },
        },
      },
      statement: {
        rateBasedStatement: {
          limit: 500, // 500 per 5-minute window = ~100/min
          aggregateKeyType: 'IP',
          scopeDownStatement: {
            orStatement: {
              statements: [
                {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'EXACTLY',
                    searchString: '/events',
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
                {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'STARTS_WITH',
                    searchString: '/events/',
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
              ],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'RateLimitPublicEndpoints',
        sampledRequestsEnabled: true,
      },
    };
  }

  /**
   * Lenient global rate limit applied to all requests regardless of auth.
   *
   * Issue #97: this used to scope-down to "has Authorization: Bearer",
   * which made it trivially abusable (attackers add a fake header). With
   * no scope-down, the limit is a true global cap. Authenticated routes
   * are 401'd by Cognito for fake tokens before Lambda runs, so attackers
   * can spam toward this cap but cannot actually consume backend cycles.
   *
   * 500 requests per minute = 2500 per 5-minute WAF evaluation window.
   */
  _createAuthenticatedRateLimitRule() {
    return {
      name: 'RateLimitGlobal',
      priority: 2,
      action: {
        block: {
          customResponse: {
            responseCode: 429,
            customResponseBodyKey: 'RateLimitExceeded',
          },
        },
      },
      statement: {
        rateBasedStatement: {
          limit: 2500, // 2500 per 5-minute window = ~500/min
          aggregateKeyType: 'IP',
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'RateLimitGlobal',
        sampledRequestsEnabled: true,
      },
    };
  }

  /**
   * Creates an AWS Managed Rule Group reference.
   */
  _createManagedRuleGroup(name, vendorName, priority) {
    return {
      name: name,
      priority: priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          name: name,
          vendorName: vendorName,
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
    };
  }

  /**
   * Size restriction rule: blocks requests with body > 4KB (4096 bytes).
   * Protects WebSocket/Chat endpoints from oversized payloads.
   */
  _createSizeRestrictionRule() {
    return {
      name: 'SizeRestriction4KB',
      priority: 40,
      action: { block: {} },
      statement: {
        sizeConstraintStatement: {
          fieldToMatch: { body: {} },
          comparisonOperator: 'GT',
          size: 4096, // 4KB max
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'SizeRestriction4KB',
        sampledRequestsEnabled: true,
      },
    };
  }
}

module.exports = { WafConstruct };

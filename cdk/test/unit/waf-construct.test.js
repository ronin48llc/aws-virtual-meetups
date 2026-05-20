const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { WafConstruct } = require('../../lib/waf-construct');

describe('WafConstruct', () => {
  let app;
  let stack;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
  });

  describe('REGIONAL scope', () => {
    let template;

    beforeEach(() => {
      new WafConstruct(stack, 'TestWaf', {
        scope: 'REGIONAL',
        resourceArns: ['arn:aws:apigateway:us-east-1::/restapis/abc123/stages/prod'],
      });
      template = Template.fromStack(stack);
    });

    test('creates a WebACL with REGIONAL scope', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
        DefaultAction: { Allow: {} },
      });
    });

    test('creates WebACL association for provided resource ARN', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
        ResourceArn: 'arn:aws:apigateway:us-east-1::/restapis/abc123/stages/prod',
      });
    });

    test('includes strict rate limit for public endpoints (500 per 5-min window)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitPublicEndpoints',
            Priority: 1,
            Action: {
              Block: {
                CustomResponse: {
                  ResponseCode: 429,
                  CustomResponseBodyKey: 'RateLimitExceeded',
                },
              },
            },
            Statement: {
              RateBasedStatement: {
                Limit: 500,
                AggregateKeyType: 'IP',
              },
            },
          }),
        ]),
      });
    });

    test('includes lenient global rate limit (2500 per 5-min window)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitGlobal',
            Priority: 2,
            Action: {
              Block: {
                CustomResponse: {
                  ResponseCode: 429,
                  CustomResponseBodyKey: 'RateLimitExceeded',
                },
              },
            },
            Statement: {
              RateBasedStatement: {
                Limit: 2500,
                AggregateKeyType: 'IP',
              },
            },
          }),
        ]),
      });
    });

    // Issue #97 regression — the strict tier must filter by URI path, not
    // by Authorization header. Header-based filtering was trivially bypassed
    // by sending `Authorization: Bearer x`, which WAF can't validate.
    test('strict rate-limit scope-down is path-based, not header-based (#97)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitPublicEndpoints',
            Statement: {
              RateBasedStatement: {
                ScopeDownStatement: {
                  OrStatement: {
                    Statements: Match.arrayWith([
                      Match.objectLike({
                        ByteMatchStatement: {
                          FieldToMatch: { UriPath: {} },
                          PositionalConstraint: 'EXACTLY',
                          SearchString: '/events',
                        },
                      }),
                      Match.objectLike({
                        ByteMatchStatement: {
                          FieldToMatch: { UriPath: {} },
                          PositionalConstraint: 'STARTS_WITH',
                          SearchString: '/events/',
                        },
                      }),
                    ]),
                  },
                },
              },
            },
          }),
        ]),
      });
    });

    test('global rate-limit has no scope-down — applies to all paths (#97)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitGlobal',
            Statement: {
              RateBasedStatement: Match.objectLike({
                Limit: 2500,
                AggregateKeyType: 'IP',
                ScopeDownStatement: Match.absent(),
              }),
            },
          }),
        ]),
      });
    });

    test('no rule references the Authorization header anymore (#97)', () => {
      // Header-based scope-down was the original bypass vector. Make sure
      // it has been removed from BOTH rate-limit rules — a future regression
      // that re-adds it would surface here.
      const stringified = JSON.stringify(template.toJSON());
      expect(stringified).not.toMatch(/singleHeader.*authorization/i);
      expect(stringified).not.toMatch(/SingleHeader.*[Aa]uthorization/);
    });

    test('includes AWS Managed Rules Common Rule Set', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'AWSManagedRulesCommonRuleSet',
            Priority: 10,
            OverrideAction: { None: {} },
            Statement: {
              ManagedRuleGroupStatement: {
                Name: 'AWSManagedRulesCommonRuleSet',
                VendorName: 'AWS',
              },
            },
          }),
        ]),
      });
    });

    test('includes AWS Managed Rules SQLi Rule Set', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'AWSManagedRulesSQLiRuleSet',
            Priority: 20,
            Statement: {
              ManagedRuleGroupStatement: {
                Name: 'AWSManagedRulesSQLiRuleSet',
                VendorName: 'AWS',
              },
            },
          }),
        ]),
      });
    });

    test('includes AWS Managed Rules Known Bad Inputs Rule Set', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            Priority: 30,
            Statement: {
              ManagedRuleGroupStatement: {
                Name: 'AWSManagedRulesKnownBadInputsRuleSet',
                VendorName: 'AWS',
              },
            },
          }),
        ]),
      });
    });

    test('includes AWS Managed Rules Amazon IP Reputation List (issue #40)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'AWSManagedRulesAmazonIpReputationList',
            Priority: 35,
            Statement: {
              ManagedRuleGroupStatement: {
                Name: 'AWSManagedRulesAmazonIpReputationList',
                VendorName: 'AWS',
              },
            },
          }),
        ]),
      });
    });

    test('includes size restriction rule (4KB max body)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'SizeRestriction4KB',
            Priority: 40,
            Action: { Block: {} },
            Statement: {
              SizeConstraintStatement: {
                FieldToMatch: { Body: {} },
                ComparisonOperator: 'GT',
                Size: 4096,
              },
            },
          }),
        ]),
      });
    });

    test('includes custom response body for rate limit (429)', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        CustomResponseBodies: {
          RateLimitExceeded: {
            ContentType: 'APPLICATION_JSON',
            Content: Match.stringLikeRegexp('Too Many Requests'),
          },
        },
      });
    });

    test('enables CloudWatch metrics on all rules', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          SampledRequestsEnabled: true,
        },
      });
    });

    test('has exactly 7 rules', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({ Name: 'RateLimitPublicEndpoints' }),
          Match.objectLike({ Name: 'RateLimitGlobal' }),
          Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
          Match.objectLike({ Name: 'AWSManagedRulesSQLiRuleSet' }),
          Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
          Match.objectLike({ Name: 'AWSManagedRulesAmazonIpReputationList' }),
          Match.objectLike({ Name: 'SizeRestriction4KB' }),
        ]),
      });
    });
  });

  describe('CLOUDFRONT scope', () => {
    let template;

    beforeEach(() => {
      new WafConstruct(stack, 'TestCfWaf', {
        scope: 'CLOUDFRONT',
      });
      template = Template.fromStack(stack);
    });

    test('creates a WebACL with CLOUDFRONT scope', () => {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'CLOUDFRONT',
        DefaultAction: { Allow: {} },
      });
    });

    test('does not create WebACL associations for CLOUDFRONT scope', () => {
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    });
  });

  describe('default scope', () => {
    test('defaults to REGIONAL scope when no scope provided', () => {
      new WafConstruct(stack, 'DefaultWaf', {});
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
      });
    });
  });

  describe('multiple resource associations', () => {
    test('creates association for each resource ARN', () => {
      new WafConstruct(stack, 'MultiWaf', {
        scope: 'REGIONAL',
        resourceArns: [
          'arn:aws:apigateway:us-east-1::/restapis/api1/stages/prod',
          'arn:aws:apigateway:us-east-1::/restapis/api2/stages/prod',
        ],
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2);
    });
  });
});

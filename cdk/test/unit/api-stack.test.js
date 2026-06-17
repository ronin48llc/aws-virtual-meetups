'use strict';

const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { AuthStack } = require('../../lib/auth-stack');
const { DataStack } = require('../../lib/data-stack');
const { EmailStack } = require('../../lib/email-stack');
const { ApiStack } = require('../../lib/api-stack');

describe('ApiStack — WAF association (#103)', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-east-1' };
    const dataStack = new DataStack(app, 'TestData', { env });
    const authStack = new AuthStack(app, 'TestAuth', { env });
    const emailStack = new EmailStack(app, 'TestEmail', {
      env,
      tableName: dataStack.mainTable.tableName,
      tableArn: dataStack.mainTable.tableArn,
      frontendUrl: 'https://example.invalid',
    });
    const apiStack = new ApiStack(app, 'TestApi', {
      env,
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
      mainTable: dataStack.mainTable,
      connectionsTable: dataStack.connectionsTable,
      emailSenderFunction: emailStack.emailSenderFunction,
      schedulerRole: emailStack.schedulerRole,
      domainName: 'example.invalid',
    });
    template = Template.fromStack(apiStack);
  });

  // Issue #103: previously, ApiStack passed resourceArns:[] to the WafConstruct
  // and the WebACL was attached to nothing. Every WAF rule was dead weight.
  test('synthesizes exactly two WebACLAssociations — one per API stage', () => {
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2);
  });

  test('one WebACLAssociation targets the HTTP API stage ARN shape', () => {
    // The ARN is built from the apiId at synth time as a CFN intrinsic, so
    // we can't match a literal string. Instead, walk the associations and
    // assert one of them references the HTTP API resource via Fn::Sub or
    // Fn::Join including the /apis/ path.
    const associations = template.findResources('AWS::WAFv2::WebACLAssociation');
    const arns = Object.values(associations).map((res) => JSON.stringify(res.Properties.ResourceArn));

    // Each stage ARN string contains `/apis/` and `/stages/` literals from
    // the template we synthesized.
    const httpStageMatches = arns.filter((s) => s.includes('/apis/') && s.includes('/stages/'));
    expect(httpStageMatches.length).toBeGreaterThanOrEqual(1);
  });

  test('both WebACLAssociations reference the same WebACL', () => {
    const associations = template.findResources('AWS::WAFv2::WebACLAssociation');
    const aclRefs = Object.values(associations).map((res) => JSON.stringify(res.Properties.WebACLArn));
    expect(aclRefs[0]).toBe(aclRefs[1]);
  });

  test('WebACL is REGIONAL scope (matches API Gateway v2 stages)', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
    });
  });
});

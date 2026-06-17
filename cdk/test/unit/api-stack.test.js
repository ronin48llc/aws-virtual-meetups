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

  // Issue #103 / fix 8c5fe3d: WAFv2 REGIONAL cannot be associated with API
  // Gateway *v2* (HTTP / WebSocket) stages — the `/apis/.../stages/...` ARN is
  // rejected ("The ARN isn't valid"); only REST API (`/restapis/`) ARNs are
  // supported. So ApiStack intentionally passes resourceArns:[] and creates no
  // WebACLAssociations. The WebACL itself is still defined (see the REGIONAL
  // scope test below) so associations can be added if/when v2 support lands.
  test('creates no WebACLAssociations (WAFv2 cannot attach to API GW v2 stages)', () => {
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
  });

  test('WebACL is REGIONAL scope (matches API Gateway v2 stages)', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
    });
  });
});

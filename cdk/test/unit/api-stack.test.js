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

  // WAFv2 REGIONAL cannot be associated with API Gateway *v2* (HTTP /
  // WebSocket) stages — only REST API (`/restapis/`) ARNs are supported.
  // The stack therefore creates NO WebACL at all: a previous revision kept
  // an unattached REGIONAL WebACL "for future use", which inspected nothing
  // and billed for the privilege. API protection comes from stage
  // throttling + authorizers; the frontend keeps its CLOUDFRONT WebACL.
  test('creates no WAF resources (WAFv2 cannot attach to API GW v2 stages)', () => {
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });
});

describe('ApiStack — Admin API routes', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-east-1' };
    const dataStack = new DataStack(app, 'AdminTestData', { env });
    const authStack = new AuthStack(app, 'AdminTestAuth', { env });
    const emailStack = new EmailStack(app, 'AdminTestEmail', {
      env,
      tableName: dataStack.mainTable.tableName,
      tableArn: dataStack.mainTable.tableArn,
      frontendUrl: 'https://example.invalid',
    });
    const apiStack = new ApiStack(app, 'AdminTestApi', {
      env,
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
      adminApiFunction: authStack.adminApiFunction,
      mainTable: dataStack.mainTable,
      connectionsTable: dataStack.connectionsTable,
      emailSenderFunction: emailStack.emailSenderFunction,
      schedulerRole: emailStack.schedulerRole,
      domainName: 'example.invalid',
    });
    template = Template.fromStack(apiStack);
  });

  test.each([
    'POST /admin/users/disable',
    'POST /admin/users/enable',
    'GET /admin/users/{username}/status',
  ])('%s exists and requires the Cognito authorizer (issue #93)', (routeKey) => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route', {
      Properties: { RouteKey: routeKey },
    });
    const entries = Object.values(routes);
    expect(entries).toHaveLength(1);
    expect(entries[0].Properties.AuthorizationType).toBe('JWT');
  });

  test('admin routes are omitted when no adminApiFunction is passed', () => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-east-1' };
    const dataStack = new DataStack(app, 'NoAdminData', { env });
    const authStack = new AuthStack(app, 'NoAdminAuth', { env });
    const emailStack = new EmailStack(app, 'NoAdminEmail', {
      env,
      tableName: dataStack.mainTable.tableName,
      tableArn: dataStack.mainTable.tableArn,
      frontendUrl: 'https://example.invalid',
    });
    const apiStack = new ApiStack(app, 'NoAdminApi', {
      env,
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
      mainTable: dataStack.mainTable,
      connectionsTable: dataStack.connectionsTable,
      emailSenderFunction: emailStack.emailSenderFunction,
      schedulerRole: emailStack.schedulerRole,
      domainName: 'example.invalid',
    });
    const noAdminTemplate = Template.fromStack(apiStack);
    const routes = noAdminTemplate.findResources('AWS::ApiGatewayV2::Route', {
      Properties: { RouteKey: 'POST /admin/users/disable' },
    });
    expect(Object.keys(routes)).toHaveLength(0);
  });
});

describe('ApiStack — signaling Lambda IVS token permission', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-east-1' };
    const dataStack = new DataStack(app, 'IvsTokenData', { env });
    const authStack = new AuthStack(app, 'IvsTokenAuth', { env });
    const emailStack = new EmailStack(app, 'IvsTokenEmail', {
      env,
      tableName: dataStack.mainTable.tableName,
      tableArn: dataStack.mainTable.tableArn,
      frontendUrl: 'https://example.invalid',
    });
    const apiStack = new ApiStack(app, 'IvsTokenApi', {
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

  // Promoting a co-presenter (or granting speak permission) mints a
  // PUBLISH-capable IVS stage token inside the signaling Lambda. Without this
  // grant the mint fails and the promoted user can never publish.
  test('the WsSignaling role can call ivs:CreateParticipantToken', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Handler: 'websocket/signaling.handler' },
    });
    const fnKeys = Object.keys(fns);
    expect(fnKeys).toHaveLength(1);
    const roleRef = fns[fnKeys[0]].Properties.Role['Fn::GetAtt'][0];

    const policies = template.findResources('AWS::IAM::Policy');
    const granted = Object.values(policies).some((p) => {
      const roles = (p.Properties.Roles || []).map((r) => r.Ref);
      if (!roles.includes(roleRef)) return false;
      const statements = p.Properties.PolicyDocument.Statement;
      return statements.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('ivs:CreateParticipantToken');
      });
    });
    expect(granted).toBe(true);
  });
});

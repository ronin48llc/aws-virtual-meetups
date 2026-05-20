'use strict';

// Issue #119: the EventBridge Scheduler role (from email-stack) was only
// granted lambda:InvokeFunction on the email Lambda. Auto-stop and
// time-warning schedules that session-manager creates pointing at
// itself failed silently because the role couldn't invoke
// session-manager. api-stack now grants invoke on session-manager too.
//
// Kept in its own file to avoid a merge conflict with the parallel
// api-stack.test.js introduced by #103.

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { AuthStack } = require('../../lib/auth-stack');
const { DataStack } = require('../../lib/data-stack');
const { EmailStack } = require('../../lib/email-stack');
const { ApiStack } = require('../../lib/api-stack');

describe('ApiStack — scheduler role invoke grant (#119)', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-east-1' };
    const dataStack = new DataStack(app, 'TestDataSchedGrant', { env });
    const authStack = new AuthStack(app, 'TestAuthSchedGrant', { env });
    const emailStack = new EmailStack(app, 'TestEmailSchedGrant', {
      env,
      tableName: dataStack.mainTable.tableName,
      tableArn: dataStack.mainTable.tableArn,
      frontendUrl: 'https://example.invalid',
    });
    const apiStack = new ApiStack(app, 'TestApiSchedGrant', {
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

  test('synthesizes an IAM policy attached to the scheduler role granting invoke on session-manager', () => {
    // grantInvoke produces a policy with Action: lambda:InvokeFunction.
    // It's added to the role that's passed in (scheduler role, defined in
    // EmailStack but referenced from ApiStack via props).
    //
    // The exact resource ARN is a CloudFormation intrinsic that
    // dereferences the SessionManager function ARN, so we match by shape:
    // any policy statement with lambda:InvokeFunction that lives in
    // ApiStack must reference the session-manager function.
    const policies = template.findResources('AWS::IAM::Policy');
    const invokePolicies = Object.values(policies).filter((p) =>
      p.Properties.PolicyDocument.Statement.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('lambda:InvokeFunction');
      })
    );

    // Stringify so we can scan for the SessionManager function reference.
    const refsSessionManager = invokePolicies.some((p) => {
      const json = JSON.stringify(p.Properties.PolicyDocument);
      return json.includes('SessionManagerFunction');
    });

    expect(refsSessionManager).toBe(true);
  });
});

'use strict';

/**
 * Verifies the EventBridge Scheduler IAM scoping introduced for issue #1 —
 * that the EventCrud and SessionManager Lambdas have scheduler:CreateSchedule
 * and scheduler:DeleteSchedule scoped to the dedicated schedule group's ARN
 * pattern, not the previous `Resource: "*"`.
 */

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const cognito = require('aws-cdk-lib/aws-cognito');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const lambda = require('aws-cdk-lib/aws-lambda');
const iam = require('aws-cdk-lib/aws-iam');
const route53 = require('aws-cdk-lib/aws-route53');
const acm = require('aws-cdk-lib/aws-certificatemanager');
const path = require('path');
const { ApiStack } = require('../../lib/api-stack');

/**
 * Build a minimal scaffolding stack carrying the constructs ApiStack
 * requires (userPool, tables, scheduler role, etc.). Returns the synthesized
 * Template of the ApiStack itself.
 */
function synthApiStackTemplate() {
  const app = new App();
  const scaffold = new Stack(app, 'TestScaffoldStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const userPool = new cognito.UserPool(scaffold, 'TestUserPool');
  const userPoolClient = userPool.addClient('TestClient');
  const mainTable = new dynamodb.Table(scaffold, 'TestMainTable', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });
  const connectionsTable = new dynamodb.Table(scaffold, 'TestConnectionsTable', {
    partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
  });
  const emailSenderFunction = new lambda.Function(scaffold, 'TestEmailFn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({});'),
  });
  const schedulerRole = new iam.Role(scaffold, 'TestSchedulerRole', {
    assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
  });
  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(scaffold, 'TestZone', {
    hostedZoneId: 'Z1234567890ABC',
    zoneName: 'example.com',
  });
  const certificate = acm.Certificate.fromCertificateArn(
    scaffold,
    'TestCert',
    'arn:aws:acm:us-east-1:123456789012:certificate/abcd-efgh',
  );

  const apiStack = new ApiStack(app, 'TestApiStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    userPool,
    userPoolClient,
    mainTable,
    connectionsTable,
    emailSenderFunction,
    schedulerRole,
    hostedZone,
    certificate,
    domainName: 'example.com',
    recordingBucketName: 'test-recordings-bucket',
  });

  return Template.fromStack(apiStack);
}

describe('ApiStack — scheduler IAM scoping (issue #1)', () => {
  let template;

  beforeAll(() => {
    template = synthApiStackTemplate();
  });

  test('does not create its own ScheduleGroup (EmailStack owns it)', () => {
    // EmailStack already creates the VirtualMeetup-Reminders group; this
    // stack must not create a duplicate, which would fail at deploy time
    // with ScheduleGroupAlreadyExists.
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 0);
  });

  test('no IAM policy statement uses scheduler:CreateSchedule with Resource "*"', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement || [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (!actions.includes('scheduler:CreateSchedule')) continue;
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const r of resources) {
          // After the fix, no resource should be a bare "*"
          expect(r).not.toBe('*');
        }
      }
    }
  });

  test('no IAM policy statement uses scheduler:DeleteSchedule with Resource "*"', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [, policy] of Object.entries(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement || [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (!actions.includes('scheduler:DeleteSchedule')) continue;
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const r of resources) {
          expect(r).not.toBe('*');
        }
      }
    }
  });

  test('scheduler:Create/DeleteSchedule resources reference the VirtualMeetup-Reminders schedule path', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    let foundScopedStatement = false;
    for (const [, policy] of Object.entries(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement || [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (!actions.some((a) => a === 'scheduler:CreateSchedule' || a === 'scheduler:DeleteSchedule')) {
          continue;
        }
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const r of resources) {
          // Resource string contains the schedule-group path component.
          // CDK serializes ARNs that reference Stack.region/account as
          // Fn::Sub strings — match on the literal group segment.
          const asJson = JSON.stringify(r);
          if (asJson.includes('schedule/VirtualMeetup-Reminders/')) {
            foundScopedStatement = true;
          }
        }
      }
    }
    expect(foundScopedStatement).toBe(true);
  });
});

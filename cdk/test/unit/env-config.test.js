'use strict';

const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { DataStack } = require('../../lib/data-stack');
const { AuthStack } = require('../../lib/auth-stack');
const { StreamingStack } = require('../../lib/streaming-stack');

// Production-readiness invariants: stateful resources must survive stack
// deletion in prod (RETAIN), and every physical name must carry the env
// suffix so dev + prod can coexist in one account without collisions.

const ENV = { account: '123456789012', region: 'us-east-1' };

function synthDataStack(envName) {
  const app = new App({ context: envName ? { env: envName } : {} });
  return Template.fromStack(new DataStack(app, 'TestData', { env: ENV }));
}

describe('environment-gated removal policies', () => {
  test('prod DynamoDB tables are RETAINed', () => {
    const template = synthDataStack('prod');
    const tables = template.findResources('AWS::DynamoDB::Table');
    const policies = Object.values(tables).map((t) => t.DeletionPolicy);
    expect(policies).toEqual(['Retain', 'Retain']);
  });

  test('dev DynamoDB tables keep DESTROY for clean teardown', () => {
    const template = synthDataStack('dev');
    const tables = template.findResources('AWS::DynamoDB::Table');
    const policies = Object.values(tables).map((t) => t.DeletionPolicy);
    expect(policies).toEqual(['Delete', 'Delete']);
  });

  test('prod user pool is RETAINed', () => {
    const app = new App({ context: { env: 'prod' } });
    const template = Template.fromStack(new AuthStack(app, 'TestAuth', { env: ENV }));
    const pools = template.findResources('AWS::Cognito::UserPool');
    expect(Object.values(pools)[0].DeletionPolicy).toBe('Retain');
  });

  test('prod recording bucket is RETAINed with no auto-delete', () => {
    const app = new App({ context: { env: 'prod' } });
    const template = Template.fromStack(new StreamingStack(app, 'TestStreaming', { env: ENV }));
    const buckets = template.findResources('AWS::S3::Bucket');
    const recording = Object.entries(buckets).find(
      ([id]) => id.startsWith('RecordingBucket') && !id.includes('Logs')
    );
    expect(recording[1].DeletionPolicy).toBe('Retain');
    // autoDeleteObjects wires a custom resource; prod must not create one
    // for the recording bucket.
    const autoDelete = template.findResources('Custom::S3AutoDeleteObjects');
    const targets = Object.values(autoDelete).map((r) => r.Properties.BucketName.Ref);
    expect(targets).not.toContain(recording[0]);
  });
});

describe('env-suffixed physical names', () => {
  test('prod tables carry the -prod suffix', () => {
    const template = synthDataStack('prod');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'VirtualMeetupTable-prod',
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'WebSocketConnections-prod',
    });
  });

  test('default (no context) resolves to -dev suffix', () => {
    const template = synthDataStack(null);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'VirtualMeetupTable-dev',
    });
  });
});

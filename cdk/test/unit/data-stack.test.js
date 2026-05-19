const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { DataStack } = require('../../lib/data-stack');

describe('DataStack', () => {
  let template;
  let stack;

  beforeAll(() => {
    const app = new App();
    stack = new DataStack(app, 'TestDataStack');
    template = Template.fromStack(stack);
  });

  describe('VirtualMeetupTable', () => {
    test('creates table with PK (string) partition key and SK (string) sort key', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'VirtualMeetupTable',
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ]),
      });
    });

    test('uses on-demand billing mode', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'VirtualMeetupTable',
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    test('has GSI1 with GSI1PK/GSI1SK for upcoming events by start time', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'VirtualMeetupTable',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });

    test('has GSI2 with GSI2PK/GSI2SK for events by owner', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'VirtualMeetupTable',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'GSI2PK', KeyType: 'HASH' },
              { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });
  });

  describe('WebSocketConnections table', () => {
    test('creates table with connectionId as partition key', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'WebSocketConnections',
        KeySchema: [
          { AttributeName: 'connectionId', KeyType: 'HASH' },
        ],
      });
    });

    test('uses on-demand billing mode', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'WebSocketConnections',
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    test('has TTL enabled on ttl attribute', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'WebSocketConnections',
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      });
    });

    test('has EventConnections GSI with eventId PK and connectionId SK', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'WebSocketConnections',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'EventConnections',
            KeySchema: [
              { AttributeName: 'eventId', KeyType: 'HASH' },
              { AttributeName: 'connectionId', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });
  });

  describe('CloudFormation outputs', () => {
    test('exports main table name', () => {
      template.hasOutput('MainTableName', {
        Export: { Name: 'VirtualMeetupTableName' },
      });
    });

    test('exports main table ARN', () => {
      template.hasOutput('MainTableArn', {
        Export: { Name: 'VirtualMeetupTableArn' },
      });
    });

    test('exports connections table name', () => {
      template.hasOutput('ConnectionsTableName', {
        Export: { Name: 'WebSocketConnectionsTableName' },
      });
    });

    test('exports connections table ARN', () => {
      template.hasOutput('ConnectionsTableArn', {
        Export: { Name: 'WebSocketConnectionsTableArn' },
      });
    });
  });

  describe('Cross-stack references', () => {
    test('exposes mainTable reference', () => {
      expect(stack.mainTable).toBeDefined();
    });

    test('exposes connectionsTable reference', () => {
      expect(stack.connectionsTable).toBeDefined();
    });
  });
});

const { Stack, CfnOutput } = require('aws-cdk-lib');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const { withEnv, isProd, dataRemovalPolicy } = require('./env-config');

class DataStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Tables are RETAIN'd in protected envs (see isProd in env-config.js) —
    // a stack delete or a CloudFormation replacement must never destroy
    // event/user data. DynamoDB deletion protection additionally blocks
    // DeleteTable at the API level, catching console/CLI mistakes that
    // RemovalPolicy (a CloudFormation-only guard) cannot.
    const removalPolicy = dataRemovalPolicy(this);
    const deletionProtection = isProd(this);

    // Main single-table: VirtualMeetupTable
    const mainTable = new dynamodb.Table(this, 'VirtualMeetupTable', {
      tableName: withEnv(this, 'VirtualMeetupTable'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy,
      deletionProtection,
    });

    // GSI1: List upcoming events sorted by start time
    // GSI1PK = "EVENTS#UPCOMING", GSI1SK = "{scheduledStart}#{eventId}"
    mainTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: List events by owner
    // GSI2PK = "USER#{userId}#EVENTS", GSI2SK = "{scheduledStart}#{eventId}"
    mainTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // WebSocket Connections table (separate for high write throughput + TTL cleanup)
    const connectionsTable = new dynamodb.Table(this, 'WebSocketConnections', {
      tableName: withEnv(this, 'WebSocketConnections'),
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy,
      deletionProtection,
      timeToLiveAttribute: 'ttl',
    });

    // GSI EventConnections: PK=eventId, SK=connectionId for broadcasting to all connections in an event
    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'EventConnections',
      partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // CloudFormation outputs
    new CfnOutput(this, 'MainTableName', {
      value: mainTable.tableName,
      description: 'VirtualMeetupTable name',
      exportName: withEnv(this, 'VirtualMeetupTableName'),
    });

    new CfnOutput(this, 'MainTableArn', {
      value: mainTable.tableArn,
      description: 'VirtualMeetupTable ARN',
      exportName: withEnv(this, 'VirtualMeetupTableArn'),
    });

    new CfnOutput(this, 'ConnectionsTableName', {
      value: connectionsTable.tableName,
      description: 'WebSocketConnections table name',
      exportName: withEnv(this, 'WebSocketConnectionsTableName'),
    });

    new CfnOutput(this, 'ConnectionsTableArn', {
      value: connectionsTable.tableArn,
      description: 'WebSocketConnections table ARN',
      exportName: withEnv(this, 'WebSocketConnectionsTableArn'),
    });

    // Expose table references for cross-stack use
    this.mainTable = mainTable;
    this.connectionsTable = connectionsTable;
  }
}

module.exports = { DataStack };

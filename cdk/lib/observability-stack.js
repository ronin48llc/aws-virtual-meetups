'use strict';

const path = require('path');
const { Stack, Duration, CfnOutput, RemovalPolicy } = require('aws-cdk-lib');
const cloudwatch = require('aws-cdk-lib/aws-cloudwatch');
const cloudwatchActions = require('aws-cdk-lib/aws-cloudwatch-actions');
const sns = require('aws-cdk-lib/aws-sns');
const snsSubscriptions = require('aws-cdk-lib/aws-sns-subscriptions');
const logs = require('aws-cdk-lib/aws-logs');
const lambda = require('aws-cdk-lib/aws-lambda');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const { CfnQueryDefinition } = require('aws-cdk-lib/aws-logs');

/**
 * Observability Stack for the Virtual Meetup Platform.
 * Provides CloudWatch dashboard, alarms, SNS notifications, log retention,
 * saved queries, and IVS metrics collection.
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 30.1, 30.2, 30.3, 30.4, 32.1, 32.2, 32.4
 */
class ObservabilityStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { httpApi, webSocketApi, mainTable, connectionsTable } = props;
    const envName = this.node.tryGetContext('env') || 'dev';
    const alarmEmails = this.node.tryGetContext('alarmEmails') || [];

    // -------------------------------------------------------
    // Lambda function names (must match api-stack.js)
    // -------------------------------------------------------
    const lambdaFunctionNames = [
      'VirtualMeetup-EventCrud',
      'VirtualMeetup-SessionManager',
      'VirtualMeetup-TokenGenerator',
      'VirtualMeetup-Signup',
      'VirtualMeetup-WsConnect',
      'VirtualMeetup-WsDisconnect',
      'VirtualMeetup-WsSignaling',
    ];

    // -------------------------------------------------------
    // Log Retention — 30 days for all Lambda Log Groups
    // -------------------------------------------------------
    const logGroups = lambdaFunctionNames.map((fnName) => {
      return new logs.LogGroup(this, `LogGroup-${fnName}`, {
        logGroupName: `/aws/lambda/${fnName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    });

    // -------------------------------------------------------
    // SNS Topic for Alarms
    // -------------------------------------------------------
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `VirtualMeetupAlarms-${envName}`,
      displayName: `Virtual Meetup Platform Alarms (${envName})`,
    });

    // Add email subscribers from CDK context
    if (Array.isArray(alarmEmails)) {
      alarmEmails.forEach((email) => {
        alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(email));
      });
    }

    // -------------------------------------------------------
    // CloudWatch Alarms
    // -------------------------------------------------------

    // Alarm: API Error Rate > 5%
    const apiErrorAlarm = new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: `VirtualMeetup-${envName}-ApiErrorRate`,
      alarmDescription: 'API 5xx error rate exceeds 5%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: {
          ApiId: httpApi ? httpApi.apiId : 'placeholder',
        },
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: Lambda Error Rate > 1%
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorRateAlarm', {
      alarmName: `VirtualMeetup-${envName}-LambdaErrorRate`,
      alarmDescription: 'Lambda error rate exceeds 1%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: DynamoDB Throttling
    const dynamoThrottleAlarm = new cloudwatch.Alarm(this, 'DynamoThrottleAlarm', {
      alarmName: `VirtualMeetup-${envName}-DynamoThrottling`,
      alarmDescription: 'DynamoDB throttled requests detected',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dynamoThrottleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: WebSocket Failures > 10/min
    const wsFailureAlarm = new cloudwatch.Alarm(this, 'WebSocketFailureAlarm', {
      alarmName: `VirtualMeetup-${envName}-WebSocketFailures`,
      alarmDescription: 'WebSocket connection errors exceed 10 per minute',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'ConnectError',
        dimensionsMap: {
          ApiId: webSocketApi ? webSocketApi.apiId : 'placeholder',
        },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    wsFailureAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: High Lambda Duration (p99 > 5s)
    const lambdaDurationAlarm = new cloudwatch.Alarm(this, 'LambdaDurationAlarm', {
      alarmName: `VirtualMeetup-${envName}-LambdaHighDuration`,
      alarmDescription: 'Lambda p99 duration exceeds 5 seconds',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        statistic: 'p99',
        period: Duration.minutes(5),
      }),
      threshold: 5000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaDurationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // -------------------------------------------------------
    // CloudWatch Dashboard
    // -------------------------------------------------------
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `VirtualMeetupPlatform-${envName}`,
    });

    // API Latency widget
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Latency (p50/p95/p99)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiId: httpApi ? httpApi.apiId : 'placeholder' },
            statistic: 'p50',
            period: Duration.minutes(1),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiId: httpApi ? httpApi.apiId : 'placeholder' },
            statistic: 'p95',
            period: Duration.minutes(1),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiId: httpApi ? httpApi.apiId : 'placeholder' },
            statistic: 'p99',
            period: Duration.minutes(1),
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Error Rates (4xx/5xx)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4xx',
            dimensionsMap: { ApiId: httpApi ? httpApi.apiId : 'placeholder' },
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5xx',
            dimensionsMap: { ApiId: httpApi ? httpApi.apiId : 'placeholder' },
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
        width: 12,
      })
    );

    // Lambda Duration and Errors widgets
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration by Function',
        left: lambdaFunctionNames.map((fnName) =>
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: { FunctionName: fnName },
            statistic: 'Average',
            period: Duration.minutes(1),
          })
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors & Throttles',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Throttles',
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
        width: 12,
      })
    );

    // DynamoDB and WebSocket widgets
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Consumed Capacity (RCU/WCU)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'WebSocket Active Connections',
        metrics: [
          new cloudwatch.Metric({
            namespace: `VirtualMeetup/${envName}`,
            metricName: 'AttendeeCount',
            statistic: 'Maximum',
            period: Duration.minutes(1),
          }),
        ],
        width: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Live Events Count',
        metrics: [
          new cloudwatch.Metric({
            namespace: `VirtualMeetup/${envName}`,
            metricName: 'AttendeeCount',
            statistic: 'SampleCount',
            period: Duration.minutes(5),
          }),
        ],
        width: 6,
      })
    );

    // Engagement metrics widgets
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Chat Messages/min',
        left: [
          new cloudwatch.Metric({
            namespace: `VirtualMeetup/${envName}`,
            metricName: 'ChatMessagesSent',
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Questions Submitted/min',
        left: [
          new cloudwatch.Metric({
            namespace: `VirtualMeetup/${envName}`,
            metricName: 'QuestionsSubmitted',
            statistic: 'Sum',
            period: Duration.minutes(1),
          }),
        ],
        width: 12,
      })
    );

    // -------------------------------------------------------
    // CloudWatch Logs Insights Saved Queries
    // -------------------------------------------------------
    const logGroupNames = lambdaFunctionNames.map((fn) => `/aws/lambda/${fn}`);

    new CfnQueryDefinition(this, 'ErrorSearchQuery', {
      name: `VirtualMeetup-${envName}/ErrorSearch`,
      queryString: [
        'fields @timestamp, @message',
        '| filter level = "ERROR"',
        '| sort @timestamp desc',
        '| limit 100',
      ].join('\n'),
      logGroupNames,
    });

    new CfnQueryDefinition(this, 'SlowLambdaQuery', {
      name: `VirtualMeetup-${envName}/SlowLambdaInvocations`,
      queryString: [
        'fields @timestamp, @duration, @requestId, action',
        '| filter @duration > 3000',
        '| sort @duration desc',
        '| limit 50',
      ].join('\n'),
      logGroupNames,
    });

    new CfnQueryDefinition(this, 'WebSocketDisconnectQuery', {
      name: `VirtualMeetup-${envName}/WebSocketDisconnections`,
      queryString: [
        'fields @timestamp, userId, eventId, action',
        '| filter action = "disconnect"',
        '| stats count() by bin(5m)',
      ].join('\n'),
      logGroupNames,
    });

    new CfnQueryDefinition(this, 'FailedAuthQuery', {
      name: `VirtualMeetup-${envName}/FailedAuthAttempts`,
      queryString: [
        'fields @timestamp, userId, action, error',
        '| filter action = "authenticate" and level = "ERROR"',
        '| sort @timestamp desc',
        '| limit 100',
      ].join('\n'),
      logGroupNames,
    });

    // -------------------------------------------------------
    // IVS Metrics Collection Lambda (Task 16.6)
    // -------------------------------------------------------
    const ivsMetricsFn = new lambda.Function(this, 'IvsMetricsFunction', {
      functionName: `VirtualMeetup-IvsMetrics-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/ivs-metrics/')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        ENVIRONMENT: envName,
      },
    });

    // Log group for IVS metrics Lambda
    new logs.LogGroup(this, 'IvsMetricsLogGroup', {
      logGroupName: `/aws/lambda/VirtualMeetup-IvsMetrics-${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // EventBridge rule to capture IVS stage participant events
    const ivsEventRule = new events.Rule(this, 'IvsStageEventRule', {
      ruleName: `VirtualMeetup-${envName}-IvsStageEvents`,
      description: 'Captures IVS Real-Time stage participant events for metrics collection',
      eventPattern: {
        source: ['aws.ivs'],
        detailType: [
          'IVS Stage Update',
          'IVS Participant State Change',
        ],
      },
    });

    ivsEventRule.addTarget(new targets.LambdaFunction(ivsMetricsFn));

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=VirtualMeetupPlatform-${envName}`,
      description: 'CloudWatch Dashboard URL',
    });

    new CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS Topic ARN for alarms',
      exportName: `VirtualMeetup-${envName}-AlarmTopicArn`,
    });

    // Expose for cross-stack references
    this.alarmTopic = alarmTopic;
    this.dashboard = dashboard;
    this.ivsMetricsFn = ivsMetricsFn;
  }
}

module.exports = { ObservabilityStack };

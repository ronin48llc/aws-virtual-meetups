'use strict';

const path = require('path');
const { Stack, Duration, CfnOutput } = require('aws-cdk-lib');
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

    // Lambda function names — used below to build dashboard widgets and
    // Logs Insights query definitions. Log RETENTION on these groups is
    // now configured per-Lambda via the canonical `logRetention:` prop on
    // each lambda.Function across the other stacks; the previous pattern
    // of pre-creating LogGroup constructs here raced with Lambda's
    // auto-create-on-first-invoke behavior on fresh deploys (CFN cannot
    // adopt an already-existing log group). See issue #30.
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

    // Issue #109: description previously claimed "rate exceeds 5%" but
    // the metric is a raw Sum with threshold 5 — alarm fires on the
    // 6th 5xx in a 5-minute window regardless of total traffic. That's
    // still a reasonable signal, but the description was misleading.
    const apiErrorAlarm = new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: `VirtualMeetup-${envName}-ApiErrorRate`,
      alarmDescription: 'HTTP API: more than 5 server-side (5xx) errors in 5 minutes',
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

    // Issue #109: per-function Lambda error alarms. Previously a single
    // alarm with no FunctionName dimension aggregated AWS/Lambda Errors
    // across the whole account — noise from unrelated workloads would
    // trip our pager and real platform errors got lost in the noise.
    // Per-function alarms give the operator the broken function's name
    // directly in the alarm. Threshold kept at "≥1 error per 5min" —
    // the description now states the actual semantic (not the previous
    // misleading "1% rate" wording).
    lambdaFunctionNames.forEach((fnName) => {
      const fnErrorAlarm = new cloudwatch.Alarm(this, `LambdaErrorAlarm-${fnName}`, {
        alarmName: `VirtualMeetup-${envName}-${fnName}-Errors`,
        alarmDescription: `${fnName} produced ≥1 error in 5 minutes`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Errors',
          dimensionsMap: { FunctionName: fnName },
          statistic: 'Sum',
          period: Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      fnErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    });

    // Issue #109: per-table DynamoDB throttle alarms. The previous alarm
    // omitted TableName and aggregated across every DDB table in the
    // account — including CDK bootstrap tables and other apps' tables.
    [mainTable, connectionsTable].filter(Boolean).forEach((table) => {
      const tableName = table.tableName;
      const throttleAlarm = new cloudwatch.Alarm(this, `DynamoThrottleAlarm-${table.node.id}`, {
        alarmName: `VirtualMeetup-${envName}-${table.node.id}-Throttling`,
        alarmDescription: `DynamoDB throttled requests on ${table.node.id}`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ThrottledRequests',
          dimensionsMap: { TableName: tableName },
          statistic: 'Sum',
          period: Duration.minutes(1),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      throttleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    });

    // Issue #113: the previous WebSocketFailureAlarm referenced
    // `ConnectError`, which is NOT a real CloudWatch metric for API
    // Gateway v2 WebSocket APIs. The actual metric names are
    // ClientError (4xx, e.g. auth failures on $connect) and
    // ExecutionError (5xx, integration / Lambda failures). The old
    // alarm sat in INSUFFICIENT_DATA forever, giving the operator a
    // false sense that WS failures were being monitored.
    //
    // 'prod' must match the WebSocketStage stageName in api-stack.js.
    const wsStageName = 'prod';
    const wsApiId = webSocketApi ? webSocketApi.apiId : 'placeholder';

    const wsClientErrorAlarm = new cloudwatch.Alarm(this, 'WebSocketClientErrorAlarm', {
      alarmName: `VirtualMeetup-${envName}-WebSocketClientErrors`,
      alarmDescription: 'WebSocket API client errors (4xx — auth failures, bad messages) exceed 10/min',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'ClientError',
        dimensionsMap: { ApiId: wsApiId, Stage: wsStageName },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    wsClientErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    const wsExecutionErrorAlarm = new cloudwatch.Alarm(this, 'WebSocketExecutionErrorAlarm', {
      alarmName: `VirtualMeetup-${envName}-WebSocketExecutionErrors`,
      alarmDescription: 'WebSocket API execution errors (5xx — integration/Lambda failures) exceed 5/min',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'ExecutionError',
        dimensionsMap: { ApiId: wsApiId, Stage: wsStageName },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    wsExecutionErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Issue #109: per-function p99 duration alarms. Same dimension fix as
    // the error alarms above — without FunctionName, this aggregated p99
    // across every Lambda in the account.
    lambdaFunctionNames.forEach((fnName) => {
      const fnDurationAlarm = new cloudwatch.Alarm(this, `LambdaDurationAlarm-${fnName}`, {
        alarmName: `VirtualMeetup-${envName}-${fnName}-Duration`,
        alarmDescription: `${fnName} p99 duration exceeds 5 seconds over a 5-minute window`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Duration',
          dimensionsMap: { FunctionName: fnName },
          statistic: 'p99',
          period: Duration.minutes(5),
        }),
        threshold: 5000,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      fnDurationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    });

    // Alarm: Lambda Throttles > 0 — distinct from Errors; fires when
    // concurrent invocations hit a reserved or account-wide cap. Throttles
    // surface to clients as 502/503 at API GW but don't bump LambdaErrors
    // since the underlying Lambda was never invoked. See #50.
    const lambdaThrottleAlarm = new cloudwatch.Alarm(this, 'LambdaThrottleAlarm', {
      alarmName: `VirtualMeetup-${envName}-LambdaThrottles`,
      alarmDescription: 'Lambda throttling events detected — concurrent invocations hit a cap',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Throttles',
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaThrottleAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // Alarm: API 4xx rate > 50 per 5 min (~10/min). Catches scanning + broken
    // client deploys + systemic authz issues that don't trip the 5xx alarm.
    // Two eval periods so a single press-surge of wrong emails doesn't page.
    const api4xxAlarm = new cloudwatch.Alarm(this, 'Api4xxRateAlarm', {
      alarmName: `VirtualMeetup-${envName}-Api4xxRate`,
      alarmDescription: 'API 4xx error rate elevated — possible client breakage or scanning',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '4xx',
        dimensionsMap: { ApiId: httpApi ? httpApi.apiId : 'placeholder' },
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api4xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

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
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ENVIRONMENT: envName,
      },
    });

    // (Lambda log retention is set via logRetention: on the function above.)

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

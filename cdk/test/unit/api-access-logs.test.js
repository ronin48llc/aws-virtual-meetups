'use strict';

// Tests for issue #36: access logs are attached to both HTTP and
// WebSocket API stages with a stable JSON format that captures the
// fields needed for incident forensics. Synthesizes a minimal stack
// with just the relevant constructs + the configureAccessLogs helper.

const { App, Stack, RemovalPolicy } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { HttpApi } = require('aws-cdk-lib/aws-apigatewayv2');
const { WebSocketApi, WebSocketStage } = require('aws-cdk-lib/aws-apigatewayv2');
const logs = require('aws-cdk-lib/aws-logs');

const {
  configureAccessLogs,
  API_GATEWAY_ACCESS_LOG_FORMAT,
} = require('../../lib/api-stack');

function synthWithBothApis() {
  const app = new App();
  const stack = new Stack(app, 'TestAccessLogStack');

  const httpApi = new HttpApi(stack, 'TestHttpApi', { apiName: 'TestHttpApi' });
  const httpLogGroup = new logs.LogGroup(stack, 'TestHttpLogGroup', {
    logGroupName: '/aws/apigateway/test-http',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  configureAccessLogs(httpApi.defaultStage, httpLogGroup);

  const wsApi = new WebSocketApi(stack, 'TestWsApi', { apiName: 'TestWsApi' });
  const wsStage = new WebSocketStage(stack, 'TestWsStage', {
    webSocketApi: wsApi,
    stageName: 'prod',
    autoDeploy: true,
  });
  const wsLogGroup = new logs.LogGroup(stack, 'TestWsLogGroup', {
    logGroupName: '/aws/apigateway/test-ws',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  configureAccessLogs(wsStage, wsLogGroup);

  return Template.fromStack(stack);
}

describe('API Gateway access logs (issue #36)', () => {
  test('both stages get AccessLogSettings with a destination ARN and JSON format', () => {
    const template = synthWithBothApis();
    // Two AWS::ApiGatewayV2::Stage resources expected: HTTP $default + WS prod.
    template.resourceCountIs('AWS::ApiGatewayV2::Stage', 2);
    template.allResourcesProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({
        DestinationArn: Match.anyValue(),
        Format: API_GATEWAY_ACCESS_LOG_FORMAT,
      }),
    });
  });

  test('log format includes all the fields a responder needs for forensics', () => {
    const parsed = JSON.parse(API_GATEWAY_ACCESS_LOG_FORMAT);
    const required = [
      'requestId',
      'ip',
      'requestTime',
      'httpMethod',
      'routeKey',
      'status',
      'protocol',
      'responseLength',
      'integrationStatus',
      'integrationError',
      'authorizerError',
      'principalId',
      'errorMessage',
    ];
    for (const field of required) {
      expect(parsed).toHaveProperty(field);
      expect(parsed[field]).toMatch(/^\$context\./);
    }
  });

  test('two CloudWatch LogGroups are created with 30-day retention', () => {
    const template = synthWithBothApis();
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    template.allResourcesProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });
});

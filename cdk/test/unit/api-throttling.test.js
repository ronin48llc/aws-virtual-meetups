'use strict';

// Tests focused on the per-route HTTP API throttling configuration
// (issue #28). Synthesizes a minimal stack containing just an HttpApi
// + the throttling helper, so we don't have to wire up the full ApiStack
// dependency graph (Cognito, DynamoDB, SES, Scheduler, Route53).

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { HttpApi } = require('aws-cdk-lib/aws-apigatewayv2');

const {
  configureHttpApiThrottling,
  HTTP_API_DEFAULT_THROTTLE,
  HTTP_API_OPERATOR_THROTTLE,
  HTTP_API_OPERATOR_ROUTES,
} = require('../../lib/api-stack');

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestHttpThrottlingStack');
  const httpApi = new HttpApi(stack, 'TestApi', { apiName: 'TestApi' });
  configureHttpApiThrottling(httpApi);
  return Template.fromStack(stack);
}

describe('HTTP API throttling (issue #28)', () => {
  test('stage has DefaultRouteSettings of 200 rps / 400 burst', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 200,
        ThrottlingBurstLimit: 400,
      }),
    });
  });

  test('stage has RouteSettings entries for every operator route', () => {
    const template = synth();
    const expectedRouteSettings = {};
    for (const routeKey of HTTP_API_OPERATOR_ROUTES) {
      expectedRouteSettings[routeKey] = Match.objectLike({
        ThrottlingRateLimit: 5,
        ThrottlingBurstLimit: 10,
      });
    }
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: Match.objectLike(expectedRouteSettings),
    });
  });

  test('every operator route is a POST (matches CDK route-key convention)', () => {
    for (const routeKey of HTTP_API_OPERATOR_ROUTES) {
      expect(routeKey).toMatch(/^POST /);
    }
  });

  test('exported constants are tighter than account default (10,000 rps) and operator < default', () => {
    expect(HTTP_API_DEFAULT_THROTTLE.ThrottlingRateLimit).toBeLessThan(10000);
    expect(HTTP_API_DEFAULT_THROTTLE.ThrottlingBurstLimit).toBeLessThan(5000);
    expect(HTTP_API_OPERATOR_THROTTLE.ThrottlingRateLimit).toBeLessThan(
      HTTP_API_DEFAULT_THROTTLE.ThrottlingRateLimit,
    );
    expect(HTTP_API_OPERATOR_THROTTLE.ThrottlingBurstLimit).toBeLessThan(
      HTTP_API_DEFAULT_THROTTLE.ThrottlingBurstLimit,
    );
  });

  test('operator route list covers all session-state-mutating + event-create paths', () => {
    expect(HTTP_API_OPERATOR_ROUTES).toEqual(expect.arrayContaining([
      'POST /events',
      'POST /events/{id}/start',
      'POST /events/{id}/stop',
      'POST /events/{id}/go-live',
      'POST /events/{id}/extend',
      'POST /events/{id}/transcription/start',
    ]));
  });
});

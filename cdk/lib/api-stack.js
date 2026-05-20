const path = require('path');
const { Stack, CfnOutput, Duration } = require('aws-cdk-lib');
const { HttpApi, HttpMethod, CorsHttpMethod, HttpStage, DomainName, ApiMapping } = require('aws-cdk-lib/aws-apigatewayv2');
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const { HttpUserPoolAuthorizer } = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const { WebSocketApi, WebSocketStage } = require('aws-cdk-lib/aws-apigatewayv2');
const { WebSocketLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const apigatewayv2 = require('aws-cdk-lib/aws-apigatewayv2');
const lambda = require('aws-cdk-lib/aws-lambda');
const logs = require('aws-cdk-lib/aws-logs');
const iam = require('aws-cdk-lib/aws-iam');
const route53 = require('aws-cdk-lib/aws-route53');
const targets = require('aws-cdk-lib/aws-route53-targets');
const { WafConstruct } = require('./waf-construct');

/**
 * Name of the EventBridge Scheduler group all virtual-meetup schedules live
 * in. The group itself is created by EmailStack (see lib/email-stack.js); we
 * only reference its name here to build a resource ARN pattern for IAM
 * scoping. Must match `SCHEDULER_GROUP` in lambda/shared/scheduler-utils.js.
 */
const SCHEDULER_GROUP_NAME = 'VirtualMeetup-Reminders';

class ApiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { userPool, userPoolClient, mainTable, connectionsTable, emailSenderFunction, schedulerRole, hostedZone, certificate } = props;
    const domainName = props.domainName || 'yourdomain.com';
    // -------------------------------------------------------
    // Cognito Authorizer for HTTP API
    // -------------------------------------------------------
    const cognitoAuthorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });

    // -------------------------------------------------------
    // HTTP API (REST)
    // -------------------------------------------------------
    const httpApi = new HttpApi(this, 'VirtualMeetupHttpApi', {
      apiName: 'VirtualMeetupHttpApi',
      corsPreflight: {
        allowOrigins: [`https://${domainName}`, `https://www.${domainName}`],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: Duration.hours(1),
      },
    });

    // Per-stage default throttle of 200 rps / 400 burst, well under the AWS
    // account default of 10,000 rps. Operator-only routes are tightened
    // further — they should only ever fire on the order of clicks-per-
    // session, so a 5/10 cap catches a runaway client long before WAF
    // (per-IP, 5-min eval) would. End-user routes (signup, join, GET) keep
    // the 200/400 default since aggregate scales with audience size. Pairs
    // with — does not replace — the WAF per-IP rules in waf-construct.js.
    configureHttpApiThrottling(httpApi);

    // -------------------------------------------------------
    // Lambda Functions
    // All Lambdas use the full lambda/ directory as code asset
    // so that shared/ modules are available via relative imports.
    // -------------------------------------------------------
    const lambdaCodePath = path.join(__dirname, '../lambda/');

    // Event CRUD Lambda
    const eventCrudFn = new lambda.Function(this, 'EventCrudFunction', {
      functionName: 'VirtualMeetup-EventCrud',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'event-crud/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        EMAIL_LAMBDA_ARN: emailSenderFunction ? emailSenderFunction.functionArn : '',
        SCHEDULER_ROLE_ARN: schedulerRole ? schedulerRole.roleArn : '',
      },
    });

    // Session Manager Lambda
    const sessionManagerFn = new lambda.Function(this, 'SessionManagerFunction', {
      functionName: 'VirtualMeetup-SessionManager',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'session-manager/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
        RECORDING_BUCKET_NAME: props.recordingBucketName || '',
        EMAIL_LAMBDA_ARN: emailSenderFunction ? emailSenderFunction.functionArn : '',
        SCHEDULER_ROLE_ARN: schedulerRole ? schedulerRole.roleArn : '',
      },
    });

    // Token Generator Lambda
    // Workload: 1-2 DDB GetItems, 1 DDB Query, IVS CreateParticipantToken +
    // IVS CreateChatToken. Observed p99 well under 2s; 15s is ~7x margin
    // for cold start + transient downstream slowness without sitting on
    // a true hang. See #42.
    const tokenGeneratorFn = new lambda.Function(this, 'TokenGeneratorFunction', {
      functionName: 'VirtualMeetup-TokenGenerator',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'token-generator/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(15),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
      },
    });

    // Signup Lambda
    // Workload: 1 DDB Put, 1 DDB Get, 1 fire-and-forget async Lambda invoke.
    // Observed p99 under 1s; 15s is comfortable margin. See #42.
    const signupFn = new lambda.Function(this, 'SignupFunction', {
      functionName: 'VirtualMeetup-Signup',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'signup/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(15),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        EMAIL_LAMBDA_ARN: emailSenderFunction ? emailSenderFunction.functionArn : '',
      },
    });

    // WebSocket Connect Lambda
    // Needs Cognito user-pool / client IDs so it can verify the ID token
    // presented in the $connect query string (issue #4).
    const wsConnectFn = new lambda.Function(this, 'WsConnectFunction', {
      functionName: 'VirtualMeetup-WsConnect',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'websocket/connect.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    // WebSocket Disconnect Lambda
    const wsDisconnectFn = new lambda.Function(this, 'WsDisconnectFunction', {
      functionName: 'VirtualMeetup-WsDisconnect',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'websocket/disconnect.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
      },
    });

    // WebSocket Signaling Lambda
    // Cognito env vars carried for future use; today only the per-message
    // tokenExp check needs them (sourced via the connection record), but
    // any deeper validation (e.g., revocation lookup) will use them too.
    const wsSignalingFn = new lambda.Function(this, 'WsSignalingFunction', {
      functionName: 'VirtualMeetup-WsSignaling',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'websocket/signaling.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(10),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    // -------------------------------------------------------
    // DynamoDB Permissions
    // -------------------------------------------------------
    mainTable.grantReadWriteData(eventCrudFn);
    mainTable.grantReadWriteData(sessionManagerFn);
    mainTable.grantReadWriteData(tokenGeneratorFn);
    mainTable.grantReadWriteData(signupFn);
    mainTable.grantReadWriteData(wsConnectFn);
    mainTable.grantReadWriteData(wsDisconnectFn);
    mainTable.grantReadWriteData(wsSignalingFn);

    connectionsTable.grantReadWriteData(wsConnectFn);
    connectionsTable.grantReadWriteData(wsDisconnectFn);
    connectionsTable.grantReadWriteData(wsSignalingFn);
    connectionsTable.grantReadData(tokenGeneratorFn);
    connectionsTable.grantReadData(sessionManagerFn);

    // -------------------------------------------------------
    // Email & Scheduler Permissions for Event CRUD Lambda
    // -------------------------------------------------------
    if (emailSenderFunction) {
      emailSenderFunction.grantInvoke(eventCrudFn);
      emailSenderFunction.grantInvoke(signupFn);
      emailSenderFunction.grantInvoke(sessionManagerFn);
    }

    // -------------------------------------------------------
    // Scope scheduler:Create/DeleteSchedule actions to schedules inside the
    // VirtualMeetup-Reminders group only. The group itself is created by
    // EmailStack; we just build the ARN pattern that scopes IAM here.
    // -------------------------------------------------------
    const scopedScheduleArn =
      `arn:aws:scheduler:${this.region}:${this.account}:schedule/${SCHEDULER_GROUP_NAME}/*`;

    eventCrudFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:DeleteSchedule',
      ],
      resources: [scopedScheduleArn],
    }));

    // Allow Event CRUD Lambda to pass the scheduler role
    if (schedulerRole) {
      eventCrudFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
      }));
    }

    // IVS permissions for session manager and token generator
    sessionManagerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ivs:CreateStage',
        'ivs:DeleteStage',
        'ivs:CreateParticipantToken',
        'ivs:GetStage',
        'ivs:ListStages',
        'ivs:StartComposition',
        'ivs:StopComposition',
        'ivsrealtime:StartComposition',
        'ivsrealtime:StopComposition',
        'ivsrealtime:GetComposition',
        'ivschat:CreateRoom',
        'ivschat:DeleteRoom',
        'ivschat:CreateChatToken',
      ],
      resources: ['*'],
    }));

    // Session Manager needs S3 access for composition recording
    if (props.recordingBucketName) {
      sessionManagerFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetBucketLocation'],
        resources: [
          `arn:aws:s3:::${props.recordingBucketName}`,
          `arn:aws:s3:::${props.recordingBucketName}/*`,
        ],
      }));
    }

    // Session Manager needs iam:PassRole for IVS composition role
    if (props.ivsCompositionRoleArn) {
      sessionManagerFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.ivsCompositionRoleArn],
      }));
    }

    // Session Manager needs its own ARN for auto-stop scheduler target
    // Use a constructed ARN to avoid circular dependency with HTTP API routes
    const sessionManagerArn = `arn:aws:lambda:${this.region}:${this.account}:function:VirtualMeetup-SessionManager`;
    sessionManagerFn.addEnvironment('SESSION_MANAGER_ARN', sessionManagerArn);
    sessionManagerFn.addEnvironment('IVS_COMPOSITION_ROLE_ARN', props.ivsCompositionRoleArn || '');
    sessionManagerFn.addEnvironment('IVS_STORAGE_CONFIG_ARN', props.ivsStorageConfigArn || '');
    sessionManagerFn.addEnvironment('IVS_ENCODER_CONFIG_ARN', props.ivsEncoderConfigArn || '');
    sessionManagerFn.addEnvironment('RECORDING_CLOUDFRONT_DOMAIN', props.recordingCloudfrontDomain || '');

    // Session Manager needs scheduler permissions for auto-stop and warning schedules
    sessionManagerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
      resources: [scopedScheduleArn],
    }));

    // Session Manager needs iam:PassRole for the scheduler execution role
    if (schedulerRole) {
      sessionManagerFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
      }));
    }

    tokenGeneratorFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ivs:CreateParticipantToken',
        'ivschat:CreateChatToken',
      ],
      resources: ['*'],
    }));

    // -------------------------------------------------------
    // HTTP API Routes — Lambda Integrations
    // -------------------------------------------------------
    const eventCrudIntegration = new HttpLambdaIntegration('EventCrudIntegration', eventCrudFn);
    const sessionManagerIntegration = new HttpLambdaIntegration('SessionManagerIntegration', sessionManagerFn);
    const tokenGeneratorIntegration = new HttpLambdaIntegration('TokenGeneratorIntegration', tokenGeneratorFn);
    const signupIntegration = new HttpLambdaIntegration('SignupIntegration', signupFn);

    // Public routes (no auth)
    httpApi.addRoutes({
      path: '/events',
      methods: [HttpMethod.GET],
      integration: eventCrudIntegration,
    });

    httpApi.addRoutes({
      path: '/events/{id}',
      methods: [HttpMethod.GET],
      integration: eventCrudIntegration,
    });

    // Protected routes (Cognito authorizer)
    httpApi.addRoutes({
      path: '/events',
      methods: [HttpMethod.POST],
      integration: eventCrudIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}',
      methods: [HttpMethod.PUT],
      integration: eventCrudIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}',
      methods: [HttpMethod.DELETE],
      integration: eventCrudIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/start',
      methods: [HttpMethod.POST],
      integration: sessionManagerIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/stop',
      methods: [HttpMethod.POST],
      integration: sessionManagerIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/go-live',
      methods: [HttpMethod.POST],
      integration: sessionManagerIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/extend',
      methods: [HttpMethod.POST],
      integration: sessionManagerIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/join',
      methods: [HttpMethod.POST],
      integration: tokenGeneratorIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/signup',
      methods: [HttpMethod.POST],
      integration: signupIntegration,
      authorizer: cognitoAuthorizer,
    });

    httpApi.addRoutes({
      path: '/events/{id}/signups',
      methods: [HttpMethod.GET],
      integration: signupIntegration,
      authorizer: cognitoAuthorizer,
    });

    // Transcription Lambda (from TranscriptionStack, passed via props)
    if (props.transcriptionFunction) {
      const transcriptionIntegration = new HttpLambdaIntegration('TranscriptionIntegration', props.transcriptionFunction);

      httpApi.addRoutes({
        path: '/events/{id}/transcription/start',
        methods: [HttpMethod.POST],
        integration: transcriptionIntegration,
        authorizer: cognitoAuthorizer,
      });
    }

    // -------------------------------------------------------
    // WebSocket API
    // -------------------------------------------------------
    const webSocketApi = new WebSocketApi(this, 'VirtualMeetupWebSocketApi', {
      apiName: 'VirtualMeetupWebSocketApi',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('WsConnectIntegration', wsConnectFn),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('WsDisconnectIntegration', wsDisconnectFn),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('WsDefaultIntegration', wsSignalingFn),
      },
    });

    const webSocketStage = new WebSocketStage(this, 'VirtualMeetupWebSocketStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // Custom WebSocket routes
    const wsSignalingIntegration = new WebSocketLambdaIntegration('WsSignalingIntegration', wsSignalingFn);

    const customRoutes = [
      'raiseHand',
      'lowerHand',
      'lowerAllHands',
      'submitQuestion',
      'answerQuestion',
      'dismissQuestion',
      'pinQuestion',
      'unpinQuestion',
      'promoteUser',
      'demoteUser',
      'grantSpeak',
      'revokeSpeak',
      'toggleChat',
      'eventStateUpdate',
      'acknowledgeHand',
      'dismissHand',
      'getAttendeeList',
      'getQuestionQueue',
      'getHandsList',
      'typing',
      'broadcastCaption',
    ];

    customRoutes.forEach((routeKey) => {
      webSocketApi.addRoute(routeKey, {
        integration: new WebSocketLambdaIntegration(`Ws${routeKey}Integration`, wsSignalingFn),
      });
    });

    // WebSocket endpoint for environment variables
    // When custom domain is configured, use it for the Management API endpoint
    const wsEndpoint = (hostedZone && certificate)
      ? `https://ws.${domainName}`
      : `https://${webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/${webSocketStage.stageName}`;

    // Update WebSocket Lambda environment variables with the endpoint
    wsSignalingFn.addEnvironment('WEBSOCKET_ENDPOINT', wsEndpoint);
    wsConnectFn.addEnvironment('WEBSOCKET_ENDPOINT', wsEndpoint);
    wsDisconnectFn.addEnvironment('WEBSOCKET_ENDPOINT', wsEndpoint);
    sessionManagerFn.addEnvironment('WEBSOCKET_ENDPOINT', wsEndpoint);

    // API Gateway Management API permissions for WebSocket Lambdas
    const apiGatewayManagePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'execute-api:ManageConnections',
      ],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${webSocketStage.stageName}/POST/@connections/*`,
      ],
    });

    wsSignalingFn.addToRolePolicy(apiGatewayManagePolicy);
    wsConnectFn.addToRolePolicy(apiGatewayManagePolicy);
    wsDisconnectFn.addToRolePolicy(apiGatewayManagePolicy);
    sessionManagerFn.addToRolePolicy(apiGatewayManagePolicy);

    // -------------------------------------------------------
    // Custom Domains (conditional — only if hostedZone and certificate are provided)
    // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5
    // -------------------------------------------------------
    if (hostedZone && certificate) {
      // HTTP API Custom Domain (api.{domainName})
      const httpApiDomainName = new DomainName(this, 'HttpApiDomainName', {
        domainName: `api.${domainName}`,
        certificate: certificate,
      });

      new ApiMapping(this, 'HttpApiMapping', {
        api: httpApi,
        domainName: httpApiDomainName,
      });

      new route53.ARecord(this, 'HttpApiARecord', {
        zone: hostedZone,
        recordName: `api.${domainName}`,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayv2DomainProperties(
            httpApiDomainName.regionalDomainName,
            httpApiDomainName.regionalHostedZoneId,
          ),
        ),
      });

      // WebSocket API Custom Domain (ws.{domainName})
      // Using L1 constructs since L2 WebSocket API doesn't support custom domains
      const wsDomainName = new apigatewayv2.CfnDomainName(this, 'WsApiDomainName', {
        domainName: `ws.${domainName}`,
        domainNameConfigurations: [
          {
            endpointType: 'REGIONAL',
            certificateArn: certificate.certificateArn,
          },
        ],
      });

      new apigatewayv2.CfnApiMapping(this, 'WsApiMapping', {
        apiId: webSocketApi.apiId,
        domainName: wsDomainName.ref,
        stage: webSocketStage.stageName,
      });

      new route53.ARecord(this, 'WsApiARecord', {
        zone: hostedZone,
        recordName: `ws.${domainName}`,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayv2DomainProperties(
            wsDomainName.attrRegionalDomainName,
            wsDomainName.attrRegionalHostedZoneId,
          ),
        ),
      });
    }

    // -------------------------------------------------------
    // AWS WAF - Web Application Firewall
    // Requirements: 23.1, 23.2, 23.3, 23.4
    // -------------------------------------------------------
    // -------------------------------------------------------
    // AWS WAF - Web Application Firewall
    // Requirements: 23.1, 23.2, 23.3, 23.4
    // Issue #103: AWS added AWS::ApiGatewayV2::Stage to the WAF v2 REGIONAL
    // supported-resource list in late 2021. Both HTTP API stages and
    // WebSocket API stages can be associated. The prior `resourceArns: []`
    // configuration left the WebACL attached to nothing — every WAF rule
    // (rate limits, AWS managed Common/SQLi/KnownBadInputs, 4KB body cap)
    // was dead weight while paying ~$11/month per environment.
    //
    // Stage ARN format for API Gateway v2:
    //   arn:<partition>:apigateway:<region>::/apis/<api-id>/stages/<stage-name>
    // HTTP API defaultStage is the `$default` stage CDK creates.
    // -------------------------------------------------------
    const httpStageArn = `arn:${this.partition}:apigateway:${this.region}::/apis/${httpApi.apiId}/stages/${httpApi.defaultStage.stageName}`;
    const wsStageArn = `arn:${this.partition}:apigateway:${this.region}::/apis/${webSocketApi.apiId}/stages/${webSocketStage.stageName}`;

    const waf = new WafConstruct(this, 'ApiWaf', {
      scope: 'REGIONAL',
      resourceArns: [httpStageArn, wsStageArn],
    });

    this.webAcl = waf.webAcl;

    // -------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API endpoint URL',
      exportName: 'VirtualMeetupHttpApiUrl',
    });

    new CfnOutput(this, 'WebSocketApiUrl', {
      value: wsEndpoint,
      description: 'WebSocket API endpoint URL',
      exportName: 'VirtualMeetupWebSocketApiUrl',
    });

    new CfnOutput(this, 'HttpApiId', {
      value: httpApi.apiId,
      description: 'HTTP API ID',
      exportName: 'VirtualMeetupHttpApiId',
    });

    new CfnOutput(this, 'WebSocketApiId', {
      value: webSocketApi.apiId,
      description: 'WebSocket API ID',
      exportName: 'VirtualMeetupWebSocketApiId',
    });

    // Expose for cross-stack references
    this.httpApi = httpApi;
    this.webSocketApi = webSocketApi;
    this.webSocketStage = webSocketStage;
    this.httpApiUrl = httpApi.apiEndpoint;
    this.webSocketApiUrl = wsEndpoint;
  }
}

// Stage-level default throttle. Well under the AWS account default of
// 10,000 rps; sized to absorb a popular event's worth of audience-driven
// traffic without protecting individual end-user-driven routes more
// strictly than they need. Keys are PascalCase to match CloudFormation —
// CfnStage's `routeSettings` is a passthrough map and does not perform
// case transformation on inner objects, so we keep both shapes
// PascalCase for consistency and use addPropertyOverride below.
const HTTP_API_DEFAULT_THROTTLE = {
  ThrottlingRateLimit: 200,
  ThrottlingBurstLimit: 400,
};

// Tighter throttle for operator-only routes (start/stop/extend/create).
// These should never fire faster than a presenter clicking a button.
const HTTP_API_OPERATOR_THROTTLE = {
  ThrottlingRateLimit: 5,
  ThrottlingBurstLimit: 10,
};

// Route keys (METHOD + space + path) that get the operator throttle.
// Format must match API Gateway's RouteKey format exactly.
const HTTP_API_OPERATOR_ROUTES = [
  'POST /events',
  'POST /events/{id}/start',
  'POST /events/{id}/stop',
  'POST /events/{id}/go-live',
  'POST /events/{id}/extend',
  'POST /events/{id}/transcription/start',
];

function configureHttpApiThrottling(httpApi) {
  const cfnStage = httpApi.defaultStage.node.defaultChild;
  // Use addPropertyOverride so both the outer property names and the inner
  // RouteSettings map values land in CloudFormation with PascalCase keys.
  cfnStage.addPropertyOverride('DefaultRouteSettings', HTTP_API_DEFAULT_THROTTLE);
  for (const routeKey of HTTP_API_OPERATOR_ROUTES) {
    cfnStage.addPropertyOverride(`RouteSettings.${routeKey}`, HTTP_API_OPERATOR_THROTTLE);
  }
}

module.exports = {
  ApiStack,
  configureHttpApiThrottling,
  HTTP_API_DEFAULT_THROTTLE,
  HTTP_API_OPERATOR_THROTTLE,
  HTTP_API_OPERATOR_ROUTES,
};

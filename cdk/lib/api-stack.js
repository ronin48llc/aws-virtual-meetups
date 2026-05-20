const path = require('path');
const { Stack, CfnOutput, Duration } = require('aws-cdk-lib');
const { HttpApi, HttpMethod, CorsHttpMethod, HttpStage, DomainName, ApiMapping } = require('aws-cdk-lib/aws-apigatewayv2');
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const { HttpUserPoolAuthorizer } = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const { WebSocketApi, WebSocketStage } = require('aws-cdk-lib/aws-apigatewayv2');
const { WebSocketLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const apigatewayv2 = require('aws-cdk-lib/aws-apigatewayv2');
const lambda = require('aws-cdk-lib/aws-lambda');
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
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
        RECORDING_BUCKET_NAME: props.recordingBucketName || '',
        EMAIL_LAMBDA_ARN: emailSenderFunction ? emailSenderFunction.functionArn : '',
        SCHEDULER_ROLE_ARN: schedulerRole ? schedulerRole.roleArn : '',
      },
    });

    // Token Generator Lambda
    const tokenGeneratorFn = new lambda.Function(this, 'TokenGeneratorFunction', {
      functionName: 'VirtualMeetup-TokenGenerator',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'token-generator/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: mainTable.tableName,
        CONNECTIONS_TABLE_NAME: connectionsTable.tableName,
      },
    });

    // Signup Lambda
    const signupFn = new lambda.Function(this, 'SignupFunction', {
      functionName: 'VirtualMeetup-Signup',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'signup/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
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
    // Note: WAF v2 REGIONAL WebACL cannot be directly associated with API Gateway v2
    // (HTTP API / WebSocket API). WAF protection is applied via CloudFront in the
    // Frontend stack. API-level rate limiting is handled by API Gateway throttling.
    // -------------------------------------------------------
    const waf = new WafConstruct(this, 'ApiWaf', {
      scope: 'REGIONAL',
      // No resource ARNs — API Gateway v2 doesn't support WAF association directly
      resourceArns: [],
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

module.exports = { ApiStack };

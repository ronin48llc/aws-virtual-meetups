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
const { RemovalPolicy } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const route53 = require('aws-cdk-lib/aws-route53');
const targets = require('aws-cdk-lib/aws-route53-targets');
const { withEnv, schedulerGroupName } = require('./env-config');

class ApiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { userPool, userPoolClient, mainTable, connectionsTable, emailSenderFunction, schedulerRole, hostedZone, certificate, chatReviewFunction } = props;
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
      apiName: withEnv(this, 'VirtualMeetupHttpApi'),
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
    // session, so a 5/10 cap catches a runaway client early. End-user routes
    // (signup, join, GET) keep the 200/400 default since aggregate scales
    // with audience size. This throttling is the API's primary abuse guard —
    // WAFv2 cannot attach to API Gateway v2 stages (see the WAF note below).
    //
    // NOTE: called AFTER all addRoutes() below (see the call site) — the
    // stage's per-route RouteSettings are validated against existing routes,
    // so on a fresh stack create the stage must depend on every route or
    // CloudFormation fails with "Unable to find Route by key ..." (observed
    // 2026-07-05 recreating VirtualMeetup-dev-Api).

    // Access logs for HTTP API $default stage. Lambda CloudWatch Logs cover
    // handler execution but not routing/authz/throttle decisions; without
    // these you can't drill into a specific request ("user got a 401 at
    // 14:23") after an incident. See issue #36.
    const httpApiAccessLogGroup = new logs.LogGroup(this, 'HttpApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${withEnv(this, 'VirtualMeetupHttpApi')}/access`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    configureAccessLogs(httpApi.defaultStage, httpApiAccessLogGroup);

    // -------------------------------------------------------
    // Lambda Functions
    // All Lambdas use the full lambda/ directory as code asset
    // so that shared/ modules are available via relative imports.
    // -------------------------------------------------------
    const lambdaCodePath = path.join(__dirname, '../lambda/');

    // Event CRUD Lambda
    const eventCrudFn = new lambda.Function(this, 'EventCrudFunction', {
      functionName: withEnv(this, 'VirtualMeetup-EventCrud'),
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
        // Lets getEvent verify a recording manifest exists before exposing
        // its playback URL (IVS uploads lag stops; empty sessions record
        // nothing at all).
        RECORDING_BUCKET_NAME: props.recordingBucketName || '',
      },
    });

    // Session Manager Lambda
    const sessionManagerFn = new lambda.Function(this, 'SessionManagerFunction', {
      functionName: withEnv(this, 'VirtualMeetup-SessionManager'),
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
      functionName: withEnv(this, 'VirtualMeetup-TokenGenerator'),
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

    // Anonymous Token Lambda
    const anonymousTokenFn = new lambda.Function(this, 'AnonymousTokenFunction', {
      functionName: withEnv(this, 'VirtualMeetup-AnonymousToken'),
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'anonymous-token/index.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      // #30: 30-day log retention like every other function in this stack.
      // This public, unauthenticated Lambda was added after the original
      // retention sweep and slipped through without it.
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: mainTable.tableName,
        RECORDING_BUCKET_NAME: props.recordingBucketName || '',
      },
    });

    // Signup Lambda
    // Workload: 1 DDB Put, 1 DDB Get, 1 fire-and-forget async Lambda invoke.
    // Observed p99 under 1s; 15s is comfortable margin. See #42.
    const signupFn = new lambda.Function(this, 'SignupFunction', {
      functionName: withEnv(this, 'VirtualMeetup-Signup'),
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
      functionName: withEnv(this, 'VirtualMeetup-WsConnect'),
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
      functionName: withEnv(this, 'VirtualMeetup-WsDisconnect'),
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
      functionName: withEnv(this, 'VirtualMeetup-WsSignaling'),
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
    mainTable.grantReadWriteData(anonymousTokenFn);
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
    // per-env reminders group only. The group itself is created by
    // EmailStack; we just build the ARN pattern that scopes IAM here.
    // The same name is passed to the Lambdas via SCHEDULER_GROUP_NAME so
    // lambda/shared/scheduler-utils.js creates schedules in the right group.
    // -------------------------------------------------------
    const schedulerGroup = schedulerGroupName(this);
    const scopedScheduleArn =
      `arn:aws:scheduler:${this.region}:${this.account}:schedule/${schedulerGroup}/*`;

    // scheduler-utils.js reads this at runtime to target the per-env group.
    eventCrudFn.addEnvironment('SCHEDULER_GROUP_NAME', schedulerGroup);
    sessionManagerFn.addEnvironment('SCHEDULER_GROUP_NAME', schedulerGroup);

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
        // The ivs-realtime SDK's GetComposition authorizes as
        // ivs:GetComposition (observed live: AccessDenied at stop, which
        // left hlsPlaybackUrl unset for every recording). Keep the
        // ivsrealtime:* variants too for API-namespace drift safety.
        'ivs:GetComposition',
        'ivsrealtime:StartComposition',
        'ivsrealtime:StopComposition',
        'ivsrealtime:GetComposition',
        'ivschat:CreateRoom',
        'ivschat:DeleteRoom',
        'ivschat:CreateChatToken',
      ],
      resources: ['*'],
    }));

    // event-crud + anonymous-token verify recording manifests exist before
    // returning playback URLs (HeadObject authorizes as s3:GetObject).
    if (props.recordingBucketName) {
      const recordingReadPolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${props.recordingBucketName}/*`],
      });
      eventCrudFn.addToRolePolicy(recordingReadPolicy);
      anonymousTokenFn.addToRolePolicy(recordingReadPolicy);
    }

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
    const sessionManagerArn = `arn:aws:lambda:${this.region}:${this.account}:function:${withEnv(this, 'VirtualMeetup-SessionManager')}`;
    sessionManagerFn.addEnvironment('SESSION_MANAGER_ARN', sessionManagerArn);
    sessionManagerFn.addEnvironment('IVS_COMPOSITION_ROLE_ARN', props.ivsCompositionRoleArn || '');
    sessionManagerFn.addEnvironment('IVS_STORAGE_CONFIG_ARN', props.ivsStorageConfigArn || '');
    sessionManagerFn.addEnvironment('IVS_ENCODER_CONFIG_ARN', props.ivsEncoderConfigArn || '');
    sessionManagerFn.addEnvironment('RECORDING_CLOUDFRONT_DOMAIN', props.domainName ? `recordings.${props.domainName}` : (props.recordingCloudfrontDomain || ''));
    // Issue #101: session-manager wires this ARN as messageReviewHandler on
    // every IVS Chat room it creates. Empty value means no review handler
    // (fail-open) — only acceptable for non-prod or staging deploys that
    // explicitly opt out.
    sessionManagerFn.addEnvironment('CHAT_REVIEW_LAMBDA_ARN', chatReviewFunction ? chatReviewFunction.functionArn : '');

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

      // Issue #119: the EventBridge Scheduler role (defined in
      // email-stack.js) was only granted lambda:InvokeFunction on the
      // email Lambda. Auto-stop and time-warning schedules that
      // session-manager creates pointing at itself failed at firing time
      // because the role couldn't invoke session-manager. Add the grant
      // here via an explicit iam.Policy resource owned by ApiStack so it
      // doesn't create a cross-stack cycle (the role lives in EmailStack,
      // the function lives in ApiStack — putting the policy in ApiStack
      // means the dependency runs ApiStack → EmailStack only).
      new iam.Policy(this, 'SchedulerInvokeSessionManagerPolicy', {
        roles: [schedulerRole],
        statements: [new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [sessionManagerFn.functionArn],
        })],
      });
    }

    tokenGeneratorFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ivs:CreateParticipantToken',
        'ivschat:CreateChatToken',
      ],
      resources: ['*'],
    }));

    anonymousTokenFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ivs:CreateParticipantToken',
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
    const anonymousTokenIntegration = new HttpLambdaIntegration('AnonymousTokenIntegration', anonymousTokenFn);

    // Public routes (no auth)
    // Health probe for smoke tests and synthetic monitoring. Checks the
    // DynamoDB dependency inside event-crud, not just Lambda liveness.
    httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: eventCrudIntegration,
    });

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

    // Anonymous access routes (unauthenticated — no authorizer)
    httpApi.addRoutes({
      path: '/events/{id}/join-anonymous',
      methods: [HttpMethod.POST],
      integration: anonymousTokenIntegration,
    });

    httpApi.addRoutes({
      path: '/events/{id}/playback-anonymous',
      methods: [HttpMethod.POST],
      integration: anonymousTokenIntegration,
    });

    // Session upgrade route (authenticated — Cognito authorizer)
    httpApi.addRoutes({
      path: '/events/{id}/upgrade-session',
      methods: [HttpMethod.POST],
      integration: tokenGeneratorIntegration,
      authorizer: cognitoAuthorizer,
    });

    // Admin API (Lambda lives in AuthStack, passed via props). The Cognito
    // authorizer proves identity; the handler itself enforces
    // custom:role=organizer on every request (issue #93), so a valid but
    // non-organizer JWT gets 403.
    if (props.adminApiFunction) {
      const adminApiIntegration = new HttpLambdaIntegration('AdminApiIntegration', props.adminApiFunction);

      httpApi.addRoutes({
        path: '/admin/users/disable',
        methods: [HttpMethod.POST],
        integration: adminApiIntegration,
        authorizer: cognitoAuthorizer,
      });

      httpApi.addRoutes({
        path: '/admin/users/enable',
        methods: [HttpMethod.POST],
        integration: adminApiIntegration,
        authorizer: cognitoAuthorizer,
      });

      httpApi.addRoutes({
        path: '/admin/users/{username}/status',
        methods: [HttpMethod.GET],
        integration: adminApiIntegration,
        authorizer: cognitoAuthorizer,
      });
    }

    // Must run after every addRoutes() above: it wires the stage's
    // RouteSettings AND makes the stage depend on all routes so a fresh
    // create doesn't validate throttle keys against not-yet-created routes.
    configureHttpApiThrottling(httpApi);

    // -------------------------------------------------------
    // WebSocket API
    // -------------------------------------------------------
    const webSocketApi = new WebSocketApi(this, 'VirtualMeetupWebSocketApi', {
      apiName: withEnv(this, 'VirtualMeetupWebSocketApi'),
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

    // Access logs for the WebSocket prod stage (same rationale as HTTP).
    const wsApiAccessLogGroup = new logs.LogGroup(this, 'WebSocketApiAccessLogGroup', {
      logGroupName: `/aws/apigateway/${withEnv(this, 'VirtualMeetupWebSocketApi')}/access`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    configureAccessLogs(webSocketStage, wsApiAccessLogGroup);

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

      const wsApiMapping = new apigatewayv2.CfnApiMapping(this, 'WsApiMapping', {
        apiId: webSocketApi.apiId,
        domainName: wsDomainName.ref,
        stage: webSocketStage.stageName,
      });
      // `stage` is a literal name string, so CloudFormation sees no edge
      // between the mapping and the stage. Without an explicit dependency,
      // stack deletion can attempt the stage first and fail with "remove all
      // base path mappings related to the stage" (observed 2026-07-05
      // deleting VirtualMeetup-dev-Api). The dependency forces create-after /
      // delete-before ordering of the mapping relative to the stage.
      wsApiMapping.addDependency(webSocketStage.node.defaultChild);

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
    // No WAF on the HTTP/WebSocket APIs — deliberately.
    //
    // WAFv2 REGIONAL cannot associate with API Gateway v2 (HTTP API /
    // WebSocket API) stages: WAF only accepts REST API (`/restapis/`) ARNs.
    // A previous revision created a REGIONAL WebACL here with an empty
    // resourceArns list "for future use" — it inspected nothing and billed
    // ~$10/month, while the docs claimed the API was WAF-protected. Removed.
    //
    // What actually protects these APIs today:
    //   - Stage throttling (configureHttpApiThrottling above): 200 rps
    //     default, 5 rps on operator routes.
    //   - Cognito authorizers on all mutating routes; per-fingerprint
    //     DynamoDB rate limiting on the anonymous routes.
    //   - The frontend (and its CloudFront distribution) sits behind a
    //     CLOUDFRONT-scope WebACL with AWS managed rules (frontend-stack).
    //
    // If managed-rule inspection of the API itself becomes a requirement,
    // front the HTTP API with CloudFront and attach a CLOUDFRONT WebACL
    // there. See: https://stackoverflow.com/questions/63304201
    // -------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API endpoint URL',
      exportName: withEnv(this, 'VirtualMeetupHttpApiUrl'),
    });

    new CfnOutput(this, 'WebSocketApiUrl', {
      value: wsEndpoint,
      description: 'WebSocket API endpoint URL',
      exportName: withEnv(this, 'VirtualMeetupWebSocketApiUrl'),
    });

    new CfnOutput(this, 'HttpApiId', {
      value: httpApi.apiId,
      description: 'HTTP API ID',
      exportName: withEnv(this, 'VirtualMeetupHttpApiId'),
    });

    new CfnOutput(this, 'WebSocketApiId', {
      value: webSocketApi.apiId,
      description: 'WebSocket API ID',
      exportName: withEnv(this, 'VirtualMeetupWebSocketApiId'),
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
  'POST /admin/users/disable',
  'POST /admin/users/enable',
];

function configureHttpApiThrottling(httpApi) {
  const cfnStage = httpApi.defaultStage.node.defaultChild;
  // Use addPropertyOverride so both the outer property names and the inner
  // RouteSettings map values land in CloudFormation with PascalCase keys.
  cfnStage.addPropertyOverride('DefaultRouteSettings', HTTP_API_DEFAULT_THROTTLE);
  for (const routeKey of HTTP_API_OPERATOR_ROUTES) {
    cfnStage.addPropertyOverride(`RouteSettings.${routeKey}`, HTTP_API_OPERATOR_THROTTLE);
  }
  // API Gateway validates per-route RouteSettings keys against EXISTING
  // routes when the stage is created/updated. Routes and stage otherwise
  // have no dependency edge, so a fresh stack create can order the stage
  // first and fail with "Unable to find Route by key POST /events/{id}/...".
  // Depend on every route of this API (call this function after all
  // addRoutes()). HttpRoute constructs live under the HttpApi scope.
  for (const child of httpApi.node.findAll()) {
    if (child.node && child.node.defaultChild &&
        child.node.defaultChild.cfnResourceType === 'AWS::ApiGatewayV2::Route') {
      cfnStage.node.addDependency(child);
    }
  }
}

// JSON format for API Gateway access logs. Captures the per-request facts
// you actually need to debug a production incident: who, when, what, why
// it failed. The $context.* variables are evaluated by API Gateway at log
// emit time.
const API_GATEWAY_ACCESS_LOG_FORMAT = JSON.stringify({
  requestId: '$context.requestId',
  ip: '$context.identity.sourceIp',
  requestTime: '$context.requestTime',
  httpMethod: '$context.httpMethod',
  routeKey: '$context.routeKey',
  status: '$context.status',
  protocol: '$context.protocol',
  responseLength: '$context.responseLength',
  integrationStatus: '$context.integrationStatus',
  integrationError: '$context.integration.error',
  authorizerError: '$context.authorizer.error',
  principalId: '$context.authorizer.principalId',
  errorMessage: '$context.error.message',
});

function configureAccessLogs(stage, logGroup) {
  const cfnStage = stage.node.defaultChild;
  cfnStage.accessLogSettings = {
    destinationArn: logGroup.logGroupArn,
    format: API_GATEWAY_ACCESS_LOG_FORMAT,
  };
}

module.exports = {
  ApiStack,
  configureHttpApiThrottling,
  HTTP_API_DEFAULT_THROTTLE,
  HTTP_API_OPERATOR_THROTTLE,
  HTTP_API_OPERATOR_ROUTES,
  configureAccessLogs,
  API_GATEWAY_ACCESS_LOG_FORMAT,
};

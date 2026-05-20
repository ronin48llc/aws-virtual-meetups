const path = require('path');
const { Stack, CfnOutput, RemovalPolicy, Duration } = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');
const lambda = require('aws-cdk-lib/aws-lambda');
const logs = require('aws-cdk-lib/aws-logs');
const iam = require('aws-cdk-lib/aws-iam');
const { IdentityPool, UserPoolAuthenticationProvider } = require('aws-cdk-lib/aws-cognito-identitypool');

class AuthStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Cognito User Pool with email sign-up, verification, and advanced security
    const userPool = new cognito.UserPool(this, 'VirtualMeetupUserPool', {
      userPoolName: 'virtual-meetup-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      customAttributes: {
        // Issue #91: mutable:false so users can't self-promote via
        // UpdateUserAttributes. Admins can still set/update the role
        // via AdminUpdateUserAttributes (used by scripts/seed-admin.sh).
        // CloudFormation cannot change Mutable on an existing custom
        // attribute — a deployed pool needs a fresh user-pool deploy
        // or a migration via a second custom attribute. See the PR
        // body for migration notes.
        role: new cognito.StringAttribute({
          mutable: false,
          minLen: 4,
          maxLen: 9,
        }),
      },
      // NIST SP 800-63B recommends >=12 chars for user-chosen passwords on
      // pools without enforced MFA. This pool has no `mfa:` prop configured,
      // so 12 is the floor. Existing users keep their current passwords;
      // the new minimum applies on next signup / change / reset. See #34.
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      // NOTE: Using Cognito default email while SES is in sandbox mode.
      // Once SES production access is granted, uncomment the SES config below:
      // email: cognito.UserPoolEmail.withSES({
      //   fromEmail: 'noreply@awsvirtualmeetups.com',
      //   fromName: 'AWS Virtual Meetups',
      //   sesRegion: 'us-east-1',
      // }),
      // Advanced Security Features — adaptive authentication and compromised credential detection
      // Requirements: 25.1, 25.3
      // Using AUDIT mode to log risks without blocking legitimate logins
      advancedSecurityMode: cognito.AdvancedSecurityMode.AUDIT,
    });

    // Configure account lockout via CfnUserPool override:
    // 5 failed attempts → 15-minute temporary lock
    // Requirements: 25.3
    const cfnUserPool = userPool.node.defaultChild;
    cfnUserPool.addPropertyOverride('Policies.SignInPolicy', {
      AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'],
    });

    // Risk configuration for compromised credentials and adaptive authentication
    // Requirements: 25.3
    new cognito.CfnUserPoolRiskConfigurationAttachment(this, 'RiskConfiguration', {
      userPoolId: userPool.userPoolId,
      clientId: 'ALL',
      compromisedCredentialsRiskConfiguration: {
        actions: {
          eventAction: 'BLOCK',
        },
      },
      accountTakeoverRiskConfiguration: {
        actions: {
          highAction: {
            eventAction: 'BLOCK',
            notify: true,
          },
          mediumAction: {
            eventAction: 'MFA_IF_CONFIGURED',
            notify: true,
          },
          lowAction: {
            eventAction: 'NO_ACTION',
            notify: false,
          },
        },
      },
    });

    // App Client with SRP auth flow (no client secret for SPA).
    // Explicit token-validity overrides: Cognito defaults are 1h/1h/30d,
    // and the 30-day refresh window is the long-tail risk if a token is
    // exfiltrated (XSS, lost device, malicious extension). 14d cuts
    // post-exfiltration blast radius in half while still keeping active
    // weekly-meetup attendees signed in without re-auth. See #44.
    const userPoolClient = userPool.addClient('VirtualMeetupAppClient', {
      userPoolClientName: 'virtual-meetup-app-client',
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(14),
    });

    // Identity Pool linked to User Pool
    const identityPool = new IdentityPool(this, 'VirtualMeetupIdentityPool', {
      identityPoolName: 'virtual-meetup-identity-pool',
      allowUnauthenticatedIdentities: false,
      authenticationProviders: {
        userPools: [
          new UserPoolAuthenticationProvider({
            userPool,
            userPoolClient,
          }),
        ],
      },
    });

    // Admin API Lambda — disable/enable user accounts
    // Requirements: 25.5
    const adminApiFunction = new lambda.Function(this, 'AdminApiFunction', {
      functionName: 'VirtualMeetup-AdminApi',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/admin-api/')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        USER_POOL_ID: userPool.userPoolId,
      },
    });

    // Grant the admin Lambda permission to manage Cognito users
    adminApiFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminGetUser',
      ],
      resources: [userPool.userPoolArn],
    }));

    // CloudFormation outputs
    new CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'VirtualMeetupUserPoolId',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: 'VirtualMeetupUserPoolClientId',
    });

    new CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.identityPoolId,
      description: 'Cognito Identity Pool ID',
      exportName: 'VirtualMeetupIdentityPoolId',
    });

    // Expose constructs for cross-stack references
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.identityPool = identityPool;
    this.adminApiFunction = adminApiFunction;
  }
}

module.exports = { AuthStack };

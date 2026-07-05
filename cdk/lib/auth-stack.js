const path = require('path');
const { Stack, CfnOutput, Duration } = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');
const lambda = require('aws-cdk-lib/aws-lambda');
const logs = require('aws-cdk-lib/aws-logs');
const iam = require('aws-cdk-lib/aws-iam');
const { IdentityPool, UserPoolAuthenticationProvider } = require('aws-cdk-lib/aws-cognito-identitypool');
const { withEnv, dataRemovalPolicy } = require('./env-config');

class AuthStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Cognito email delivery. The default Cognito email service caps at
    // ~50 emails/day — fine for dev, unusable for production sign-up
    // volume. Once SES production access is granted (request steps in
    // docs/RUNBOOK.md), deploy with -c sesEmailEnabled=true and Cognito
    // sends through the SES domain identity (created in EmailStack with
    // DKIM) instead.
    const sesEmailEnabledCtx = this.node.tryGetContext('sesEmailEnabled');
    const sesEmailEnabled = sesEmailEnabledCtx === true || sesEmailEnabledCtx === 'true';
    const domainName = this.node.tryGetContext('domainName');
    if (sesEmailEnabled && !domainName) {
      throw new Error('AuthStack: -c sesEmailEnabled=true requires -c domainName=<your-domain.com> for the SES from-address.');
    }

    // Cognito User Pool with email sign-up, verification, and advanced security
    const userPool = new cognito.UserPool(this, 'VirtualMeetupUserPool', {
      userPoolName: withEnv(this, 'virtual-meetup-user-pool'),
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
        // NOTE: mutable:true is required to match the already-deployed User Pool.
        // Cognito does not allow changing mutable on an existing custom attribute.
        // To enforce immutability (issue #91), a new attribute or pool migration
        // would be needed. Security enforcement is handled at the API layer instead.
        role: new cognito.StringAttribute({
          mutable: true,
          minLen: 4,
          maxLen: 9,
        }),
      },
      // Enforce the NIST SP 800-63B minimum length of 12 (#34). A password
      // policy is updatable in place on an existing User Pool, so re-hardening
      // here applies on the next deploy without recreating the pool.
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // RETAIN in prod — deleting the pool deletes every user account.
      removalPolicy: dataRemovalPolicy(this),
      // Default Cognito email (sandbox-safe) unless sesEmailEnabled — see
      // the context gate at the top of this constructor.
      email: sesEmailEnabled
        ? cognito.UserPoolEmail.withSES({
          fromEmail: `noreply@${domainName}`,
          fromName: 'AWS Virtual Meetups',
          sesRegion: this.region,
        })
        : undefined,
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
    //
    // Explicit token-validity overrides (#44): Cognito defaults are 1h/1h/30d,
    // and the 30-day refresh window is the long-tail risk if a token is
    // exfiltrated (XSS, lost device, malicious extension). 14d cuts
    // post-exfiltration blast radius in half while still keeping active
    // weekly-meetup attendees signed in without re-auth.
    //
    // disableOAuth (#99): removes CDK's default OAuth surface (implicit + code
    // grants with the placeholder https://example.com callback). The frontend
    // uses SRP via the Cognito SDK exclusively — no OAuth redirect, no Hosted
    // UI, so the OAuth subsystem is dead code that just expands attack surface.
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
      disableOAuth: true,
    });

    // Identity Pool linked to User Pool
    const identityPool = new IdentityPool(this, 'VirtualMeetupIdentityPool', {
      identityPoolName: withEnv(this, 'virtual-meetup-identity-pool'),
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
      functionName: withEnv(this, 'VirtualMeetup-AdminApi'),
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
      exportName: withEnv(this, 'VirtualMeetupUserPoolId'),
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: withEnv(this, 'VirtualMeetupUserPoolClientId'),
    });

    new CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.identityPoolId,
      description: 'Cognito Identity Pool ID',
      exportName: withEnv(this, 'VirtualMeetupIdentityPoolId'),
    });

    // Expose constructs for cross-stack references
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.identityPool = identityPool;
    this.adminApiFunction = adminApiFunction;
  }
}

module.exports = { AuthStack };

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { AuthStack } = require('../../lib/auth-stack');

describe('AuthStack', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const stack = new AuthStack(app, 'TestAuthStack');
    template = Template.fromStack(stack);
  });

  describe('User Pool with email verification', () => {
    test('creates a User Pool with auto-verify email enabled', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AutoVerifiedAttributes: ['email'],
      });
    });

    test('creates a User Pool with email as sign-in alias', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UsernameAttributes: ['email'],
      });
    });

    test('creates a User Pool with self sign-up enabled', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: {
          AllowAdminCreateUserOnly: false,
        },
      });
    });

    test('creates a User Pool with email required', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Schema: Match.arrayWith([
          Match.objectLike({
            Name: 'email',
            Required: true,
            Mutable: true,
          }),
        ]),
      });
    });

    test('creates a User Pool with email-only account recovery', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AccountRecoverySetting: {
          RecoveryMechanisms: [
            {
              Name: 'verified_email',
              Priority: 1,
            },
          ],
        },
      });
    });
  });

  describe('Advanced Security Features (anti-abuse)', () => {
    test('enables Advanced Security Mode AUDIT for adaptive authentication', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolAddOns: {
          AdvancedSecurityMode: 'AUDIT',
        },
      });
    });

    test('creates risk configuration attachment for compromised credentials', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolRiskConfigurationAttachment', {
        ClientId: 'ALL',
        CompromisedCredentialsRiskConfiguration: {
          Actions: {
            EventAction: 'BLOCK',
          },
        },
      });
    });

    test('creates risk configuration with account takeover protection', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolRiskConfigurationAttachment', {
        AccountTakeoverRiskConfiguration: {
          Actions: {
            HighAction: {
              EventAction: 'BLOCK',
              Notify: true,
            },
            MediumAction: {
              EventAction: 'MFA_IF_CONFIGURED',
              Notify: true,
            },
            LowAction: {
              EventAction: 'NO_ACTION',
              Notify: false,
            },
          },
        },
      });
    });
  });

  describe('Custom attributes', () => {
    test('defines custom:role attribute with correct constraints', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Schema: Match.arrayWith([
          Match.objectLike({
            Name: 'role',
            AttributeDataType: 'String',
            Mutable: true,
            StringAttributeConstraints: {
              MinLength: '4',
              MaxLength: '9',
            },
          }),
        ]),
      });
    });
  });

  describe('App Client with correct auth flows', () => {
    test('creates an App Client with SRP auth flow enabled', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ExplicitAuthFlows: Match.arrayWith([
          'ALLOW_USER_SRP_AUTH',
          'ALLOW_REFRESH_TOKEN_AUTH',
        ]),
      });
    });

    test('creates an App Client without a client secret', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        GenerateSecret: false,
      });
    });

    test('creates an App Client with prevent user existence errors', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        PreventUserExistenceErrors: 'ENABLED',
      });
    });

    test('App Client has explicit token validity overrides (issue #44)', () => {
      // CDK normalizes everything to minutes in the synthesized template:
      //   id/access: Duration.hours(1) -> 60 minutes.
      //   refresh:   Duration.days(14) -> 20160 minutes (14 * 24 * 60).
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        IdTokenValidity: 60,
        AccessTokenValidity: 60,
        RefreshTokenValidity: 20160,
        TokenValidityUnits: Match.objectLike({
          IdToken: 'minutes',
          AccessToken: 'minutes',
          RefreshToken: 'minutes',
        }),
      });
    });
  });

  describe('Admin API Lambda for user account management', () => {
    test('creates an Admin API Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'VirtualMeetup-AdminApi',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Timeout: 30,
      });
    });

    test('Admin API Lambda has USER_POOL_ID environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'VirtualMeetup-AdminApi',
        Environment: {
          Variables: Match.objectLike({
            USER_POOL_ID: Match.anyValue(),
          }),
        },
      });
    });

    test('Admin API Lambda has Cognito admin permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: Match.arrayWith([
                'cognito-idp:AdminDisableUser',
                'cognito-idp:AdminEnableUser',
                'cognito-idp:AdminGetUser',
              ]),
            }),
          ]),
        },
      });
    });
  });

  describe('CloudFormation outputs', () => {
    test('exports User Pool ID', () => {
      template.hasOutput('UserPoolId', {
        Export: { Name: 'VirtualMeetupUserPoolId' },
      });
    });

    test('exports User Pool Client ID', () => {
      template.hasOutput('UserPoolClientId', {
        Export: { Name: 'VirtualMeetupUserPoolClientId' },
      });
    });

    test('exports Identity Pool ID', () => {
      template.hasOutput('IdentityPoolId', {
        Export: { Name: 'VirtualMeetupIdentityPoolId' },
      });
    });
  });

  describe('Password policy (issue #34)', () => {
    test('User Pool MinimumLength is 12 (NIST SP 800-63B)', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            MinimumLength: 12,
          }),
        }),
      });
    });

    test('User Pool requires lowercase + uppercase + digits', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
          }),
        }),
      });
    });
  });
});

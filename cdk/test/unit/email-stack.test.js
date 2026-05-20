const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { EmailStack } = require('../../lib/email-stack');

describe('EmailStack', () => {
  let template;
  let stack;

  beforeAll(() => {
    const app = new App();
    stack = new EmailStack(app, 'TestEmailStack', {
      tableName: 'VirtualMeetupTable',
      tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/VirtualMeetupTable',
      frontendUrl: 'https://d2hbje3cen4qrx.cloudfront.net',
    });
    template = Template.fromStack(stack);
  });

  describe('Email Sender Lambda Function', () => {
    test('creates Lambda function with Node.js 20.x runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
      });
    });

    test('creates Lambda function with index.handler', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
      });
    });

    test('creates Lambda function with TABLE_NAME environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            TABLE_NAME: 'VirtualMeetupTable',
          }),
        },
      });
    });

    test('creates Lambda function with SES_SENDER environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            SES_SENDER: 'noreply@example.com',
          }),
        },
      });
    });

    test('creates Lambda function with FRONTEND_URL environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            FRONTEND_URL: 'https://d2hbje3cen4qrx.cloudfront.net',
          }),
        },
      });
    });
  });

  describe('SES Email Identity', () => {
    test('creates SES EmailIdentity resource', () => {
      template.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: 'noreply@example.com',
      });
    });
  });

  describe('EventBridge Scheduler Group', () => {
    test('creates Scheduler Group with name VirtualMeetup-Reminders', () => {
      template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
        Name: 'VirtualMeetup-Reminders',
      });
    });
  });

  describe('IAM Role for Scheduler', () => {
    test('creates IAM Role with scheduler.amazonaws.com as principal', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: {
                Service: 'scheduler.amazonaws.com',
              },
            }),
          ]),
        },
      });
    });

    test('Scheduler Role has lambda:InvokeFunction permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'lambda:InvokeFunction',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('Email Lambda Permissions', () => {
    test('Email Lambda has SES SendEmail and SendRawEmail permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['ses:SendEmail', 'ses:SendRawEmail'],
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('SES Send* permissions are scoped to the verified identity, not Resource "*" (issue #2)', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      let foundScopedStatement = false;
      for (const [, policy] of Object.entries(policies)) {
        const statements = policy.Properties.PolicyDocument.Statement || [];
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          if (!actions.includes('ses:SendEmail') && !actions.includes('ses:SendRawEmail')) continue;

          const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
          for (const r of resources) {
            // Must not be the wildcard
            expect(r).not.toBe('*');
            // Must reference an SES identity ARN — CDK serializes this as
            // an Fn::Join of arn parts; the literal "identity/" segment
            // appears in the joined string.
            expect(JSON.stringify(r)).toMatch(/identity/);
            foundScopedStatement = true;
          }
        }
      }
      expect(foundScopedStatement).toBe(true);
    });

    test('Email Lambda has DynamoDB GetItem and Query permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['dynamodb:GetItem', 'dynamodb:Query'],
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('Dead Letter Queue', () => {
    test('creates SQS Queue for DLQ', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'VirtualMeetup-EmailDLQ',
      });
    });

    test('Lambda EventInvokeConfig exists with OnFailure destination', () => {
      template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
        DestinationConfig: {
          OnFailure: Match.objectLike({
            Destination: Match.anyValue(),
          }),
        },
      });
    });
  });

  describe('Cross-stack references', () => {
    test('exposes emailSenderFunction reference', () => {
      expect(stack.emailSenderFunction).toBeDefined();
    });

    test('exposes schedulerRole reference', () => {
      expect(stack.schedulerRole).toBeDefined();
    });

    test('exposes emailDlq reference', () => {
      expect(stack.emailDlq).toBeDefined();
    });
  });
});

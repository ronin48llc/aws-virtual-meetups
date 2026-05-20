const path = require('path');
const { Stack, CfnOutput, Duration } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const logs = require('aws-cdk-lib/aws-logs');
const { SqsDestination } = require('aws-cdk-lib/aws-lambda-destinations');
const iam = require('aws-cdk-lib/aws-iam');
const sqs = require('aws-cdk-lib/aws-sqs');
const ses = require('aws-cdk-lib/aws-ses');
const route53 = require('aws-cdk-lib/aws-route53');
const scheduler = require('aws-cdk-lib/aws-scheduler');

class EmailStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { tableName, tableArn, frontendUrl, hostedZone } = props;

    // -------------------------------------------------------
    // SES Email Identity — Verified sender
    // If hostedZone is provided, use domain identity (with automatic DKIM);
    // otherwise fall back to the legacy email-address identity.
    // Requirements: 6.1, 6.2, 6.4
    // -------------------------------------------------------
    if (hostedZone) {
      const sesIdentity = new ses.EmailIdentity(this, 'SenderDomainIdentity', {
        identity: ses.Identity.publicHostedZone(hostedZone),
      });

      // MX record for SES inbound SMTP (bounce handling)
      // Requirement: 6.5
      new route53.MxRecord(this, 'SesMxRecord', {
        zone: hostedZone,
        values: [
          {
            priority: 10,
            hostName: 'inbound-smtp.us-east-1.amazonaws.com',
          },
        ],
      });
    } else {
      // Fallback: verify a specific email address when no domain is configured
      const fallbackEmail = this.node.tryGetContext('sesVerifiedEmail') || 'noreply@example.com';
      const sesIdentity = new ses.EmailIdentity(this, 'SenderEmailIdentity', {
        identity: ses.Identity.email(fallbackEmail),
      });
    }

    // Determine sender address based on whether domain identity is configured
    // Requirement: 6.3
    const sesSender = hostedZone
      ? `noreply@${hostedZone.zoneName}`
      : 'noreply@example.com';

    // -------------------------------------------------------
    // SQS Dead Letter Queue for failed async Lambda invocations
    // -------------------------------------------------------
    const emailDlq = new sqs.Queue(this, 'EmailDLQ', {
      queueName: 'VirtualMeetup-EmailDLQ',
      retentionPeriod: Duration.days(14),
    });

    // -------------------------------------------------------
    // Email Sender Lambda Function
    // -------------------------------------------------------
    const emailSenderFn = new lambda.Function(this, 'EmailSenderFunction', {
      functionName: 'VirtualMeetup-EmailSender',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/email-sender')),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        TABLE_NAME: tableName,
        SES_SENDER: sesSender,
        FRONTEND_URL: frontendUrl,
      },
    });

    // Configure async invoke with DLQ destination
    new lambda.EventInvokeConfig(this, 'EmailSenderAsyncConfig', {
      function: emailSenderFn,
      onFailure: new SqsDestination(emailDlq),
    });

    // -------------------------------------------------------
    // Email Lambda Permissions — SES SendEmail/SendRawEmail
    // -------------------------------------------------------
    emailSenderFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ses:SendEmail',
        'ses:SendRawEmail',
      ],
      resources: ['*'],
    }));

    // -------------------------------------------------------
    // Email Lambda Permissions — DynamoDB read on VirtualMeetupTable
    // -------------------------------------------------------
    emailSenderFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
      ],
      resources: [
        tableArn,
        `${tableArn}/index/*`,
      ],
    }));

    // -------------------------------------------------------
    // EventBridge Scheduler Group
    // -------------------------------------------------------
    const schedulerGroup = new scheduler.CfnScheduleGroup(this, 'ReminderSchedulerGroup', {
      name: 'VirtualMeetup-Reminders',
    });

    // -------------------------------------------------------
    // IAM Role for Scheduler to invoke the Email Lambda
    // -------------------------------------------------------
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: 'VirtualMeetup-SchedulerRole',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke the Email Sender Lambda',
    });

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [emailSenderFn.functionArn],
    }));

    // -------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'EmailSenderFunctionArn', {
      value: emailSenderFn.functionArn,
      description: 'ARN of the Email Sender Lambda function',
      exportName: 'EmailSenderFunctionArn',
    });

    new CfnOutput(this, 'SchedulerRoleArn', {
      value: schedulerRole.roleArn,
      description: 'ARN of the Scheduler execution role',
      exportName: 'SchedulerRoleArn',
    });

    // Expose references for cross-stack use
    this.emailSenderFunction = emailSenderFn;
    this.schedulerRole = schedulerRole;
    this.emailDlq = emailDlq;
  }
}

module.exports = { EmailStack };

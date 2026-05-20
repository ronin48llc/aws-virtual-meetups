const path = require('path');
const { Stack, CfnOutput, Duration } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
const sqs = require('aws-cdk-lib/aws-sqs');
const iam = require('aws-cdk-lib/aws-iam');

class PublicationStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { recordingBucket, emailSenderFunction, recordingCloudfrontDomain } = props;

    // -------------------------------------------------------
    // Secrets Manager — GitHub Token
    // -------------------------------------------------------
    const githubTokenSecret = new secretsmanager.Secret(this, 'GitHubTokenSecret', {
      secretName: 'VirtualMeetup/GitHubToken',
      description: 'GitHub personal access token for publishing recordings to GitHub Pages',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ token: 'REPLACE_WITH_GITHUB_TOKEN' }),
        generateStringKey: 'placeholder',
      },
    });

    // -------------------------------------------------------
    // SQS Dead Letter Queue for failed publication attempts
    // -------------------------------------------------------
    const publicationDlq = new sqs.Queue(this, 'PublicationDLQ', {
      queueName: 'VirtualMeetup-PublicationDLQ',
      retentionPeriod: Duration.days(14),
    });

    // -------------------------------------------------------
    // Publisher Lambda Function
    // -------------------------------------------------------
    const publisherFunction = new lambda.Function(this, 'PublisherFunction', {
      functionName: 'VirtualMeetup-Publisher',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/publisher/')),
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        RECORDING_BUCKET_NAME: recordingBucket.bucketName,
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
        GITHUB_REPO: 'aws-community-meetup-recordings',
        GITHUB_OWNER: 'aws-community',
        // Issue #107: the publisher builds hls_url as
        //   https://${CLOUDFRONT_DOMAIN}/recordings/${eventId}/media/master.m3u8
        // and embeds the same URL in the Jekyll post's <script>. Leaving this
        // empty (the prior default) produces `https:///recordings/...` —
        // invalid URL, video player breaks on every published recording.
        // session-manager already gets the real domain piped through; this
        // closes the symmetric wire-up for the publisher.
        CLOUDFRONT_DOMAIN: recordingCloudfrontDomain || '',
        EMAIL_LAMBDA_ARN: emailSenderFunction ? emailSenderFunction.functionArn : '',
      },
      deadLetterQueue: publicationDlq,
      retryAttempts: 2,
    });

    // -------------------------------------------------------
    // Permissions — Grant Lambda read access to secret and S3 bucket
    // -------------------------------------------------------
    githubTokenSecret.grantRead(publisherFunction);
    recordingBucket.grantRead(publisherFunction);

    // Grant Publisher Lambda permission to invoke Email Lambda
    if (emailSenderFunction) {
      emailSenderFunction.grantInvoke(publisherFunction);
    }

    // -------------------------------------------------------
    // EventBridge Rule — Trigger on S3 object creation in recordings prefix
    // The recording bucket must have EventBridge notifications enabled.
    // Filters for metadata.json files which signal a completed recording.
    // -------------------------------------------------------
    const publicationRule = new events.Rule(this, 'RecordingCreatedRule', {
      ruleName: 'VirtualMeetup-RecordingCreated',
      description: 'Triggers Publisher Lambda when a metadata.json file is created in the recordings bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [recordingBucket.bucketName],
          },
          object: {
            key: [{ suffix: 'metadata.json' }],
          },
        },
      },
    });

    publicationRule.addTarget(new targets.LambdaFunction(publisherFunction, {
      deadLetterQueue: publicationDlq,
      maxEventAge: Duration.hours(2),
      retryAttempts: 3,
    }));

    // -------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'PublisherFunctionArn', {
      value: publisherFunction.functionArn,
      description: 'ARN of the Publisher Lambda function',
      exportName: 'PublisherFunctionArn',
    });

    new CfnOutput(this, 'PublicationDLQUrl', {
      value: publicationDlq.queueUrl,
      description: 'URL of the Publication Dead Letter Queue',
      exportName: 'PublicationDLQUrl',
    });

    // Expose references for cross-stack use
    this.publisherFunction = publisherFunction;
    this.publicationDlq = publicationDlq;
    this.githubTokenSecret = githubTokenSecret;
  }
}

module.exports = { PublicationStack };

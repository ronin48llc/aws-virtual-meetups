const path = require('path');
const { Stack, CfnOutput, RemovalPolicy, Duration } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const iam = require('aws-cdk-lib/aws-iam');
const lambda = require('aws-cdk-lib/aws-lambda');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');

class StreamingStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Recording retention: operators can override via cdk context
    // (`recordingsRetentionDays`) in cdk.context.json. Default is 3 years —
    // conservative for AWS user-group meetup archives. Lifecycle changes
    // apply to existing objects on next S3 daily evaluation, so bumping
    // this DOWN on a deployed account will queue older recordings for
    // deletion within ~24h. Set higher before deploying if existing
    // content predates the chosen retention.
    const retentionDays = this.node.tryGetContext('recordingsRetentionDays') ?? 1095;

    // Server access logs target bucket for the recording bucket. Kept
    // separate (S3 requires the log target bucket be different from the
    // source) and RETAIN'd on destroy so forensic logs survive a stack
    // teardown. Capped at 365 days so the bucket doesn't grow unbounded.
    // See issue #52.
    const recordingAccessLogsBucket = new s3.Bucket(this, 'RecordingAccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireAccessLogs',
          enabled: true,
          expiration: Duration.days(365),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // S3 bucket for IVS recordings with lifecycle rules.
    // Issue #115: eventBridgeEnabled is required for the PublicationStack's
    // EventBridge Rule (RecordingCreatedRule) to fire. Without it S3 does
    // NOT publish Object Created events to EventBridge — the publisher
    // Lambda never gets invoked, recordings sit in S3 forever, no Jekyll
    // post gets committed, no recap email goes out. The publication-stack
    // file's comment "The recording bucket must have EventBridge
    // notifications enabled" was an assumption that was never enforced.
    const recordingBucket = new s3.Bucket(this, 'RecordingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: recordingAccessLogsBucket,
      serverAccessLogsPrefix: 'recordings/',
      eventBridgeEnabled: true,
      lifecycleRules: [
        {
          id: 'IntelligentTiering',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(90),
            },
          ],
          // Cap current-version retention so Glacier storage doesn't grow
          // forever. Operators override via cdk context recordingsRetentionDays.
          expiration: Duration.days(retentionDays),
          // versioned: true means every overwrite (HLS manifest churn during
          // a live session) creates a noncurrent version. Without this, those
          // sit in Standard storage forever — typically a bigger leak than
          // the recordings themselves.
          noncurrentVersionExpiration: Duration.days(30),
          // Abort any IVS Composition multipart upload that didn't finish
          // (failed composition, network drop). Otherwise the fragments are
          // invisible in the console and bill silently.
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // IAM role for IVS Composition to write recordings to S3
    const ivsCompositionRole = new iam.Role(this, 'IvsCompositionRole', {
      assumedBy: new iam.ServicePrincipal('ivs.amazonaws.com'),
      description: 'Role for IVS Server-Side Composition to write recordings to S3',
    });

    recordingBucket.grantReadWrite(ivsCompositionRole);

    // CloudFront Origin Access Identity for the recording bucket
    const recordingOAI = new cloudfront.OriginAccessIdentity(this, 'RecordingOAI', {
      comment: 'OAI for Virtual Meetup Platform recording bucket',
    });

    recordingBucket.grantRead(recordingOAI);

    // CloudFront access logs target for the recording distribution.
    // Separate bucket from the S3 server-access logs (#52), retained on
    // teardown, OBJECT_WRITER (CloudFront requires it), 365-day expiry.
    // See issue #58.
    const recordingDistributionAccessLogsBucket = new s3.Bucket(this, 'RecordingDistributionAccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [
        {
          id: 'ExpireRecordingDistributionAccessLogs',
          enabled: true,
          expiration: Duration.days(365),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // CloudFront distribution for serving recordings via HTTPS with CORS
    const distributionProps = {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(recordingBucket, {
          originAccessIdentity: recordingOAI,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: recordingDistributionAccessLogsBucket,
      logFilePrefix: 'recording-cf/',
    };

    // Add custom domain if hostedZone and certificate are provided
    if (props.hostedZone && props.certificate && props.domainName) {
      const recordingDomain = `recordings.${props.domainName}`;
      distributionProps.domainNames = [recordingDomain];
      distributionProps.certificate = props.certificate;
    }

    const recordingDistribution = new cloudfront.Distribution(this, 'RecordingDistribution', distributionProps);

    // Create Route53 alias record for recordings subdomain
    if (props.hostedZone && props.certificate && props.domainName) {
      const route53 = require('aws-cdk-lib/aws-route53');
      const targets = require('aws-cdk-lib/aws-route53-targets');
      const recordingDomain = `recordings.${props.domainName}`;
      new route53.ARecord(this, 'RecordingAliasRecord', {
        zone: props.hostedZone,
        recordName: recordingDomain,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(recordingDistribution)),
      });
    }

    // IVS Storage Configuration — links the S3 bucket for composition recording
    // Note: StorageConfiguration is not yet available as an L2 CDK construct,
    // so we use CfnResource or create it manually via CLI/console.
    // The ARN will be passed as an environment variable to the session-manager Lambda.
    // For now, export the bucket name so it can be configured.

    // IAM policy for Lambda functions to manage IVS stages and chat rooms
    const ivsManagementPolicy = new iam.ManagedPolicy(this, 'IvsManagementPolicy', {
      description: 'Policy granting Lambda functions permissions to manage IVS stages and chat rooms',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'ivs:CreateStage',
            'ivs:DeleteStage',
            'ivs:GetStage',
            'ivs:ListStages',
            'ivs:CreateParticipantToken',
            'ivs:StartComposition',
            'ivs:StopComposition',
            'ivs:GetComposition',
            'ivs:ListCompositions',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'ivschat:CreateRoom',
            'ivschat:DeleteRoom',
            'ivschat:GetRoom',
            'ivschat:ListRooms',
            'ivschat:CreateChatToken',
            'ivschat:SendEvent',
            'ivschat:DisconnectUser',
          ],
          resources: ['*'],
        }),
      ],
    });

    // -------------------------------------------------------
    // Chat Review Lambda (Issue #101)
    //
    // The chat-review handler enforces length, base64, and URL-blocklist
    // moderation rules on every IVS Chat message. Before #101 the source
    // existed but no CDK code deployed it and no chat room referenced it
    // as a messageReviewHandler — live meetups shipped with zero moderation.
    //
    // The blocklist is sourced from CDK context (-c urlBlocklist=...) with
    // a conservative default targeting common phishing/file-share domains.
    // -------------------------------------------------------
    const urlBlocklist = this.node.tryGetContext('urlBlocklist')
      || 'drive.google.com,dropbox.com,wetransfer.com,mega.nz';

    const chatReviewFunction = new lambda.Function(this, 'ChatReviewFunction', {
      functionName: 'VirtualMeetup-ChatReview',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/chat-review/')),
      timeout: Duration.seconds(5),
      memorySize: 128,
      environment: {
        URL_BLOCKLIST: urlBlocklist,
      },
    });

    // IVS Chat must be able to invoke the review handler for every message.
    // Without this resource-based permission, CreateRoom with
    // messageReviewHandler fails synchronously.
    chatReviewFunction.addPermission('AllowIvsChatInvoke', {
      principal: new iam.ServicePrincipal('ivschat.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    // CloudFormation outputs
    new CfnOutput(this, 'ChatReviewFunctionArn', {
      value: chatReviewFunction.functionArn,
      description: 'ARN of the IVS Chat message-review Lambda',
      exportName: 'ChatReviewFunctionArn',
    });

    new CfnOutput(this, 'RecordingBucketName', {
      value: recordingBucket.bucketName,
      description: 'S3 bucket name for IVS recordings',
      exportName: 'RecordingBucketName',
    });

    new CfnOutput(this, 'RecordingBucketArn', {
      value: recordingBucket.bucketArn,
      description: 'S3 bucket ARN for IVS recordings',
      exportName: 'RecordingBucketArn',
    });

    new CfnOutput(this, 'IvsCompositionRoleArn', {
      value: ivsCompositionRole.roleArn,
      description: 'IAM role ARN for IVS Composition to write to S3',
      exportName: 'IvsCompositionRoleArn',
    });

    new CfnOutput(this, 'RecordingDistributionDomain', {
      value: recordingDistribution.distributionDomainName,
      description: 'CloudFront distribution domain for recording playback',
      exportName: 'RecordingDistributionDomain',
    });

    // Expose references for cross-stack use
    this.recordingBucket = recordingBucket;
    this.ivsCompositionRole = ivsCompositionRole;
    this.ivsManagementPolicy = ivsManagementPolicy;
    this.recordingDistribution = recordingDistribution;
    this.chatReviewFunction = chatReviewFunction;
  }
}

module.exports = { StreamingStack };

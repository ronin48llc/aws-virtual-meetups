const { Stack, CfnOutput, RemovalPolicy, Duration } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const iam = require('aws-cdk-lib/aws-iam');
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

    // S3 bucket for IVS recordings with lifecycle rules
    const recordingBucket = new s3.Bucket(this, 'RecordingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: recordingAccessLogsBucket,
      serverAccessLogsPrefix: 'recordings/',
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
    const recordingDistribution = new cloudfront.Distribution(this, 'RecordingDistribution', {
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
    });

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

    // CloudFormation outputs
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
  }
}

module.exports = { StreamingStack };

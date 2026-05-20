#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { AuthStack } = require('../lib/auth-stack');
const { DataStack } = require('../lib/data-stack');
const { DnsStack } = require('../lib/dns-stack');
const { ApiStack } = require('../lib/api-stack');
const { StreamingStack } = require('../lib/streaming-stack');
const { TranscriptionStack } = require('../lib/transcription-stack');
const { FrontendStack } = require('../lib/frontend-stack');
const { PublicationStack } = require('../lib/publication-stack');
const { ObservabilityStack } = require('../lib/observability-stack');
const { EmailStack } = require('../lib/email-stack');

const app = new cdk.App();

// Environment configuration from CDK context or environment variables
const env = {
  account: app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Stack prefix for multi-environment support (e.g., dev, prod)
const envName = app.node.tryGetContext('env') || 'dev';
const prefix = `VirtualMeetup-${envName}`;

// Domain configuration from CDK context
const domainName = app.node.tryGetContext('domainName') || 'yourdomain.com';

// IVS ARNs from CDK context (Fix #9 — parameterized, pass via -c flags)
const ivsStorageConfigArn = app.node.tryGetContext('ivsStorageConfigArn') || '';
const ivsEncoderConfigArn = app.node.tryGetContext('ivsEncoderConfigArn') || '';

// Cost Allocation Tags (Fix #8)
cdk.Tags.of(app).add('Project', 'VirtualMeetups');
cdk.Tags.of(app).add('Environment', envName);
cdk.Tags.of(app).add('ManagedBy', 'CDK');

// -------------------------------------------------------
// Stack 0: DNS (no dependencies)
// Route53 Hosted Zone + ACM Certificate for awsvirtualmeetups.com
// Requirements: 9.1, 9.2, 9.4
// -------------------------------------------------------
const dnsStack = new DnsStack(app, `${prefix}-Dns`, {
  env,
  description: 'Virtual Meetup Platform - DNS (Route53 Hosted Zone + ACM Certificate)',
});

// -------------------------------------------------------
// Stack 1: Authentication (no dependencies)
// Cognito User Pool, Identity Pool, Admin API
// -------------------------------------------------------
const authStack = new AuthStack(app, `${prefix}-Auth`, {
  env,
  description: 'Virtual Meetup Platform - Authentication (Cognito User Pool, Identity Pool)',
});

// -------------------------------------------------------
// Stack 2: Data (no dependencies)
// DynamoDB tables (main table + connections table)
// -------------------------------------------------------
const dataStack = new DataStack(app, `${prefix}-Data`, {
  env,
  description: 'Virtual Meetup Platform - Data Layer (DynamoDB tables)',
});

// -------------------------------------------------------
// Stack 4: Streaming (no dependencies)
// S3 recording bucket, IVS composition role, IVS management policy
// -------------------------------------------------------
const streamingStack = new StreamingStack(app, `${prefix}-Streaming`, {
  env,
  description: 'Virtual Meetup Platform - Streaming (IVS recording bucket, composition role)',
});

// -------------------------------------------------------
// Stack 5: Transcription (depends on Data for event-ownership lookup)
// Transcription Lambda with Transcribe + Translate permissions
// -------------------------------------------------------
const transcriptionStack = new TranscriptionStack(app, `${prefix}-Transcription`, {
  env,
  description: 'Virtual Meetup Platform - Transcription (Amazon Transcribe + Translate)',
  mainTable: dataStack.mainTable,
});
transcriptionStack.addDependency(dataStack);

// -------------------------------------------------------
// Stack 6: Frontend (depends on DNS)
// S3 bucket + CloudFront distribution for SPA hosting
// Requirements: 9.2, 9.4
// -------------------------------------------------------
const frontendStack = new FrontendStack(app, `${prefix}-Frontend`, {
  env,
  description: 'Virtual Meetup Platform - Frontend (S3 + CloudFront SPA hosting)',
  hostedZone: dnsStack.hostedZone,
  certificate: dnsStack.certificate,
  domainNames: [domainName, `www.${domainName}`],
});
frontendStack.addDependency(dnsStack);

// -------------------------------------------------------
// Stack 7: Email Notifications (depends on Data + Frontend + DNS)
// Email Sender Lambda, SES identity, EventBridge Scheduler, DLQ
// Requirements: 9.2, 9.4, 9.5
// -------------------------------------------------------
const emailStack = new EmailStack(app, `${prefix}-Email`, {
  env,
  description: 'Virtual Meetup Platform - Email Notifications (SES, Scheduler, Email Lambda)',
  tableName: dataStack.mainTable.tableName,
  tableArn: dataStack.mainTable.tableArn,
  frontendUrl: `https://${frontendStack.distribution.distributionDomainName}`,
  hostedZone: dnsStack.hostedZone,
});
emailStack.addDependency(dataStack);
emailStack.addDependency(frontendStack);
emailStack.addDependency(dnsStack);

// -------------------------------------------------------
// Stack 3: API (depends on Auth + Data + Email + DNS)
// HTTP API, WebSocket API, Lambda functions
// Requirements: 9.2, 9.4
// -------------------------------------------------------
const apiStack = new ApiStack(app, `${prefix}-Api`, {
  env,
  description: 'Virtual Meetup Platform - API Layer (HTTP + WebSocket APIs)',
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  mainTable: dataStack.mainTable,
  connectionsTable: dataStack.connectionsTable,
  emailSenderFunction: emailStack.emailSenderFunction,
  schedulerRole: emailStack.schedulerRole,
  hostedZone: dnsStack.hostedZone,
  certificate: dnsStack.certificate,
  domainName: domainName,
  ivsCompositionRoleArn: streamingStack.ivsCompositionRole.roleArn,
  ivsStorageConfigArn: ivsStorageConfigArn,
  ivsEncoderConfigArn: ivsEncoderConfigArn,
  recordingBucketName: streamingStack.recordingBucket.bucketName,
  recordingCloudfrontDomain: streamingStack.recordingDistribution.distributionDomainName,
  transcriptionFunction: transcriptionStack.transcriptionFunction,
});
apiStack.addDependency(authStack);
apiStack.addDependency(dataStack);
apiStack.addDependency(emailStack);
apiStack.addDependency(dnsStack);
apiStack.addDependency(streamingStack);
apiStack.addDependency(transcriptionStack);

// -------------------------------------------------------
// Stack 8: Publication (depends on Streaming + Email)
// EventBridge rule, Publisher Lambda, GitHub Pages integration
// -------------------------------------------------------
const publicationStack = new PublicationStack(app, `${prefix}-Publication`, {
  env,
  description: 'Virtual Meetup Platform - Publication (recording to GitHub Pages)',
  recordingBucket: streamingStack.recordingBucket,
  emailSenderFunction: emailStack.emailSenderFunction,
  recordingCloudfrontDomain: streamingStack.recordingDistribution.distributionDomainName,
});
publicationStack.addDependency(streamingStack);
publicationStack.addDependency(emailStack);

// -------------------------------------------------------
// Stack 9: Observability (depends on API + Data)
// CloudWatch dashboard, alarms, SNS, log retention, IVS metrics
// -------------------------------------------------------
const observabilityStack = new ObservabilityStack(app, `${prefix}-Observability`, {
  env,
  description: 'Virtual Meetup Platform - Observability (Dashboard, Alarms, Metrics)',
  httpApi: apiStack.httpApi,
  webSocketApi: apiStack.webSocketApi,
  mainTable: dataStack.mainTable,
  connectionsTable: dataStack.connectionsTable,
  publicationDlq: publicationStack.publicationDlq,
  emailDlq: emailStack.emailDlq,
});
observabilityStack.addDependency(apiStack);
observabilityStack.addDependency(dataStack);
observabilityStack.addDependency(publicationStack);
observabilityStack.addDependency(emailStack);

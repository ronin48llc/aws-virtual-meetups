'use strict';

// Tests focused on the recording bucket lifecycle (issue #26). Guards
// against regression of expiration, noncurrent-version expiration, and
// abort-incomplete-multipart settings — three cost leaks closed in this
// PR that would otherwise silently grow.

const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { StreamingStack } = require('../../lib/streaming-stack');

function synth(contextOverrides = {}) {
  const app = new App({ context: contextOverrides });
  const stack = new StreamingStack(app, 'TestStreamingStack');
  return Template.fromStack(stack);
}

describe('StreamingStack recording bucket lifecycle (issue #26)', () => {
  test('recording bucket exists with versioning enabled', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('lifecycle rule includes the existing IA + Glacier transitions', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'IntelligentTiering',
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'STANDARD_IA', TransitionInDays: 30 }),
              Match.objectLike({ StorageClass: 'GLACIER', TransitionInDays: 90 }),
            ]),
          }),
        ]),
      },
    });
  });

  test('lifecycle rule sets ExpirationInDays to the default 1095 days (3 years)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'IntelligentTiering', ExpirationInDays: 1095 }),
        ]),
      },
    });
  });

  test('lifecycle rule honors recordingsRetentionDays context override', () => {
    const template = synth({ recordingsRetentionDays: 30 });
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'IntelligentTiering', ExpirationInDays: 30 }),
        ]),
      },
    });
  });

  test('lifecycle rule expires noncurrent versions after 30 days', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'IntelligentTiering',
            NoncurrentVersionExpiration: Match.objectLike({ NoncurrentDays: 30 }),
          }),
        ]),
      },
    });
  });

  test('lifecycle rule aborts incomplete multipart uploads after 7 days', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'IntelligentTiering',
            AbortIncompleteMultipartUpload: Match.objectLike({ DaysAfterInitiation: 7 }),
          }),
        ]),
      },
    });
  });
});

describe('StreamingStack — chat-review Lambda wiring (#101)', () => {
  let template;

  beforeAll(() => {
    const app = new App();
    const stack = new StreamingStack(app, 'TestStreamingStack');
    template = Template.fromStack(stack);
  });

  test('creates ChatReviewFunction with NODEJS_20_X runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-ChatReview',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
    });
  });

  test('ChatReviewFunction has URL_BLOCKLIST env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-ChatReview',
      Environment: {
        Variables: Match.objectLike({
          URL_BLOCKLIST: Match.stringLikeRegexp('drive.google.com|dropbox|wetransfer|mega'),
        }),
      },
    });
  });

  test('grants ivschat.amazonaws.com permission to invoke ChatReviewFunction', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'ivschat.amazonaws.com',
    });
  });

  test('exports ChatReviewFunctionArn for cross-stack use', () => {
    template.hasOutput('ChatReviewFunctionArn', {
      Export: { Name: 'ChatReviewFunctionArn' },
    });
  });

  test('URL_BLOCKLIST default includes common phishing/file-share targets', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-ChatReview',
      Environment: {
        Variables: {
          URL_BLOCKLIST: 'drive.google.com,dropbox.com,wetransfer.com,mega.nz',
        },
      },
    });
  });
});

describe('StreamingStack — chat-review URL_BLOCKLIST is configurable via context (#101)', () => {
  test('overrides URL_BLOCKLIST when -c urlBlocklist=... is passed', () => {
    const app = new App({
      context: { urlBlocklist: 'evil.example.com,phishing.test' },
    });
    const stack = new StreamingStack(app, 'TestStreamingCtxStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-ChatReview',
      Environment: {
        Variables: {
          URL_BLOCKLIST: 'evil.example.com,phishing.test',
        },
      },
    });
  });
});

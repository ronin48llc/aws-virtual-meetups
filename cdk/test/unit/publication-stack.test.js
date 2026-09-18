'use strict';

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const s3 = require('aws-cdk-lib/aws-s3');
const { PublicationStack } = require('../../lib/publication-stack');

// Issue #107: the publisher Lambda builds the recording playback URL as
// `https://${CLOUDFRONT_DOMAIN}/recordings/...`. The PublicationStack
// must surface a `recordingCloudfrontDomain` prop and pipe it into the
// CLOUDFRONT_DOMAIN env var so the URL is valid. The previous default
// of '' produced `https:///recordings/...` — broken on every recording.

function buildParentWithBucket() {
  const app = new App();
  const parent = new Stack(app, 'TestParent', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const recordingBucket = new s3.Bucket(parent, 'TestRecordingBucket');
  return { app, parent, recordingBucket };
}

describe('PublicationStack — publish target repo context (publishOwner/publishRepo)', () => {
  test('defaults GITHUB_OWNER/GITHUB_REPO to the original target when no context is set', () => {
    const { app, recordingBucket } = buildParentWithBucket();
    const stack = new PublicationStack(app, 'TestPubDefaults', {
      env: { account: '123456789012', region: 'us-east-1' },
      recordingBucket,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-Publisher-dev',
      Environment: {
        Variables: Match.objectLike({
          GITHUB_OWNER: 'aws-community',
          GITHUB_REPO: 'aws-community-meetup-recordings',
        }),
      },
    });
  });

  test('publishOwner/publishRepo context flags override the Lambda env vars', () => {
    // Switching the publication target must be a context change
    // (-c publishOwner=... -c publishRepo=...), not a code edit.
    const app = new App({
      context: {
        publishOwner: 'ronin48llc',
        publishRepo: 'meetup-recordings-archive',
      },
    });
    const parent = new Stack(app, 'TestParent', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const recordingBucket = new s3.Bucket(parent, 'TestRecordingBucket');
    const stack = new PublicationStack(app, 'TestPubOverride', {
      env: { account: '123456789012', region: 'us-east-1' },
      recordingBucket,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-Publisher-dev',
      Environment: {
        Variables: Match.objectLike({
          GITHUB_OWNER: 'ronin48llc',
          GITHUB_REPO: 'meetup-recordings-archive',
        }),
      },
    });
  });
});

describe('PublicationStack — CLOUDFRONT_DOMAIN wiring (#107)', () => {
  test('passes recordingCloudfrontDomain into CLOUDFRONT_DOMAIN env var', () => {
    const { app, recordingBucket } = buildParentWithBucket();
    const stack = new PublicationStack(app, 'TestPubA', {
      env: { account: '123456789012', region: 'us-east-1' },
      recordingBucket,
      recordingCloudfrontDomain: 'd1234abcdef.cloudfront.net',
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-Publisher-dev',
      Environment: {
        Variables: Match.objectLike({
          CLOUDFRONT_DOMAIN: 'd1234abcdef.cloudfront.net',
        }),
      },
    });
  });

  test('emits an empty CLOUDFRONT_DOMAIN when no domain is passed (back-compat)', () => {
    // Stacks that test PublicationStack in isolation, or staging deploys
    // that don't have a CloudFront distribution yet, should still synth.
    const { app, recordingBucket } = buildParentWithBucket();
    const stack = new PublicationStack(app, 'TestPubB', {
      env: { account: '123456789012', region: 'us-east-1' },
      recordingBucket,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'VirtualMeetup-Publisher-dev',
      Environment: {
        Variables: Match.objectLike({
          CLOUDFRONT_DOMAIN: '',
        }),
      },
    });
  });
});

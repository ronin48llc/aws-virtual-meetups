'use strict';

// Tests for issue #30: every lambda.Function across the project sets
// logRetention via the canonical CDK custom resource. We synthesize a
// few of the easier-to-mock stacks and assert each emits a
// Custom::LogRetention with RetentionInDays = 30. ApiStack is heavyweight
// to mock (Cognito + DDB + SES + Scheduler + Route53), so it's verified
// here by a focused regex on the source rather than full synth.

const fs = require('fs');
const path = require('path');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { EmailStack } = require('../../lib/email-stack');
const { TranscriptionStack } = require('../../lib/transcription-stack');

const EXPECTED_RETENTION_DAYS = 30;

describe('Lambda log retention (issue #30)', () => {
  describe('synthesized stacks emit Custom::LogRetention with 30 days', () => {
    test('EmailStack emits one Custom::LogRetention at 30 days', () => {
      const app = new App();
      const stack = new EmailStack(app, 'TestEmailStack', {
        tableName: 'VirtualMeetupTable',
        tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/VirtualMeetupTable',
        frontendUrl: 'https://example.com',
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('Custom::LogRetention', 1);
      template.hasResourceProperties('Custom::LogRetention', {
        RetentionInDays: EXPECTED_RETENTION_DAYS,
      });
    });

    test('TranscriptionStack emits one Custom::LogRetention at 30 days', () => {
      const app = new App();
      const stack = new TranscriptionStack(app, 'TestTranscriptionStack');
      const template = Template.fromStack(stack);
      template.resourceCountIs('Custom::LogRetention', 1);
      template.hasResourceProperties('Custom::LogRetention', {
        RetentionInDays: EXPECTED_RETENTION_DAYS,
      });
    });
  });

  describe('source-level guard for harder-to-synth stacks', () => {
    // For ApiStack, AuthStack, PublicationStack, and ObservabilityStack
    // we don't want to wire up the full dependency graph just to verify
    // the prop is present. Instead, assert every `new lambda.Function`
    // in those files has a `logRetention:` line within the same block.
    const stacksToScan = [
      'api-stack.js',
      'auth-stack.js',
      'publication-stack.js',
      'observability-stack.js',
    ];

    for (const stackFile of stacksToScan) {
      test(`${stackFile} — every lambda.Function block contains logRetention`, () => {
        const src = fs.readFileSync(
          path.resolve(__dirname, '../../lib', stackFile),
          'utf8',
        );

        // Split on `new lambda.Function(` so each chunk after the first
        // is a Function instantiation. The block ends at the matching
        // closing `});` — we scan up to 60 lines ahead, which is more
        // than enough for any function block in this codebase.
        const chunks = src.split('new lambda.Function(');
        expect(chunks.length).toBeGreaterThan(1); // at least one Function declared

        for (let i = 1; i < chunks.length; i++) {
          const upToClose = chunks[i].split('});')[0];
          expect(upToClose).toMatch(/logRetention\s*:\s*logs\.RetentionDays\./);
        }
      });
    }
  });

  test('observability-stack no longer declares brittle pre-created LogGroups for Lambda function log groups', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../lib/observability-stack.js'),
      'utf8',
    );
    // The old pattern created `new logs.LogGroup` with `logGroupName:
    // '/aws/lambda/${fnName}'`. After the fix none of the LogGroup
    // construct invocations should target a /aws/lambda/ name. (The
    // string still appears as a literal in Logs Insights query
    // definitions referencing those log groups — that's fine, it's a
    // string reference, not a CFN-owned resource.)
    const logGroupCtorRegex = /new logs\.LogGroup\([\s\S]*?logGroupName:[\s\S]*?['"`]\/aws\/lambda\//g;
    expect(src).not.toMatch(logGroupCtorRegex);
  });
});

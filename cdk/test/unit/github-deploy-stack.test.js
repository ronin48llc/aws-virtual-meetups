'use strict';

const { App, Stack } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const s3 = require('aws-cdk-lib/aws-s3');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const { GitHubDeployStack } = require('../../lib/github-deploy-stack');

// GitHubDeployStack holds the account's GitHub Actions OIDC provider and the
// deploy role deploy.yml assumes. The trust policy is the security boundary:
// only ronin48llc/aws-virtual-meetups, and ONLY the `production` GitHub
// Environment subject. A ref subject (refs/heads/main) must never be
// trusted: GitHub runs delete-event workflows in default-branch context, so
// a ref subject hands the deploy role to ANY workflow in the repo — the
// since-removed destroy-on-branch-delete workflow actually obtained
// credentials that way before the trust was tightened.

const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

const EXPECTED_SUBS = [
  'repo:ronin48llc/aws-virtual-meetups:environment:production',
];

function buildTemplate() {
  const app = new App();
  const parent = new Stack(app, 'TestParent', { env: TEST_ENV });
  const frontendBucket = new s3.Bucket(parent, 'TestFrontendBucket');
  const distribution = new cloudfront.Distribution(parent, 'TestDistribution', {
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
    },
  });
  const stack = new GitHubDeployStack(app, 'TestGitHubDeploy', {
    env: TEST_ENV,
    frontendBucket,
    distribution,
  });
  return Template.fromStack(stack);
}

describe('GitHubDeployStack — GitHub Actions OIDC deploy role', () => {
  test('creates the GitHub OIDC provider for token.actions.githubusercontent.com', () => {
    const template = buildTemplate();
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com'],
    });
  });

  test('deploy role trusts EXACTLY the production environment and main branch subjects', () => {
    const template = buildTemplate();
    const roles = template.findResources('AWS::IAM::Role');
    const deployRole = Object.values(roles).find(
      (r) => r.Properties.RoleName === 'GitHubActionsDeployRole-dev'
    );
    expect(deployRole).toBeDefined();

    const statements = deployRole.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
    // Exact deep-equality: no extra condition keys, no extra or wildcard-only
    // sub entries can sneak in.
    expect(statements[0].Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': EXPECTED_SUBS,
      },
    });
    EXPECTED_SUBS.forEach((sub) => expect(sub).not.toContain('*'));
    // Regression guard: a ref subject must never come back (delete-event
    // workflows run in default-branch context and would inherit the role).
    expect(JSON.stringify(statements[0].Condition)).not.toContain('refs/heads');
  });

  test('deploy role can assume the CDK bootstrap roles (qualifier hnb659fds)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource:
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-*-role-123456789012-us-east-1',
          }),
        ]),
      }),
    });
  });

  test('deploy role covers the direct calls deploy.yml makes outside cdk', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'cloudformation:DescribeStacks',
            Resource:
              'arn:aws:cloudformation:us-east-1:123456789012:stack/VirtualMeetup-dev-*/*',
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
          }),
        ]),
      }),
    });
  });
});

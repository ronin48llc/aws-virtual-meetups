const { Stack, CfnOutput } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const { withEnv, envName } = require('./env-config');

/**
 * GitHub Deploy stack for the Virtual Meetup Platform.
 *
 * Creates the IAM OIDC identity provider for GitHub Actions
 * (token.actions.githubusercontent.com) — none exists in the account — and a
 * deploy role that .github/workflows/deploy.yml assumes via
 * aws-actions/configure-aws-credentials. The role ARN output is what goes in
 * the AWS_DEPLOY_ROLE_ARN repository secret.
 *
 * Trust is restricted to this repo's `production` GitHub Environment and to
 * pushes to refs/heads/main — no wildcard subjects, so a workflow on any
 * other repo, branch, or environment cannot assume the role.
 *
 * The role itself carries almost no direct power: `cdk deploy` works by
 * assuming the CDK bootstrap roles (cdk-hnb659fds-*), so the deploy role only
 * needs sts:AssumeRole on those, plus the handful of calls deploy.yml makes
 * directly outside cdk (describe-stacks for outputs, s3 sync of the frontend
 * bucket, CloudFront invalidation). The frontend bucket and distribution are
 * referenced via cross-stack props from FrontendStack (the repo's usual
 * wiring idiom) rather than a name pattern — exact ARNs, no wildcards.
 *
 * Note: the smoke-test job's best-effort `aws sns publish` to the alarm topic
 * is intentionally not granted here; the workflow already tolerates that call
 * failing (`|| echo ::warning::`).
 *
 * Props:
 * - frontendBucket: FrontendStack's SPA bucket (s3 sync target)
 * - distribution: FrontendStack's CloudFront distribution (invalidation target)
 */
class GitHubDeployStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // -------------------------------------------------------
    // GitHub Actions OIDC identity provider
    // One per account per URL — this account has none yet.
    // -------------------------------------------------------
    const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // -------------------------------------------------------
    // Deploy role assumed by deploy.yml via OIDC (no long-lived keys).
    // sub claims: deploys run from the `production` GitHub Environment on
    // refs/heads/main, so both subject formats are trusted — GitHub emits
    // `environment:` subjects for jobs bound to an Environment and `ref:`
    // subjects otherwise.
    // -------------------------------------------------------
    this.deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: withEnv(this, 'GitHubActionsDeployRole'),
      description: 'GitHub Actions OIDC deploy role for ronin48llc/aws-virtual-meetups (deploy.yml)',
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            'repo:ronin48llc/aws-virtual-meetups:environment:production',
            'repo:ronin48llc/aws-virtual-meetups:ref:refs/heads/main',
          ],
        },
      }),
    });

    // `cdk deploy` gets its power by assuming the CDK bootstrap roles
    // (deploy, file-publishing, image-publishing, lookup — qualifier
    // hnb659fds), not from the caller's own permissions.
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-role-${this.account}-${this.region}`,
      ],
    }));

    // deploy.yml reads stack outputs (Cognito IDs, bucket name, distribution
    // ID) with `aws cloudformation describe-stacks` on this env's stacks.
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [
        `arn:aws:cloudformation:${this.region}:${this.account}:stack/VirtualMeetup-${envName(this)}-*/*`,
      ],
    }));

    // `aws s3 sync frontend/ s3://$BUCKET --delete` against the SPA bucket.
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        props.frontendBucket.bucketArn,
        `${props.frontendBucket.bucketArn}/*`,
      ],
    }));

    // `aws cloudfront create-invalidation` after the sync. CloudFront ARNs
    // are global (empty region segment).
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [
        `arn:aws:cloudfront::${this.account}:distribution/${props.distribution.distributionId}`,
      ],
    }));

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'IAM role ARN for GitHub Actions deploys — set as the AWS_DEPLOY_ROLE_ARN repo secret',
    });
  }
}

module.exports = { GitHubDeployStack };

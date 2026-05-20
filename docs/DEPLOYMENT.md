# Deployment Guide

## Prerequisites

- **AWS Account** with administrator access
- **Node.js** 20.x or later
- **AWS CDK CLI** v2 (`npm install -g aws-cdk`)
- **AWS CLI** v2 configured with credentials
- **Domain** registered in Route53 (`awsvirtualmeetups.com`)
- **GitHub Personal Access Token** (for recording publication)

## First-Time Setup

### 1. Bootstrap CDK

CDK bootstrap provisions the resources CDK needs to deploy (S3 bucket for assets, IAM roles, etc.):

```bash
cd cdk
npm install
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 -c env=dev
```

### 2. Configure Environment

The platform uses CDK context for configuration. Set values in `cdk.context.json` or pass via `-c` flags:

```json
{
  "account": "123456789012",
  "region": "us-east-1",
  "env": "dev",
  "domainName": "yourdomain.com",
  "hostedZoneId": "YOUR_HOSTED_ZONE_ID",
  "ivsStorageConfigArn": "arn:aws:ivs:us-east-1:123456789012:storage-configuration/xxxxx",
  "ivsEncoderConfigArn": "arn:aws:ivs:us-east-1:123456789012:encoder-configuration/xxxxx",
  "alarmEmails": ["ops@example.com"]
}
```

Environment variables used by the frontend are hardcoded in `frontend/js/config.js`
(moved out of `index.html` so the CloudFront CSP can disallow inline scripts):

| Variable | Description |
|----------|-------------|
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID (from Auth stack output) |
| `COGNITO_CLIENT_ID` | Cognito App Client ID (from Auth stack output) |
| `API_BASE_URL` | HTTP API endpoint (e.g., `https://api.yourdomain.com`) |
| `WS_BASE_URL` | WebSocket endpoint (e.g., `wss://ws.yourdomain.com`) |

## Deployment Sequence

The platform consists of 10 CDK stacks with dependencies. Deploy in this order:

### Step 1: Deploy DNS Stack (first, must wait for certificate validation)

```bash
npx cdk deploy VirtualMeetup-dev-Dns -c env=dev
```

The ACM certificate requires DNS validation. CDK automatically creates the CNAME validation records in Route53, but propagation can take 5–30 minutes. Wait until the certificate status shows `ISSUED` in the AWS Console before proceeding.

```bash
aws acm list-certificates --query "CertificateSummaryList[?DomainName=='awsvirtualmeetups.com'].Status"
```

### Step 2: Deploy All Remaining Stacks

Once the certificate is issued, deploy everything:

```bash
npx cdk deploy --all -c env=dev --require-approval never
```

CDK respects the dependency graph automatically:
1. `DnsStack` — Route53 hosted zone + ACM certificate
2. `AuthStack` — Cognito User Pool + Identity Pool
3. `DataStack` — DynamoDB tables
4. `StreamingStack` — S3 recording bucket + IVS composition role
5. `TranscriptionStack` — Transcription Lambda
6. `FrontendStack` — S3 + CloudFront (depends on DNS)
7. `EmailStack` — SES + EventBridge Scheduler (depends on Data, Frontend, DNS)
8. `ApiStack` — HTTP + WebSocket APIs (depends on Auth, Data, Email, DNS, Streaming)
9. `PublicationStack` — Recording publisher (depends on Streaming, Email)
10. `ObservabilityStack` — Dashboard + Alarms (depends on API, Data)

## Manual Steps (Post-Deployment)

### IVS StorageConfiguration

IVS StorageConfiguration is not available as a CDK L2 construct. Create it via CLI:

```bash
aws ivs create-storage-configuration \
  --name "VirtualMeetup-Recordings" \
  --s3 bucketName=<RECORDING_BUCKET_NAME>
```

Note the ARN from the output — update `ivsStorageConfigArn` in `cdk/bin/app.js`.

### IVS EncoderConfiguration

Create an encoder configuration for HD recording composition:

```bash
aws ivs create-encoder-configuration \
  --name "VirtualMeetup-HD" \
  --video bitrate=3500000,framerate=30,height=720,width=1280
```

Note the ARN — update `ivsEncoderConfigArn` in `cdk/bin/app.js`.

### GitHub Token for Publication

Store your GitHub PAT in Secrets Manager:

```bash
aws secretsmanager put-secret-value \
  --secret-id VirtualMeetup/GitHubToken \
  --secret-string '{"token":"ghp_YOUR_TOKEN_HERE"}'
```

## Frontend Deployment

The frontend is a static SPA. Deploy to S3 and invalidate CloudFront:

```bash
# Get bucket name from stack output
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name VirtualMeetup-dev-Frontend \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
  --output text)

DISTRIBUTION_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[?Id=='S3Origin']].Id" \
  --output text)

# Sync frontend files
aws s3 sync frontend/ s3://$BUCKET/ --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id $DISTRIBUTION_ID \
  --paths "/*"
```

## SES Configuration

### Sandbox Mode (Development)

By default, SES is in sandbox mode. You can only send to verified email addresses. Verify recipient addresses:

```bash
aws ses verify-email-identity --email-address recipient@example.com
```

### Production Mode

To send to any address, request production access:

1. Go to AWS Console → SES → Account dashboard
2. Click "Request production access"
3. Provide use case details (transactional event notifications)

The platform uses domain identity verification (DKIM) via the `EmailStack`. When `hostedZone` is provided, SES automatically creates DKIM DNS records in Route53.

Sender address: `noreply@awsvirtualmeetups.com`

## Cognito User Pool Setup

### Seed Admin User

Run the seed script to create the initial organizer account:

```bash
./scripts/seed-admin.sh
```

This creates a user with:
- Role: `organizer`
- Email verified: `true`
- Password set permanently (skips force-change state)

### Manual User Creation

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username user@example.com \
  --user-attributes \
    Name=email,Value=user@example.com \
    Name=email_verified,Value=true \
    Name=custom:role,Value=organizer \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id <USER_POOL_ID> \
  --username user@example.com \
  --password "PermanentPass123!" \
  --permanent
```

## CI/CD (GitHub Actions)

The `.github/workflows/deploy.yml` workflow handles automated deployment:

- **Trigger**: Push to `main` (prod) or `develop` (dev)
- **Steps**: Test → CDK Synth → CDK Deploy → Smoke Tests
- **Auth**: OIDC federation with `AWS_DEPLOY_ROLE_ARN` secret

Required GitHub Secrets:
| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | IAM role ARN for OIDC deployment |
| `AWS_REGION` | Target region (default: `us-east-1`) |
| `SMOKE_TEST_USERNAME` | Test user email for smoke tests |
| `SMOKE_TEST_PASSWORD` | Test user password for smoke tests |

## Troubleshooting

### Certificate Stuck in PENDING_VALIDATION

- Verify the hosted zone ID matches your domain's NS records
- Check that CNAME validation records exist in Route53
- DNS propagation can take up to 30 minutes

### CloudFront 403 Errors

- Ensure the S3 bucket policy grants read to the OAI
- Check that `index.html` exists in the bucket root
- Verify the CloudFront error pages redirect 403/404 → `/index.html`

### WebSocket Connection Failures

- Confirm the WebSocket stage is deployed (`prod` stage)
- Check that the `$connect` Lambda has DynamoDB permissions
- Verify CORS/origin settings if connecting from a custom domain

### IVS Composition Fails to Start

- Verify `ivsStorageConfigArn` and `ivsEncoderConfigArn` are correct
- Ensure the IVS composition role has `s3:PutObject` on the recording bucket
- Check that the stage has at least one active publisher

### SES Emails Not Arriving

- In sandbox mode, verify both sender and recipient addresses
- Check the Email DLQ (`VirtualMeetup-EmailDLQ`) for failed invocations
- Verify DKIM records are present in Route53 (check SES console)

### Lambda Timeout on Session Start

- IVS `CreateStage` + `CreateParticipantToken` can take 2–5 seconds
- Session Manager Lambda timeout is 30 seconds — sufficient for normal operation
- If consistently timing out, check for DynamoDB throttling

### CDK Deploy Fails with "Resource already exists"

- This happens when re-deploying after a partial failure
- Use `--force` flag or manually delete the stuck resource
- For DynamoDB tables with `DESTROY` removal policy, delete manually if needed

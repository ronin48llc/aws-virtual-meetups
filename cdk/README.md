# Virtual Meetup Platform — CDK Deployment

Serverless AWS application for hosting live meetup sessions with real-time streaming, interactive chat, Q&A, transcription, and post-event recording publication.

## Prerequisites

- **Node.js** >= 18.x (LTS recommended)
- **AWS CLI** v2 configured with credentials (`aws configure`)
- **AWS CDK CLI** >= 2.150.0 (`npm install -g aws-cdk`)
- An AWS account with permissions to create IAM roles, Lambda functions, DynamoDB tables, S3 buckets, CloudFront distributions, Cognito user pools, API Gateway APIs, and WAF WebACLs

## Project Structure

```
cdk/
├── bin/
│   └── app.js              # CDK app entry point — wires all stacks
├── lib/
│   ├── auth-stack.js       # Cognito User Pool, Identity Pool, Admin API
│   ├── data-stack.js       # DynamoDB tables (main + connections)
│   ├── api-stack.js        # HTTP API, WebSocket API, Lambda functions
│   ├── streaming-stack.js  # S3 recording bucket, IVS composition role
│   ├── transcription-stack.js  # Transcription Lambda (Transcribe + Translate)
│   ├── frontend-stack.js   # S3 + CloudFront SPA hosting
│   ├── publication-stack.js    # EventBridge + Publisher Lambda + GitHub Pages
│   └── waf-construct.js    # Reusable WAF WebACL construct
├── lambda/                 # Lambda function source code
│   ├── admin-api/
│   ├── chat-review/
│   ├── event-crud/
│   ├── publisher/
│   ├── session-manager/
│   ├── shared/             # Shared utilities (validation, response, dynamo-utils)
│   ├── signup/
│   ├── token-generator/
│   ├── transcription/
│   └── websocket/
├── test/                   # Unit and property-based tests
├── cdk.json                # CDK configuration
└── package.json
```

## Stack Dependency Order

The stacks are deployed in the following order based on cross-stack references:

```
Auth ─────┐
           ├──→ API
Data ─────┘
Streaming ────→ Publication
Transcription   (independent)
Frontend        (independent)
```

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| **Auth** | Cognito User Pool, Identity Pool, Admin API Lambda | None |
| **Data** | DynamoDB main table + WebSocket connections table | None |
| **API** | HTTP API (REST), WebSocket API, all route Lambdas, WAF | Auth, Data |
| **Streaming** | S3 recording bucket, IVS composition role | None |
| **Transcription** | Transcription Lambda with Transcribe/Translate permissions | None |
| **Frontend** | S3 bucket + CloudFront distribution for SPA, WAF | None |
| **Publication** | EventBridge rule, Publisher Lambda, DLQ, GitHub token secret | Streaming |

## Environment Setup

### AWS Credentials

Ensure your AWS credentials are configured:

```bash
aws configure
# Or use environment variables:
export AWS_ACCESS_KEY_ID=<your-access-key>
export AWS_SECRET_ACCESS_KEY=<your-secret-key>
export AWS_DEFAULT_REGION=us-east-1
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CDK_DEFAULT_ACCOUNT` | AWS account ID for deployment | From `aws configure` |
| `CDK_DEFAULT_REGION` | AWS region for deployment | `us-east-1` |

### CDK Context Variables

Pass context at deploy time with `-c key=value`:

| Context Key | Description | Default |
|-------------|-------------|---------|
| `account` | Override AWS account ID | `CDK_DEFAULT_ACCOUNT` |
| `region` | Override AWS region | `CDK_DEFAULT_REGION` or `us-east-1` |
| `env` | Environment name (used in stack naming) | `dev` |

## Deployment

### First-Time Setup

```bash
# Install dependencies
cd cdk
npm install

# Bootstrap CDK in your AWS account/region (one-time per account/region)
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

### Deploy All Stacks

```bash
# Synthesize CloudFormation templates (validates configuration)
npx cdk synth

# Deploy all stacks (CDK resolves dependency order automatically)
npx cdk deploy --all

# Deploy with explicit environment
npx cdk deploy --all -c env=prod
```

### Deploy Individual Stacks

```bash
# Deploy only the auth stack
npx cdk deploy VirtualMeetup-dev-Auth

# Deploy only the API stack (will also deploy Auth + Data if not already deployed)
npx cdk deploy VirtualMeetup-dev-Api
```

### Useful Commands

```bash
# Show differences between deployed and local
npx cdk diff

# List all stacks
npx cdk list

# Destroy all stacks (removes all resources)
npx cdk destroy --all

# Synthesize and output CloudFormation template
npx cdk synth VirtualMeetup-dev-Auth > auth-template.yaml
```

## Post-Deployment Configuration

### GitHub Token for Recording Publication

After deployment, update the Secrets Manager secret with your GitHub personal access token:

```bash
aws secretsmanager put-secret-value \
  --secret-id VirtualMeetup/GitHubToken \
  --secret-string '{"token":"ghp_your_actual_token_here"}'
```

The token needs `repo` scope for pushing to the GitHub Pages repository.

### Frontend Deployment

After the Frontend stack is deployed, upload the SPA assets:

```bash
# Get the bucket name from stack outputs
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name VirtualMeetup-dev-Frontend \
  --query 'Stacks[0].Outputs[?OutputKey==`FrontendBucketName`].OutputValue' \
  --output text)

# Sync frontend assets to S3
aws s3 sync ../frontend/ s3://$BUCKET_NAME/ --delete
```

## Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run property-based tests only
npm run test:property
```

## Stack Outputs

After deployment, key outputs are available via CloudFormation:

| Output | Stack | Description |
|--------|-------|-------------|
| `VirtualMeetupUserPoolId` | Auth | Cognito User Pool ID |
| `VirtualMeetupUserPoolClientId` | Auth | Cognito App Client ID |
| `VirtualMeetupIdentityPoolId` | Auth | Cognito Identity Pool ID |
| `VirtualMeetupTableName` | Data | Main DynamoDB table name |
| `WebSocketConnectionsTableName` | Data | Connections table name |
| `VirtualMeetupHttpApiUrl` | API | HTTP API endpoint |
| `VirtualMeetupWebSocketApiUrl` | API | WebSocket API endpoint |
| `RecordingBucketName` | Streaming | S3 recording bucket name |
| `TranscriptionFunctionArn` | Transcription | Transcription Lambda ARN |
| `DistributionUrl` | Frontend | CloudFront URL |
| `PublisherFunctionArn` | Publication | Publisher Lambda ARN |

## Troubleshooting

### Common Issues

**CDK Bootstrap Required**
```
Error: This stack uses assets, so the toolkit stack must be deployed
```
Run `npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>` first.

**Region Mismatch for CloudFront WAF**
CloudFront WAF WebACLs must be created in `us-east-1`. The Frontend stack handles this automatically when deployed to `us-east-1`. If deploying to another region, the Frontend stack must still create its WAF in `us-east-1` (handled by the `CLOUDFRONT` scope in the WAF construct).

**IVS Service Availability**
Amazon IVS Real-Time is available in select regions. Ensure your deployment region supports IVS Real-Time stages. Recommended: `us-east-1`, `us-west-2`, `eu-west-1`.

**Cognito Advanced Security**
Advanced Security Mode (ENFORCED) requires the account to be opted in. If deployment fails on the Auth stack, verify your account supports Cognito Advanced Security features.

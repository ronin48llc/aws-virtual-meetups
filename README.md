# AWS Virtual Meetups

A serverless live virtual meetup platform built on AWS. Supports real-time video streaming, interactive chat, Q&A, hand raising, live captions, session recording, and email notifications.

## Architecture

- **Frontend**: Single-page application (vanilla JS) hosted on S3 + CloudFront
- **Backend**: AWS Lambda functions behind API Gateway (HTTP + WebSocket)
- **Streaming**: Amazon IVS Real-Time (WebRTC-based)
- **Chat**: Amazon IVS Chat
- **Captions**: Amazon Transcribe Streaming (browser-to-service via pre-signed WebSocket)
- **Auth**: Amazon Cognito (User Pool + Identity Pool)
- **Data**: Amazon DynamoDB
- **Email**: Amazon SES + EventBridge Scheduler
- **Recording**: IVS Composition → S3 → CloudFront
- **Infrastructure**: AWS CDK (TypeScript-free, plain JS)

## Features

- Live video streaming with screen share, webcam, and mic
- Green room / staging mode before going live
- Real-time group and direct chat
- Q&A with pin, answer, and dismiss
- Hand raising with acknowledge/dismiss
- Live captions via Amazon Transcribe Streaming
- Presenter dashboard (attendees, questions, hands)
- Promote/demote attendees to co-presenter
- Moderation: mute, restrict chat, kick, ban
- Session recording with HLS playback
- Email notifications (event created, reminders, live alerts)
- Event duration management with auto-stop and warnings
- Custom domain with HTTPS (Route53 + ACM + CloudFront)
- Mobile-responsive design
- WAF protection and rate limiting

## Prerequisites

- AWS Account with appropriate permissions
- AWS CLI v2 configured with a profile
- Node.js 18+ and npm
- A registered domain in Route53 (optional, for custom domain)
- IVS Real-Time resources (Storage Configuration + Encoder Configuration)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/ronin48llc/aws-virtual-meetups.git
cd aws-virtual-meetups/cdk
npm install
```

### 2. Configure

Create `cdk/cdk.context.json`:

```json
{
  "account": "YOUR_AWS_ACCOUNT_ID",
  "region": "us-east-1",
  "env": "dev",
  "domainName": "yourdomain.com",
  "hostedZoneId": "YOUR_ROUTE53_HOSTED_ZONE_ID",
  "ivsStorageConfigArn": "arn:aws:ivs:us-east-1:ACCOUNT:storage-configuration/ID",
  "ivsEncoderConfigArn": "arn:aws:ivs:us-east-1:ACCOUNT:encoder-configuration/ID"
}
```

### 3. Deploy

```bash
npx cdk bootstrap --profile YOUR_PROFILE
npx cdk deploy --all --require-approval never --profile YOUR_PROFILE
```

### 4. Update frontend config

After deployment, get the Cognito outputs and update `frontend/index.html`:

```javascript
window.COGNITO_USER_POOL_ID = 'YOUR_USER_POOL_ID';  // from Auth stack output
window.COGNITO_CLIENT_ID = 'YOUR_CLIENT_ID';         // from Auth stack output
window.API_BASE_URL = 'https://api.yourdomain.com';
window.WS_BASE_URL = 'wss://ws.yourdomain.com';
```

### 5. Sync frontend

```bash
aws s3 sync ../frontend/ s3://YOUR_FRONTEND_BUCKET --delete --profile YOUR_PROFILE
aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/*" --profile YOUR_PROFILE
```

### 6. Create admin user

```bash
export AWS_PROFILE=your-profile
export USER_POOL_ID=us-east-1_XXXXXXXX
export ADMIN_EMAIL=admin@yourdomain.com
export ADMIN_PASSWORD=YourSecurePassword1
./scripts/seed-admin.sh
```

## Project Structure

```
├── cdk/                    # AWS CDK infrastructure
│   ├── bin/app.js          # CDK app entry point
│   ├── lib/                # Stack definitions
│   ├── lambda/             # Lambda function code
│   │   ├── event-crud/     # Event CRUD operations
│   │   ├── session-manager/# IVS stage lifecycle
│   │   ├── token-generator/# IVS/Chat token generation
│   │   ├── signup/         # Event registration
│   │   ├── email-sender/   # Email notifications
│   │   ├── transcription/  # Transcribe pre-signed URL generation
│   │   ├── websocket/      # WebSocket handlers (connect, disconnect, signaling)
│   │   └── shared/         # Shared utilities
│   └── test/               # Unit and property-based tests
├── frontend/               # Single-page application
│   ├── index.html          # Entry point
│   ├── css/styles.css      # Stylesheet
│   └── js/                 # Application modules
├── docs/                   # Documentation
│   ├── ARCHITECTURE.md     # System architecture
│   ├── BRANDING.md         # Customization guide
│   ├── DEPLOYMENT.md       # Deployment instructions
│   ├── FEATURES.md         # Feature documentation
│   ├── WELL-ARCHITECTED.md # AWS Well-Architected review
│   └── WORKFLOW.md         # Development workflow
├── scripts/                # Utility scripts
└── LICENSE                 # MIT License
```

## Testing

```bash
cd cdk
npm test                    # Run all 805 tests
npx jest --no-coverage      # Run without coverage report
npx jest test/unit/         # Unit tests only
npx jest test/property/     # Property-based tests only
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design and component overview
- [Deployment](docs/DEPLOYMENT.md) — Step-by-step deployment guide
- [Features](docs/FEATURES.md) — Complete feature documentation
- [Branding](docs/BRANDING.md) — Customization and rebranding guide
- [Well-Architected](docs/WELL-ARCHITECTED.md) — AWS Well-Architected review
- [Workflow](docs/WORKFLOW.md) — Development workflow

## IVS Real-Time Setup

Before deploying, create these IVS resources in the AWS Console:

1. **Storage Configuration**: IVS Console → Real-Time → Storage configurations → Create
2. **Encoder Configuration**: IVS Console → Real-Time → Encoder configurations → Create

Pass the ARNs via CDK context (`ivsStorageConfigArn`, `ivsEncoderConfigArn`).

## Custom Domain Setup

1. Register a domain in Route53 (or transfer DNS)
2. Note the Hosted Zone ID
3. Set `domainName` and `hostedZoneId` in CDK context
4. Deploy — ACM certificate is auto-validated via DNS
5. Update `frontend/index.html` with your domain URLs

## License

MIT — see [LICENSE](LICENSE)

# Operations Runbook

Operational procedures for the Virtual Meetup Platform. Assumes the AWS CLI is configured with a profile that can read CloudFormation, Lambda, SQS, SNS, and DynamoDB in the deployment account.

Environments are namespaced by suffix: every physical resource name ends in `-dev` or `-prod` (e.g. `VirtualMeetupTable-prod`, `VirtualMeetup-EventCrud-prod`), and stacks are named `VirtualMeetup-<env>-<Stack>`. Substitute the environment you are operating on throughout this document.

---

## 1. CI/CD pipeline

| Branch | Environment | GitHub Environment |
|--------|-------------|--------------------|
| `develop` | `dev` | `development` |
| `main` | `prod` | `production` |

Pipeline: **test → deploy (CDK + frontend) → smoke test** (`.github/workflows/deploy.yml`).

### One-time GitHub configuration

1. **Secrets** (repo-level): `AWS_DEPLOY_ROLE_ARN` (OIDC deploy role), optionally `AWS_REGION`, `SMOKE_TEST_USERNAME`, `SMOKE_TEST_PASSWORD`. If `AWS_DEPLOY_ROLE_ARN` is unset, deploy and smoke jobs skip cleanly.
2. **Environments** (Settings → Environments): create `production` and `development`. On `production`, add **required reviewers** — this is the approval gate for prod deploys.
3. **Environment variables** on each environment:
   - `DOMAIN_NAME` (e.g. `awsvirtualmeetups.com`) — required
   - `HOSTED_ZONE_ID` — required
   - `ALARM_EMAILS` (comma-separated) — required for `production`; prod synth fails without it
   - `IVS_STORAGE_CONFIG_ARN`, `IVS_ENCODER_CONFIG_ARN` — required for recording
   - `SES_EMAIL_ENABLED` — set to `true` only after SES production access is granted (§7)

The pipeline regenerates `frontend/js/config.js` from stack outputs on every deploy. Never hand-edit the deployed copy; the committed copy is for local development only.

## 2. Rolling back a bad deploy

The pipeline does not auto-rollback. A smoke-test failure notifies the `VirtualMeetupAlarms-<env>` SNS topic and comments on the commit.

1. Identify the last good commit on the deployed branch (`git log`, or the last green run in Actions).
2. Revert on the branch — do not force-push:
   ```bash
   git revert <bad-commit-sha>   # or a range
   git push origin main
   ```
   The push re-triggers the pipeline, which redeploys infrastructure **and** frontend from the reverted tree.
3. If the pipeline itself is broken, deploy manually from the last good commit:
   ```bash
   git checkout <good-sha>
   cd cdk && npm ci
   npx cdk deploy --all --require-approval never \
     -c env=prod -c domainName=<domain> -c hostedZoneId=<zone> \
     -c alarmEmails=<emails> \
     -c ivsStorageConfigArn=<arn> -c ivsEncoderConfigArn=<arn>
   ```
   Then sync the frontend (same commands the pipeline runs — see the "Deploy frontend" step in deploy.yml).

CloudFormation rollback notes: stateful resources (tables, user pool, recordings bucket) are `RETAIN` in prod, so a failed stack update or rollback cannot delete data. If a stack is stuck in `UPDATE_ROLLBACK_FAILED`, use *Continue update rollback* in the CloudFormation console.

## 3. Responding to alarms

All alarms notify the SNS topic `VirtualMeetupAlarms-<env>` (email subscriptions from `ALARM_EMAILS`). Start at the CloudWatch dashboard `VirtualMeetupPlatform-<env>`.

| Alarm | Meaning | First moves |
|-------|---------|-------------|
| `VirtualMeetup-<env>-ApiErrorRate` | >5 HTTP 5xx in 5 min | Check API access logs (`/aws/apigateway/VirtualMeetupHttpApi-<env>/access`) for `integrationError`; then the failing Lambda's log group |
| `VirtualMeetup-<fn>-<env>-Errors` | Lambda threw | Saved Logs Insights query "error search" or `aws logs tail /aws/lambda/<fn> --since 30m` |
| `...-Throttling` (DynamoDB) | Throttled requests | On-demand tables: check for hot-partition patterns in the offending access path |
| `...-WebSocketClientErrors` | 4xx on $connect | Usually expired/invalid tokens or banned users reconnecting — check WsConnect logs |
| `...-MessagesVisible` (DLQs) | Failed async email/publication | §4 |

`GET https://api.<domain>/health` is an unauthenticated dependency probe (200 = Lambda + DynamoDB healthy, 503 = DynamoDB unreachable). Wire external synthetic monitoring against it.

## 4. Dead-letter queues: inspect and replay

Two DLQs: `VirtualMeetup-EmailDLQ-<env>` (failed email sends) and `VirtualMeetup-PublicationDLQ-<env>` (failed recording publications).

Inspect without consuming:

```bash
QUEUE_URL=$(aws sqs get-queue-url --queue-name VirtualMeetup-EmailDLQ-prod --query QueueUrl --output text)
aws sqs receive-message --queue-url "$QUEUE_URL" --max-number-of-messages 10 \
  --visibility-timeout 30 --message-attribute-names All
```

Each message body is the original async invocation event. To replay after fixing the root cause:

```bash
# Body of the DLQ message = original Lambda payload (for Lambda-destination DLQs
# the payload is under .requestPayload)
aws lambda invoke --function-name VirtualMeetup-EmailSender-prod \
  --invocation-type Event --payload file://payload.json /dev/null
# then delete the DLQ message:
aws sqs delete-message --queue-url "$QUEUE_URL" --receipt-handle <handle>
```

## 5. GitHub PAT for recording publication

The publisher Lambda commits Jekyll posts using a PAT stored in Secrets Manager at `VirtualMeetup-<env>/GitHubToken`. The stack creates the secret with a placeholder — publication fails until a real token is set:

```bash
export GITHUB_PAT='...'   # fine-grained PAT, contents:write on the publication repo only
aws secretsmanager put-secret-value \
  --secret-id VirtualMeetup-prod/GitHubToken \
  --secret-string "$(jq -n --arg t "$GITHUB_PAT" '{token:$t}')"
```

Rotation: fine-grained PATs expire — set a ≤90-day expiry, calendar the renewal, and re-run the command above with the new token. Publication failures land in the publication DLQ (§4), so a lapsed token is recoverable: fix the token, replay the DLQ.

## 6. Banning / disabling a user

- Event-level ban: presenter UI (kick/ban) writes a `BAN#<userId>` item; enforced at WebSocket connect and token generation. Lift a ban from the presenter dashboard's **Bans** tab.
- Account-level disable (Cognito): `POST https://api.<domain>/admin/users/disable` with body `{"username": "<email>"}` and an organizer's bearer token (`/enable` to reverse, `GET /admin/users/<email>/status` to check), or directly:
  ```bash
  aws cognito-idp admin-disable-user --user-pool-id <pool> --username <email>
  ```

## 7. SES production access (required before launch)

SES starts in sandbox mode: mail only reaches verified addresses, and Cognito's default mailer caps at ~50 emails/day. Before opening sign-ups:

1. AWS Console → **SES → Account dashboard → Request production access**.
2. Use case: transactional (event reminders, sign-up confirmations, going-live notifications). Include the domain, expected volume (estimate: attendees × events/week), and the bounce-handling note (SES MX record + suppression list are configured by EmailStack).
3. Approval typically takes 24–48h; AWS may ask follow-up questions — answer from the same support case.
4. Once granted: set the `SES_EMAIL_ENABLED=true` variable on the GitHub `production` environment and redeploy. This switches Cognito from its default mailer to the DKIM-verified domain identity.

## 8. Seeding the first admin

```bash
export AWS_PROFILE=<profile>
export USER_POOL_ID=<from Auth stack output>
export ADMIN_EMAIL=admin@<domain>
export ADMIN_PASSWORD=<strong password>
./scripts/seed-admin.sh
```

## 9. Destroying an environment

`cdk destroy --all -c env=dev ...` tears down dev cleanly (DESTROY policies). For prod, tables / user pool / recordings bucket are RETAINed and must be deleted manually after export — this is intentional friction.

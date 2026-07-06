# Live Persona E2E

End-to-end tests that drive the **real deployed site** as three personas —
presenter, signed-in attendee, anonymous viewer — across the full event
lifecycle (schedule → discover → RSVP → wait → go live → publish → moderate
→ extend → end → play back → stats).

Unlike `test/e2e` (mocked, CI-safe), this suite needs real IVS, Cognito,
DynamoDB, and S3. It uses Chromium's fake webcam/mic so the presenter
publishes genuine A/V and IVS produces a real recording. **It is not run in
CI** — run it on demand after deploys that touch streaming, tokens, or the
session lifecycle.

See [COVERAGE.md](COVERAGE.md) for the requirements traceability matrix and
what is deliberately excluded.

## Prerequisites

- Node 20+, and `npm install` in this directory (installs Playwright).
- `npx playwright install chromium`.
- **AWS credentials** in the environment with `cognito-idp` admin permission
  on the target user pool — the suite creates and deletes disposable
  personas. e.g. `export AWS_PROFILE=<your-sso-profile>` (SSO logged in).

## Run

```bash
# Against dev (defaults target the dev pool + awsvirtualmeetups.com):
AWS_PROFILE=<profile> npm test

# Faster iteration — shorter live hold (recording still needs ~60-90s):
AWS_PROFILE=<profile> LIVE_HOLD_MS=90000 npm test

# Watch it happen:
AWS_PROFILE=<profile> npm run test:headed

# Point at a different environment:
SITE_URL=https://staging.example.com API_URL=https://api.staging.example.com \
  LIVE_E2E_USER_POOL_ID=us-east-1_XXXX AWS_PROFILE=<profile> npm test
```

Report: `npm run report` (HTML), traces/video retained on failure under
`test-results/`.

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `SITE_URL` | `https://awsvirtualmeetups.com` | Frontend under test |
| `API_URL` | `https://api.awsvirtualmeetups.com` | HTTP API |
| `LIVE_E2E_USER_POOL_ID` | dev pool | Where disposable personas are created |
| `AWS_REGION` | `us-east-1` | For Cognito admin calls |
| `LIVE_HOLD_MS` | `120000` | How long the presenter stays live (recording material) |
| `RECORDING_WAIT_MS` | `480000` | Max wait for the recording to finalize |

## What it guarantees

The personas share one event, so a green run proves the seams hold
end-to-end: an attendee waiting before start **auto-joins** when the
presenter goes live; the presenter's **published A/V is recorded to S3** and
**plays back** through the CDN; **no email addresses leak** to guests; and
**attendance/show-rate stats** reflect who actually joined. This is the
regression net for the cross-service failures that unit tests can't see.

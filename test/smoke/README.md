# Smoke tests

End-to-end smoke checks against a deployed stack. Each `*.smoke.js` file exports
a `run(config, helpers)` function and exercises one layer of the system
(API Gateway, CloudFront SPA, IVS, WebSocket, full lifecycle). The runner
in `run.js` discovers them and dispatches.

## Running locally

```bash
# Required: at minimum the CloudFront URL (frontend) or API URL (REST checks).
# Each smoke file skips itself if its required config is missing — so partial
# config still produces useful pass/skip output.

export CLOUDFRONT_URL=https://d2hbje3cen4qrx.cloudfront.net
export API_URL=https://api.yourdomain.com
export WS_URL=wss://ws.yourdomain.com
export USER_POOL_ID=us-east-1_XXXXXXXX
export USER_POOL_CLIENT_ID=YourClientId
export SMOKE_TEST_EMAIL=smoke@example.com
export SMOKE_TEST_PASSWORD='your-password'

node test/smoke/run.js
```

Optional knobs:

| Env var | Default | Purpose |
|---|---|---|
| `SMOKE_RETRY_MAX` | `3` | Number of retries per `withRetry` block |
| `SMOKE_RETRY_DELAY_MS` | `1000` | Base delay, doubles each retry |

Exit code is `0` when no failures (skips are fine), `1` otherwise.

## Running in CI

`.github/workflows/smoke.yml` runs the suite:

- **On demand** via `workflow_dispatch`
- **Nightly** at 06:00 UTC (cron)

It expects these GitHub repo secrets to be configured for full coverage:

- `CLOUDFRONT_URL`, `API_URL`, `WS_URL`
- `USER_POOL_ID`, `USER_POOL_CLIENT_ID`
- `SMOKE_TEST_EMAIL`, `SMOKE_TEST_PASSWORD`

If a secret is missing, the corresponding smoke file calls `skip(...)` — the
job stays green but the subset that ran is the only signal you got. The
"passed / failed / skipped" totals printed at the end make this obvious.

## Adding a new smoke test

1. Create `test/smoke/my-feature.smoke.js`:

   ```js
   'use strict';
   async function run(config, { pass, fail, skip, withRetry }) {
     if (!config.apiUrl) { skip('My-feature tests', 'apiUrl not set'); return; }

     try {
       await withRetry(async () => {
         // ...the actual check...
       }, config, 'My-feature describe');
       pass('My-feature works');
     } catch (err) {
       fail('My-feature works', err);
     }
   }
   module.exports = { run };
   ```

2. Run `node test/smoke/run.js` locally to verify.

The runner picks the new file up by glob — no central registry to update.

Proudly Made in Nebraska. Go Big Red! 🌽 https://xkcd.com/2347/

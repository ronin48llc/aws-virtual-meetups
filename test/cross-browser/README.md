# Layer 4 — Selenium cross-browser smoke

Drives a few **critical happy-path flows** across **real** browser engines
against a **deployed/staging** stack. This is breadth (engines), not depth — the
deterministic per-PR coverage lives in `../e2e` (Playwright).

It **skips cleanly** (exit 0) when unconfigured, so it's safe in CI without a
live environment or grid credentials.

## Run it

```sh
npm install

# Local headless (Chrome + Firefox via Selenium Manager) against a deployed URL.
# cross-env sets the vars the same way on Linux/macOS/Windows shells:
npx cross-env TARGET_URL=https://staging.example.com npm test

# Against a local Selenium Grid (adds Edge if the grid offers it):
TARGET_URL=https://staging.example.com npm run test:local-grid

# Against a cloud grid — full matrix incl. real Edge + Safari/iOS:
npx cross-env TARGET_URL=https://staging.example.com \
  BROWSERSTACK_USERNAME=… BROWSERSTACK_ACCESS_KEY=… npm test
```

## Env vars

| Var | Purpose |
| --- | --- |
| `TARGET_URL` (or `CLOUDFRONT_URL`) | Deployed site to test. **Required** — unset ⇒ skip. |
| `SELENIUM_REMOTE_URL` | Selenium Grid hub URL. |
| `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` | BrowserStack cloud grid. |
| `SAUCE_USERNAME` / `SAUCE_ACCESS_KEY` | Sauce Labs cloud grid. |

Safari/iOS requires macOS or a cloud grid (Apple's `safaridriver` is macOS-only);
Edge is best on a grid/cloud. Chrome + Firefox run locally headless.

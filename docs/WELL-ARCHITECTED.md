# AWS Well-Architected Review

Review of the Virtual Meetups Platform against the six pillars of the AWS Well-Architected Framework.

---

## 1. Operational Excellence

### Strengths

- **Infrastructure as Code (CDK)** — All 10 stacks defined in AWS CDK with explicit dependency management, enabling repeatable deployments across environments (`dev`, `prod`)
- **Structured logging** — All Lambda functions use a shared logger module producing JSON-formatted logs with correlation IDs, action names, user context, and event IDs
- **CloudWatch dashboard** — Single pane of glass covering API latency (p50/p95/p99), error rates, Lambda duration per function, DynamoDB capacity, WebSocket connections, and engagement metrics
- **CloudWatch alarms** — Five alarms with SNS notification: API 5xx rate, Lambda errors, DynamoDB throttling, WebSocket failures, high Lambda duration (p99 > 5s)
- **Saved log queries** — CloudWatch Logs Insights queries pre-configured for error search, slow invocations, WebSocket disconnections, and failed auth attempts
- **CI/CD pipeline** — GitHub Actions workflow: test → synth → deploy → smoke test, with OIDC authentication and automatic rollback signals
- **Smoke tests** — Post-deployment validation covering API endpoints, WebSocket connectivity, frontend availability, and IVS resource creation
- **Log retention policy** — 30-day retention on all Lambda log groups (cost-controlled, sufficient for debugging)
- **Dead letter queues** — SQS DLQs for email and publication failures, enabling investigation and replay

### Gaps

- No automated rollback on smoke test failure (manual procedure documented in [RUNBOOK.md](RUNBOOK.md) §2; failure pages the alarm SNS topic and comments on the commit)
- No canary deployments or traffic shifting

---

## 2. Security

### Strengths

- **Cognito authentication** — Email-based sign-up with verification, SRP auth flow, advanced security in audit mode, compromised credential blocking
- **API Gateway authorizers** — Cognito User Pool authorizer on all protected HTTP routes; WebSocket auth via token on `$connect`
- **WAF protection (frontend)** — CLOUDFRONT WebACL on the frontend distribution with rate limiting, AWS Managed Rules (Common, SQLi, Known Bad Inputs), and 4KB body size restriction. The HTTP/WebSocket APIs cannot take a WAFv2 association (API Gateway v2 limitation) and are protected instead by stage throttling (200 rps default, 5 rps operator routes), Cognito authorizers, and per-fingerprint rate limiting on anonymous routes
- **Input validation** — Shared validation module enforces field types, lengths, and formats on all Lambda handlers
- **Ban system** — User-level bans stored in DynamoDB, enforced at connection time and token generation; admin API for Cognito account disable
- **SES domain verification (DKIM)** — Domain identity with automatic DKIM DNS records prevents email spoofing
- **S3 block public access** — All buckets configured with `BlockPublicAccess.BLOCK_ALL`
- **Origin Access Identity** — CloudFront accesses S3 exclusively via OAI; no direct bucket access
- **CORS strict allowlist** — Only `awsvirtualmeetups.com` origins permitted on API
- **Account lockout** — 5 failed login attempts trigger 15-minute temporary lock
- **No client secrets** — SPA uses SRP without client secret (appropriate for public clients)
- **Least privilege IAM** — Lambda roles scoped to specific DynamoDB tables and actions

### Gaps and accepted risks

- **Recordings are publicly accessible via CloudFront — accepted by design.** The publication flow deliberately publishes every recording to a public GitHub Pages site after the event, so signed URLs would only protect content the platform then publishes anyway. Revisit only if private/paid events are introduced.
- **CSP `script-src` retains `'unsafe-inline'`** — the SPA renders ~74 inline `onclick` attribute handlers via innerHTML templates; dropping the directive requires refactoring them to addEventListener (tracked follow-up). Mitigations in place: strict `connect-src`/`frame-ancestors`, SRI on CDN scripts, no user-generated HTML rendered unescaped.
- No WAF IP reputation list or geographic restrictions (frontend WebACL)
- No automated rotation for the GitHub PAT in Secrets Manager (manual rotation procedure in [RUNBOOK.md](RUNBOOK.md) §5)

---

## 3. Reliability

### Strengths

- **DynamoDB on-demand** — Automatic scaling with no capacity planning; handles burst traffic from event starts
- **Lambda auto-scaling** — Concurrent executions scale automatically with request volume
- **CloudFront global distribution** — Frontend and recordings served from edge locations worldwide
- **Fire-and-forget patterns** — Email sending and scheduler creation are non-blocking; failures don't impact the primary request path
- **Graceful error handling** — All Lambda handlers use try/catch with structured error responses; no unhandled promise rejections
- **TTL-based connection cleanup** — WebSocket connections table uses DynamoDB TTL to automatically remove stale entries
- **Dead letter queues** — Failed async invocations (email, publication) captured for retry
- **Retry configuration** — Publisher Lambda configured with 2 retries; EventBridge targets with 3 retries and 2-hour max age
- **Multi-AZ by default** — All managed services (DynamoDB, Lambda, API Gateway) are inherently multi-AZ
- **Event isolation** — Each event has independent IVS Stage, Chat Room, and DynamoDB partition; one event's failure doesn't affect others

### Gaps

- No multi-region disaster recovery
- No circuit breaker pattern for IVS API calls
- Single-region deployment (us-east-1 only)

---

## 4. Performance Efficiency

### Strengths

- **CloudFront CDN** — Frontend assets and recordings served from edge locations; reduces latency for global users
- **DynamoDB single-table design** — Optimized access patterns with GSIs; single query retrieves all event data
- **Lambda right-sizing (256MB)** — All functions configured at 256MB; balances cost and performance for Node.js workloads
- **WebSocket for real-time** — Persistent connections eliminate HTTP polling overhead; sub-second message delivery
- **Client-side countdown** — Duration timer runs in browser (no server push needed); reduces WebSocket message volume
- **IVS Real-Time (WebRTC)** — Sub-300ms latency for live streaming; no transcoding delay
- **Price Class 100** — CloudFront uses North America + Europe edges (sufficient for target audience; reduces cost)
- **Connection table separation** — High-throughput WebSocket connections isolated from main table to prevent hot partitions
- **Async email sending** — Non-blocking Lambda invocation for email; doesn't add latency to API responses

### Gaps

- No Lambda provisioned concurrency for cold start mitigation on critical paths (session start, token generation)
- No API Gateway caching on GET /events (public listing)
- No DynamoDB DAX for read-heavy access patterns
- CloudFront Price Class 100 limits performance for Asia-Pacific users

---

## 5. Cost Optimization

### Strengths

- **Fully serverless** — Pay-per-use across all services; zero cost when idle
- **S3 lifecycle rules** — Recordings transition to Infrequent Access (30 days) then Glacier (90 days)
- **CloudFront Price Class 100** — Limits edge locations to North America + Europe (cheapest tier)
- **DynamoDB on-demand** — No over-provisioned capacity; pay only for actual reads/writes
- **Lambda 256MB** — Cost-effective memory allocation for Node.js; avoids over-provisioning
- **EventBridge Scheduler** — Pay-per-schedule execution vs. always-on polling infrastructure
- **Cognito free tier** — Up to 50,000 MAUs at no cost
- **IVS Chat free tier** — Up to 3 rooms and 500 concurrent connections free
- **No NAT Gateway** — All Lambda functions use public endpoints (no VPC = no NAT cost)
- **Auto-delete on destroy** — S3 buckets configured with `autoDeleteObjects` for clean teardown in dev
- **Estimated cost** — ~$8.22 per 90-minute event (1 presenter, 40 attendees); ~$1.06/month steady-state

### Gaps

- No budget alerts or AWS Budgets configuration
- Recording bucket versioning enabled (increases storage cost; noncurrent versions expire after 30 days)
- No S3 Intelligent-Tiering (uses manual lifecycle rules instead)

---

## 6. Sustainability

### Strengths

- **Serverless architecture** — Shared infrastructure; no idle compute resources
- **Right-sized resources** — 256MB Lambda functions; no over-provisioned capacity
- **Efficient data transfer** — WebSocket persistent connections vs. HTTP polling (fewer TCP handshakes, less bandwidth)
- **CDN caching** — CloudFront reduces origin requests; cached content served from edge
- **On-demand scaling** — Resources scale to zero when not in use; no always-on servers
- **Single-table DynamoDB** — Fewer tables = fewer resources provisioned; efficient storage utilization
- **Event-driven architecture** — Processing only occurs when events trigger it; no background polling

### Gaps

- No carbon footprint tracking or sustainability metrics
- No region selection based on renewable energy availability
- Recording storage grows indefinitely (Glacier tier, but never deleted)

---

## Gaps and Recommendations

### High Priority

| Recommendation | Pillar | Effort | Impact |
|---------------|--------|--------|--------|
| Refactor inline onclick handlers; drop CSP 'unsafe-inline' | Security | Medium | Removes the main XSS-hardening gap |
| Add Lambda reserved concurrency for critical paths | Performance | Low | Prevents cold starts on session start and token generation |

Previously listed here and since implemented: DynamoDB point-in-time recovery (both tables), per-connection WebSocket rate limiting (websocket/rate-limiter.js), per-message token-expiry checks, cost allocation tags, health check endpoint (GET /health), anonymous WebSocket session validation. CloudFront signed URLs were evaluated and rejected — recordings are published publicly by design (see Security).

### Medium Priority

| Recommendation | Pillar | Effort | Impact |
|---------------|--------|--------|--------|
| Add X-Ray tracing for distributed debugging | Operational Excellence | Low | End-to-end request tracing across Lambda, DynamoDB, IVS |
| Add multi-region DR (active-passive) | Reliability | High | Survives regional outages |
| Add API Gateway caching on GET /events | Performance | Low | Reduces Lambda invocations for public listing |
| Add AWS Budgets with alerts | Cost | Low | Early warning on unexpected spend |
| Add cost allocation tags | Cost | Low | Per-event and per-stack cost attribution |

### Low Priority

| Recommendation | Pillar | Effort | Impact |
|---------------|--------|--------|--------|
| Consider Aurora Serverless for complex queries | Performance | High | Better for analytics and reporting workloads |
| Add automated backup/restore testing | Reliability | Medium | Validates recovery procedures |
| Add canary deployments with CodeDeploy | Operational Excellence | Medium | Gradual rollout with automatic rollback |
| Add synthetic monitoring (CloudWatch Synthetics) | Reliability | Medium | Proactive detection of user-facing issues |
| Implement secrets rotation for GitHub token | Security | Low | Reduces risk of compromised long-lived credentials |
| Add geographic restrictions in WAF | Security | Low | Block traffic from unexpected regions |
| Track carbon footprint with AWS Customer Carbon Footprint Tool | Sustainability | Low | Visibility into environmental impact |

---

## Summary Scorecard

| Pillar | Score | Notes |
|--------|-------|-------|
| Operational Excellence | ⭐⭐⭐⭐ | Strong IaC, logging, dashboards, CI/CD; missing runbooks and canary deploys |
| Security | ⭐⭐⭐⭐ | Comprehensive auth, WAF, validation, DKIM; needs signed URLs and WebSocket action limits |
| Reliability | ⭐⭐⭐⭐ | Multi-AZ managed services, graceful errors, DLQs; single-region, no PITR |
| Performance Efficiency | ⭐⭐⭐⭐ | CDN, WebSocket, single-table DynamoDB; could add caching and provisioned concurrency |
| Cost Optimization | ⭐⭐⭐⭐⭐ | Fully serverless, lifecycle rules, free tiers leveraged; excellent cost profile |
| Sustainability | ⭐⭐⭐⭐ | Serverless, right-sized, event-driven; no active sustainability tracking |

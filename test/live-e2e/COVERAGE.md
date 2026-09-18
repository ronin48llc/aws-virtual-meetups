# Live E2E — Requirements Traceability

This suite (`test/live-e2e/`) drives the **real deployed environment** with
three personas across the full event lifecycle. It exists to catch the class
of defect that mocked tests structurally cannot — the seams between the
frontend, IVS, Cognito, DynamoDB, and S3 — which is exactly where every
recording bug of this project lived.

## Test layers, and why this one is different

| Layer | Location | Runs in CI | Real AWS | Catches |
|-------|----------|:----------:|:--------:|---------|
| Backend unit / property | `cdk/test/unit`, `cdk/test/property` | ✅ | ❌ (mocked SDK) | Handler logic, IAM/CFN template shape |
| Frontend unit (jsdom) | `test/unit-frontend` | ✅ | ❌ | Module logic, i18n, fingerprint |
| Mocked E2E (Playwright) | `test/e2e` | ✅ | ❌ (SDK doubles) | UI wiring, routing, rendering |
| Post-deploy smoke | `test/smoke` | ✅ (post-deploy) | ✅ (shallow) | Endpoints alive, WS connects |
| **Live persona E2E** | **`test/live-e2e`** | **❌ on-demand** | **✅ (deep)** | **Cross-service seams: publish→record→S3→playback, token attrs, auto-join, stats** |

Live E2E is **not** in CI: it needs real IVS compositions, disposable
Cognito users, and minutes-long waits for recording finalization. Run it
manually after a deploy that touches streaming, tokens, or the session
lifecycle. See `README.md` for how.

## Coverage matrix

Legend: **L** = asserted here (live), **U** = backend unit, **M** = mocked
E2E, **S** = smoke.

### Before the event

| Requirement (FEATURES.md) | Persona | Live step | Also |
|---|---|---|---|
| Event scheduling (create form, datetime, duration) | Presenter | `presenter schedules an event` | U (event-crud create), M |
| Event discovery (public event page) | Attendee, Anonymous | `attendee discovers…`, `anonymous visitor can browse` | M |
| RSVP / sign-up (one-click register) | Attendee | `attendee discovers the event and RSVPs` | U (signup) |
| Sign-up confirmation email | — | *excluded* (SES sandbox — see below) | U (email templates) |
| Guest sees no other users' emails (privacy) | Anonymous | `anonymous visitor can browse` (asserts absence) | U (token-generator displayName) |

### During the event

| Requirement | Persona | Live step | Also |
|---|---|---|---|
| Green room / staging start | Presenter | `attendee in the waiting room auto-joins…` (start) | U (session-manager) |
| Waiting room + auto-join on go-live | Attendee | `attendee in the waiting room auto-joins…` | — |
| Publish webcam + mic to IVS stage | Presenter | same (self-view assertion) | — |
| Screen + webcam composited into ONE published stream (1280x720 canvas, PiP, letterboxed) | Presenter | `screen share composites with the webcam` | — |
| PROGRAM self-view (presenter sees the true published feed, labeled) | Presenter | same (`#program-badge`) | — |
| Chat autoscroll only when reader is at bottom | — | — | frontend unit (chat-autoscroll) |
| Composition starts / records to S3 | Presenter | proven by the *after* recording step | U (session-manager), verified live 2026-07-05 |
| Go Live transition | Presenter | `…auto-joins when the presenter goes live` | U |
| Anonymous live viewing | Anonymous | `anonymous viewer watches the live session` | U (anonymous-token), U (connect anon validation) |
| Presenter dashboard — anon viewer count | Presenter | `anonymous viewer watches…` | — |
| Raise hand | Attendee | `attendee raises a hand and asks a question` | U (signaling hands), M |
| Submit question (Q&A) | Attendee | same | U (signaling questions), M |
| Dashboard reflects hands + questions | Presenter | same | — |
| Extend duration (+15/30/60) | Presenter | `presenter extends the event duration` | U (session-manager extend) |
| End Session (presenter button) | Presenter | `presenter holds live… then ends` | U (session-manager stop) |
| Ended-state UI (no stuck "Ending…") | Presenter | same | — |
| Group chat round-trip (IVS Chat) | Attendee → Presenter | `attendee group chat reaches the presenter` | U (signaling chat), M |
| Direct chat | — | *gap — see below* | U (signaling chat) |
| Live captions — broadcast → per-lane Amazon Translate → targeted delivery (multi-lane: es attendee + fr anonymous lanes fan out in ONE session) | Presenter → Attendee, Anonymous | `attendee selects Spanish and receives a translated live caption`, `anonymous viewer watches the live session` | U (signaling broadcastCaption) |
| Anonymous caption UI (guest live-view language select → setCaptionLanguage WS on an anon connection → targeted CAPTION renders in `#anon-caption-text`) | Anonymous | `anonymous viewer watches the live session` (fr assertion) | U (signaling: anon connections allowed), frontend unit |
| Caption revert to original (`setCaptionLanguage('original')` REMOVEs the lane; never-selected viewers default to the original feed) | — | *not asserted live* | U (signaling "original" revert + next-broadcast lane), frontend unit (caption-language) |
| Live caption speech capture (Web Speech) | — | *excluded* (needs real speech — see below) | — |
| Moderation: ban + unban | Presenter | `presenter bans then unbans the attendee` | U (signaling), M |
| Role change targeting (promote) | Presenter → Attendee | `promoting the attendee changes only their role` | — |
| Co-presenter publishing (publish token + A/V controls) | Attendee → Presenter | `promoted co-presenter can actually publish audio and video` | U (signaling-roles token mint) |
| Moderation: mute/kick, restrict-chat | — | *gap — see below* | U (signaling), M |

### After the event

| Requirement | Persona | Live step | Also |
|---|---|---|---|
| Recording finalizes + URL exposed after verify | — | `recording becomes available and plays back` | U (event-crud existence gate) |
| HLS manifest is valid + served via CDN | Attendee | same (fetches `#EXTM3U`) | — |
| Recording playback (player renders) | Attendee | same | M (playback), U |
| Per-language playback caption VTTs (public `/captions/{lang}`, S3-cached) | Attendee | same (fetches `original` + `es`, asserts `WEBVTT`) | U (event-crud captions) |
| Recording publication → GitHub Pages | — | *excluded* (needs real PAT — see below) | U (publisher) |
| Recap email with recording link | — | *excluded* (SES sandbox) | U (email templates) |
| Sign-up stats + RSVP show rate | Presenter | `presenter reviews sign-up stats` | U (signup listing) |
| Attendance marking (attendedAt) | Presenter | same (API assertion) | U (token-generator attendance) |
| Engagement metrics (attendees/questions/duration/anonymous viewers) | Presenter | `presenter reviews sign-up stats` (GET `/events/{id}` asserts `metrics.anonymousViewers` ≥ 1 — the anonymous persona's live watch must survive to the stop-time summary) | U (engagement-metrics) |

## Deliberate exclusions (and why)

- **Live caption speech capture** — transcripts come from the presenter
  browser's Web Speech API, which needs a real microphone speaking real
  words; headless fake audio produces no transcript. Everything downstream
  of capture IS now live-tested by driving `broadcastCaptionToAttendees`
  directly: broadcast, per-lane Amazon Translate fan-out, targeted
  delivery, segment persistence, and the per-language playback VTTs.
  Capture itself is Chrome/Edge-only by design.
- **Email delivery (confirmation, reminders, live alert, recap)** — SES is
  in sandbox mode; mail only reaches verified addresses and test personas
  use `@test.invalid`. Template rendering and the send trigger are unit
  tested; delivery is a manual check once SES production access lands.
- **Recording publication to GitHub Pages** — requires a real GitHub PAT in
  Secrets Manager; the publisher Lambda's logic (metadata, WebVTT, URL) is
  unit tested including the optional-transcript path.
- **Scheduled reminders (24h/1h)** — EventBridge fires these on a real
  clock hours ahead; unit tests cover schedule creation and the email
  payload.

## Known gaps (candidate future live steps)

These are real requirements not yet exercised live — good next additions:

1. **Direct chat** — a DM from attendee to presenter (presenter-only visibility).
2. **Moderation: mute / kick / restrict-chat** — assert the attendee's
   client reflects the action (mute stops their mic; kick disconnects).
3. **Multi-attendee** — a second signed-in attendee to exercise the
   attendee list and broadcast fan-out at n>1.

## Previously-incomplete features, now implemented

These advertised capabilities did not work end-to-end and are now fixed and
covered live:

- **Co-presenter publishing** — promotion now mints a PUBLISH-capable IVS
  stage token in the signaling Lambda (granted `ivs:CreateParticipantToken`)
  and delivers it to the promoted connection ONLY (never on the event-wide
  broadcast). The frontend splits the A/V publish controls into their own
  `#publish-controls` container shown for presenter OR co-presenter, and on a
  self-targeted `ROLE_CHANGED` carrying a `stageToken` it leaves and rejoins
  the stage with the new token. Demotion reverses it (SUBSCRIBE-only token,
  controls hidden, local tracks stopped). Verified by `promoted co-presenter
  can actually publish audio and video`.
- **Grant speak permission** — acknowledging a raised hand (and the explicit
  `grantSpeak` action) now mints a PUBLISH token the same way and delivers it
  to the target via `SPEAK_PERMISSION_CHANGED`; the frontend shows the A/V
  controls and rejoins with the publish token. `revokeSpeak` reverses it.

- **Anonymous viewers excluded from engagement metrics** — the audit
  finding that the stop-time summary counted no anonymous viewers (and
  that auto-stop stored no metrics at all) is **fixed**: both the manual
  stop route and auto-stop now compute one shared summary
  (totalAttendees, totalQuestions, durationSeconds, `anonymousViewers` =
  distinct live-session fingerprints among the event's ANON rows),
  persisted via the single metrics writer, returned in the GET
  `/events/{id}` metrics block when present (older events omit it, never
  0-faked), and shown in the Event Stats strip. Verified live by the
  `anonymousViewers` ≥ 1 assertion in `presenter reviews sign-up stats
  and attendance`.

Two related ROLE_CHANGED bugs were FIXED earlier and are guarded by the
promote test above: (1) the handler read `msg.data.role` but the backend
sends `newRole`, so role changes never applied at all; (2) it now also gates
on the target `userId` so a broadcast role change can't affect every
recipient.

## Bugs surfaced while building this suite

- **Kind-blind stream removal killed the self-view** (caught by the
  composite test on its first run). Starting screen share swaps the
  published AUDIO stream (mic → mic+device-audio mix) while the video
  stream — the compositor canvas — keeps its identity. The
  `STAGE_PARTICIPANT_STREAMS_REMOVED` handler removed BOTH the video and
  audio elements for the participant regardless of which kind was removed,
  so the audio swap deleted the presenter's self-view video, and nothing
  recreated it (the matching `STREAMS_ADDED` carries no video stream). The
  same defect would have blanked a remote co-presenter's video for every
  viewer whenever their audio stream changed. Fixed by removing only the
  element matching each removed stream's kind.
- **Lingering device-picker modal** — after a live session ends, the
  `#device-picker-overlay` can remain in the DOM across hash navigation and
  intercept pointer events on the next page (observed: End Session → back to
  Manage → the Sign-ups button is unclickable by a real mouse). Low severity
  (narrow path), but a real UX papercut. The suite works around it with
  `dispatchEvent`; the fix is to remove the overlay on `LiveSession`
  teardown / route change.

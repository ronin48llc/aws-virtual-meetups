# Branding & Customization Guide

This guide explains how to rebrand and customize the platform for a different community, organization, or use case.

---

## Quick Start

To rebrand the platform, you need to change values in **4 files**:

| File | What to change |
|------|---------------|
| `frontend/index.html` | Page title, meta description, nav brand name |
| `frontend/js/app.js` | Hero title, hero subtitle |
| `frontend/css/styles.css` | Color scheme (CSS custom properties) |
| `cdk/lambda/email-sender/templates.js` | Email platform name, brand color, sender email |

---

## 1. Platform Name

### Current: "AWS Virtual Meetups"

| Location | File | Line/Section |
|----------|------|-------------|
| Browser tab title | `frontend/index.html` | `<title>` tag |
| Meta description | `frontend/index.html` | `<meta name="description">` |
| Nav bar brand | `frontend/index.html` | `.nav__brand` span |
| Homepage hero | `frontend/js/app.js` | `hero__title` in `HomePage()` |
| Homepage subtitle | `frontend/js/app.js` | `hero__subtitle` in `HomePage()` |
| Email subject prefix | `cdk/lambda/email-sender/templates.js` | `PLATFORM_NAME` constant |
| Email header | `cdk/lambda/email-sender/templates.js` | `PLATFORM_NAME` in `wrapHtml()` |
| Email footer | `cdk/lambda/email-sender/templates.js` | `PLATFORM_NAME` in `textFooter()` |

### To change:

```javascript
// cdk/lambda/email-sender/templates.js
const PLATFORM_NAME = 'Your Community Meetups';
```

```html
<!-- frontend/index.html -->
<title>Your Community Meetups</title>
<meta name="description" content="Your Community Meetups — Live virtual events for your group">
<span>Your Community Meetups</span>
```

---

## 2. Color Scheme

### Current: AWS Orange (`#FF9900`) + Squid Ink (`#232F3E`)

Colors are used in two places:

### CSS (frontend/css/styles.css)

The stylesheet uses CSS custom properties at the top:

```css
:root {
  --color-primary: #FF9900;        /* Main brand color (buttons, links, accents) */
  --color-primary-dark: #EC7211;   /* Hover state */
  --color-bg-dark: #232F3E;        /* Dark backgrounds (nav, footer) */
  --color-bg-darker: #161E2D;      /* Darkest background (live session) */
}
```

Change these to your brand colors. For example, for a blue theme:
```css
:root {
  --color-primary: #0066CC;
  --color-primary-dark: #004C99;
  --color-bg-dark: #1a1a2e;
  --color-bg-darker: #0f0f1a;
}
```

### JavaScript (live-session.js)

The live session uses hardcoded color constants:

```javascript
// frontend/js/live-session.js
const SQUID_INK = '#232F3E';   // Dark panel backgrounds
const DARK_BG = '#161E2D';     // Page background
const AWS_ORANGE = '#FF9900';  // Accent color (buttons, highlights)
```

Change these to match your CSS custom properties.

### Email Templates

```javascript
// cdk/lambda/email-sender/templates.js
const BRAND_COLOR = '#FF9900';  // Email header background color
```

---

## 3. Domain

### Current: `awsvirtualmeetups.com`

To use a different domain, update these locations:

| File | What to change |
|------|---------------|
| `cdk/lib/dns-stack.js` | Hosted zone ID (your Route53 zone) |
| `cdk/lib/frontend-stack.js` | `domainNames` array |
| `cdk/lib/api-stack.js` | Custom domain names (`api.yourdomain.com`, `ws.yourdomain.com`) |
| `cdk/lib/api-stack.js` | CORS `allowOrigins` |
| `cdk/lib/email-stack.js` | SES domain identity |
| `cdk/bin/app.js` | `domainNames` prop, `frontendUrl` |
| `frontend/index.html` | `window.API_BASE_URL`, `window.WS_BASE_URL` |

### Steps:

1. Register your domain in Route53 (or transfer DNS)
2. Update `dns-stack.js` with your hosted zone ID:
   ```javascript
   this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
     hostedZoneId: 'YOUR_HOSTED_ZONE_ID',
     zoneName: 'yourdomain.com',
   });
   ```
3. Update all domain references in CDK stacks
4. Update `frontend/index.html`:
   ```javascript
   window.API_BASE_URL = 'https://api.yourdomain.com';
   window.WS_BASE_URL = 'wss://ws.yourdomain.com';
   ```
5. Deploy DnsStack first (wait for ACM certificate validation)
6. Deploy remaining stacks

---

## 4. Email Sender

### Current: `noreply@awsvirtualmeetups.com`

| File | What to change |
|------|---------------|
| `cdk/lib/email-stack.js` | `fromEmail` in `UserPoolEmail.withSES()` |
| `cdk/lib/auth-stack.js` | `fromEmail` in Cognito email config |
| `cdk/lambda/email-sender/templates.js` | `PLATFORM_EMAIL` constant |

```javascript
// cdk/lambda/email-sender/templates.js
const PLATFORM_EMAIL = 'support@yourdomain.com';
```

```javascript
// cdk/lib/auth-stack.js
email: cognito.UserPoolEmail.withSES({
  fromEmail: 'noreply@yourdomain.com',
  fromName: 'Your Community Meetups',
  sesRegion: 'us-east-1',
}),
```

---

## 5. Logo / Brand Icon

### Current: Cloud emoji (☁) in the nav bar

```html
<!-- frontend/index.html -->
<span class="nav__brand-icon" aria-hidden="true">☁</span>
```

Replace with your logo:
- **Emoji**: Change `☁` to any emoji
- **Image**: Replace with `<img src="logo.png" alt="Logo" style="height: 24px;">`
- **SVG**: Inline an SVG for best quality

---

## 6. Hero Section / Landing Page Copy

### Current copy:
- Title: "AWS Virtual Meetups"
- Subtitle: "Join live virtual meetups hosted by AWS user groups. Learn, connect, and grow with the community."

### To change:

In `frontend/js/app.js`, find the `HomePage()` function:

```javascript
<h1 class="hero__title">Your Community Name</h1>
<p class="hero__subtitle">Your custom tagline describing what your community does.</p>
```

---

## 7. Footer

### Current: "Powered by AWS"

```html
<!-- frontend/index.html -->
<span>Powered by AWS</span>
```

Change to your preferred attribution or remove entirely.

---

## 8. Cognito Configuration

### Current: Pool ID and Client ID hardcoded in index.html

```javascript
window.COGNITO_USER_POOL_ID = 'us-east-1_XXXXXXXX';
window.COGNITO_CLIENT_ID = 'XXXXXXXXXXXXXXXXXXXXXXXXXX';
```

These are deployment-specific. After deploying your own Auth stack, update these with the values from the stack outputs:

```bash
aws cloudformation describe-stacks --stack-name YourPrefix-Auth \
  --query "Stacks[0].Outputs"
```

---

## 9. CDK Stack Naming

### Current prefix: `VirtualMeetup-dev`

In `cdk/bin/app.js`:

```javascript
const envName = app.node.tryGetContext('env') || 'dev';
const prefix = `VirtualMeetup-${envName}`;
```

Change `VirtualMeetup` to your project name:

```javascript
const prefix = `YourProject-${envName}`;
```

**Note:** Changing the prefix after initial deployment will create NEW stacks (not update existing ones). Only change before first deployment.

---

## 10. Region

### Current: `us-east-1`

In `cdk/bin/app.js`:

```javascript
const env = {
  account: app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1',
};
```

**Important:** IVS Real-Time is only available in specific regions. Check [IVS Real-Time availability](https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/getting-started.html) before changing.

Supported regions for IVS Real-Time (as of 2024):
- `us-east-1` (N. Virginia)
- `us-west-2` (Oregon)
- `eu-west-1` (Ireland)
- `ap-northeast-1` (Tokyo)
- `ap-south-1` (Mumbai)

---

## Checklist for Rebranding

- [ ] Update `PLATFORM_NAME` in email templates
- [ ] Update `BRAND_COLOR` in email templates
- [ ] Update `PLATFORM_EMAIL` in email templates
- [ ] Update CSS custom properties (colors)
- [ ] Update `SQUID_INK`, `DARK_BG`, `AWS_ORANGE` in live-session.js
- [ ] Update page title and meta description in index.html
- [ ] Update nav brand name and icon in index.html
- [ ] Update hero title and subtitle in app.js
- [ ] Update footer text in index.html
- [ ] Update domain references in CDK stacks
- [ ] Update CORS origins in api-stack.js
- [ ] Update Cognito email sender configuration
- [ ] Update CDK stack prefix
- [ ] Deploy and verify

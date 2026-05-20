'use strict';

// Frontend runtime configuration. Operators populate these values
// post-deploy from CDK stack outputs (Auth, Api, Dns). Keep this file
// the single edit point — moving the inline <script> out of index.html
// is what lets the CloudFront CSP drop 'unsafe-inline' from script-src.
window.COGNITO_USER_POOL_ID = 'YOUR_USER_POOL_ID';
window.COGNITO_CLIENT_ID = 'YOUR_CLIENT_ID';
window.API_BASE_URL = 'https://api.yourdomain.com';
window.WS_BASE_URL = 'wss://ws.yourdomain.com';

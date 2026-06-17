'use strict';

// Frontend runtime configuration. Operators populate these values
// post-deploy from CDK stack outputs (Auth, Api, Dns). Keep this file
// the single edit point — moving the inline <script> out of index.html
// is what lets the CloudFront CSP drop 'unsafe-inline' from script-src.
window.COGNITO_USER_POOL_ID = 'us-east-1_Z8YDS0abS';
window.COGNITO_CLIENT_ID = '47dpjhd7jii6u0d73krcuf26vm';
window.API_BASE_URL = 'https://api.awsvirtualmeetups.com';
window.WS_BASE_URL = 'wss://ws.awsvirtualmeetups.com';

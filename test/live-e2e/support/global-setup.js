'use strict';

const { setupPersonas } = require('./personas');
const { USER_POOL_ID, SITE_URL } = require('./env');

// Creates the disposable Cognito personas before any spec runs. Requires
// AWS credentials in the environment (SSO profile via AWS_PROFILE, or keys)
// with cognito-idp admin permissions on the target user pool.
module.exports = async () => {
  console.log(`[live-e2e] target site: ${SITE_URL}`);
  console.log(`[live-e2e] creating disposable personas in pool ${USER_POOL_ID}`);
  const state = await setupPersonas();
  console.log(`[live-e2e] personas ready: ${Object.keys(state).join(', ')}`);
};

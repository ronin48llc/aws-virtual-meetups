'use strict';

/**
 * Load test configuration.
 * Values can be overridden via environment variables or by editing this file.
 */
const config = {
  // Target environment
  apiUrl: process.env.LOAD_TEST_API_URL || 'http://localhost:3000',
  wsUrl: process.env.LOAD_TEST_WS_URL || 'ws://localhost:3001',
  cognitoUserPoolId: process.env.LOAD_TEST_COGNITO_POOL_ID || '',
  cognitoClientId: process.env.LOAD_TEST_COGNITO_CLIENT_ID || '',

  // Test credentials (pre-created test users)
  testUserPrefix: process.env.LOAD_TEST_USER_PREFIX || 'loadtest-user',
  testUserPassword: process.env.LOAD_TEST_USER_PASSWORD || 'LoadTest123!',

  // Ramp-up configuration
  totalUsers: parseInt(process.env.LOAD_TEST_USERS || '100', 10),
  rampUpSeconds: parseInt(process.env.LOAD_TEST_RAMP_UP || '60', 10),
  holdSeconds: parseInt(process.env.LOAD_TEST_HOLD || '30', 10),

  // Scenario distribution (percentages, must sum to 100)
  scenarios: {
    'join-and-watch': 70,
    'active-participant': 25,
    'presenter': 5,
  },

  // Thresholds for CI pass/fail
  maxErrorRate: parseFloat(process.env.LOAD_TEST_MAX_ERROR_RATE || '0.05'),
  maxP95Latency: parseInt(process.env.LOAD_TEST_MAX_P95 || '3000', 10),

  // Reporting
  outputJson: process.env.LOAD_TEST_OUTPUT_JSON || '',
};

module.exports = config;

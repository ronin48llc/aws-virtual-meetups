'use strict';

const config = require('./config');
const Report = require('./report');
const VirtualUser = require('./virtual-user');
const path = require('path');

// Load scenario modules
const scenarios = {
  'join-and-watch': require('./scenarios/join-and-watch'),
  'active-participant': require('./scenarios/active-participant'),
  'presenter': require('./scenarios/presenter'),
};

/**
 * Load Test Orchestrator
 * Implements linear ramp-up from 0 to N users over T seconds.
 */
async function run() {
  console.log('=== Virtual Meetup Platform Load Test ===');
  console.log(`Target API: ${config.apiUrl}`);
  console.log(`Target WS:  ${config.wsUrl}`);
  console.log(`Users: ${config.totalUsers}, Ramp-up: ${config.rampUpSeconds}s, Hold: ${config.holdSeconds}s`);
  console.log('');

  const report = new Report();
  report.start();

  const userPromises = [];
  const delayPerUser = (config.rampUpSeconds * 1000) / config.totalUsers;

  // Assign scenarios based on distribution
  const scenarioAssignments = buildScenarioAssignments(config.totalUsers, config.scenarios);

  for (let i = 0; i < config.totalUsers; i++) {
    const delay = i * delayPerUser;
    const scenarioName = scenarioAssignments[i];
    const scenario = scenarios[scenarioName];

    const promise = sleep(delay).then(async () => {
      const user = new VirtualUser(i, config, report);
      try {
        await scenario.execute(user, config);
      } catch (err) {
        // Error already recorded in report via VirtualUser
      } finally {
        await user.disconnect();
      }
    });

    userPromises.push(promise);
  }

  await Promise.all(userPromises);

  // Hold period (users already running their scenarios include idle time)
  report.end();

  // Output results
  report.printConsoleTable();

  if (config.outputJson) {
    report.writeJsonReport(config.outputJson);
  }

  // Check thresholds for CI
  const passed = report.checkThresholds(config);
  if (!passed) {
    console.error('\nLoad test FAILED - thresholds exceeded');
    process.exit(1);
  }

  console.log('\nLoad test PASSED');
}

function buildScenarioAssignments(totalUsers, distribution) {
  const assignments = [];
  const entries = Object.entries(distribution);

  for (const [name, pct] of entries) {
    const count = Math.round((pct / 100) * totalUsers);
    for (let i = 0; i < count; i++) {
      assignments.push(name);
    }
  }

  // Fill remaining slots with the first scenario
  while (assignments.length < totalUsers) {
    assignments.push(entries[0][0]);
  }

  // Shuffle for realistic distribution
  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }

  return assignments;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run if executed directly
if (require.main === module) {
  run().catch(err => {
    console.error('Load test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };

'use strict';

const { RemovalPolicy } = require('aws-cdk-lib');

/**
 * Environment-aware naming and lifecycle helpers.
 *
 * Every stack used to hardcode physical resource names ("VirtualMeetupTable",
 * "VirtualMeetup-EventCrud", ...), which made it impossible to deploy two
 * environments (dev + prod) into the same account — the second deploy
 * collides on every named resource. All physical names now flow through
 * withEnv() so each environment gets its own namespace.
 *
 * Stateful resources (DynamoDB tables, the Cognito user pool, the recordings
 * bucket) also switch to RETAIN in prod via dataRemovalPolicy(): a stack
 * delete or a CloudFormation replacement must never take user accounts,
 * events, or recordings with it. Dev keeps DESTROY so `cdk destroy` stays a
 * clean teardown.
 */

function envName(scope) {
  return scope.node.tryGetContext('env') || 'dev';
}

function isProd(scope) {
  return envName(scope) === 'prod';
}

/** Suffix a physical resource name with the environment. */
function withEnv(scope, baseName) {
  return `${baseName}-${envName(scope)}`;
}

/**
 * Removal policy for stateful resources: RETAIN in prod, DESTROY elsewhere.
 */
function dataRemovalPolicy(scope) {
  return isProd(scope) ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

/**
 * EventBridge Scheduler group name. Shared between EmailStack (creates the
 * group), ApiStack (scopes IAM to it and passes it to Lambdas via the
 * SCHEDULER_GROUP_NAME env var), and lambda/shared/scheduler-utils.js
 * (creates/deletes schedules inside it at runtime).
 */
function schedulerGroupName(scope) {
  return withEnv(scope, 'VirtualMeetup-Reminders');
}

module.exports = {
  envName,
  isProd,
  withEnv,
  dataRemovalPolicy,
  schedulerGroupName,
};

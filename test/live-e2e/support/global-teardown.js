'use strict';

const { teardownPersonas } = require('./personas');

// Always deletes the disposable personas, even if specs failed — leaving
// test accounts (esp. organizer-role) in the pool is a security smell.
module.exports = async () => {
  console.log('[live-e2e] deleting disposable personas');
  await teardownPersonas();
  console.log('[live-e2e] teardown complete');
};

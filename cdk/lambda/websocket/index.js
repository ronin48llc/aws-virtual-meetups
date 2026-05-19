'use strict';

/**
 * WebSocket Lambda handlers - re-exports for connect, disconnect, and broadcast.
 * Each route ($connect, $disconnect) has its own handler file.
 * The broadcast utility is shared across signaling handlers.
 * @module websocket
 */

const connect = require('./connect');
const disconnect = require('./disconnect');
const { broadcast, getConnectionsForEvent } = require('./broadcast');

module.exports = {
  connectHandler: connect.handler,
  disconnectHandler: disconnect.handler,
  broadcast,
  getConnectionsForEvent,
};

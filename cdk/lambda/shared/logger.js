'use strict';

/**
 * Shared structured logging utility for the Virtual Meetup Platform.
 * Emits JSON-formatted log entries with consistent fields for CloudWatch Logs Insights queries.
 * @module shared/logger
 */

/**
 * Emit a structured JSON log entry.
 * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG).
 * @param {string} message - Human-readable log message.
 * @param {Object} [context={}] - Contextual fields for the log entry.
 * @param {string} [context.requestId] - API Gateway request ID (correlation ID).
 * @param {string} [context.eventId] - Virtual meetup event ID.
 * @param {string} [context.userId] - User identifier.
 * @param {string} [context.action] - Action being performed (e.g., 'raiseHand', 'createEvent').
 * @param {number} [context.duration] - Duration in milliseconds.
 * @param {string|Object} [context.error] - Error message or object.
 * @param {string} [context.previousState] - Previous state for state transitions.
 * @param {string} [context.newState] - New state for state transitions.
 * @param {Object} [context.extra] - Additional fields to include.
 */
function log(level, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    requestId: context.requestId || undefined,
    eventId: context.eventId || undefined,
    userId: context.userId || undefined,
    action: context.action || undefined,
    duration: context.duration || undefined,
    error: context.error || undefined,
    previousState: context.previousState || undefined,
    newState: context.newState || undefined,
  };

  // Merge any extra fields
  if (context.extra && typeof context.extra === 'object') {
    Object.assign(entry, context.extra);
  }

  // Remove undefined fields for cleaner output
  const cleanEntry = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) {
      cleanEntry[key] = value;
    }
  }

  console.log(JSON.stringify(cleanEntry));
}

/**
 * Log at INFO level.
 * @param {string} message - Log message.
 * @param {Object} [context={}] - Contextual fields.
 */
function info(message, context = {}) {
  log('INFO', message, context);
}

/**
 * Log at WARN level.
 * @param {string} message - Log message.
 * @param {Object} [context={}] - Contextual fields.
 */
function warn(message, context = {}) {
  log('WARN', message, context);
}

/**
 * Log at ERROR level.
 * @param {string} message - Log message.
 * @param {Object} [context={}] - Contextual fields.
 */
function error(message, context = {}) {
  log('ERROR', message, context);
}

/**
 * Log at DEBUG level.
 * @param {string} message - Log message.
 * @param {Object} [context={}] - Contextual fields.
 */
function debug(message, context = {}) {
  log('DEBUG', message, context);
}

/**
 * Log a state transition with previous and new state.
 * @param {string} action - The action causing the transition.
 * @param {Object} context - Context including eventId, userId, previousState, newState.
 */
function stateTransition(action, context = {}) {
  log('INFO', `State transition: ${action}`, {
    ...context,
    action,
  });
}

/**
 * Create a logger instance bound to a specific request context.
 * Useful for propagating requestId (correlation ID) through a handler.
 * @param {Object} event - API Gateway event (REST or WebSocket).
 * @returns {Object} Logger instance with bound requestId.
 */
function createLogger(event) {
  const requestId = extractRequestId(event);

  return {
    info: (message, context = {}) => info(message, { ...context, requestId }),
    warn: (message, context = {}) => warn(message, { ...context, requestId }),
    error: (message, context = {}) => error(message, { ...context, requestId }),
    debug: (message, context = {}) => debug(message, { ...context, requestId }),
    stateTransition: (action, context = {}) => stateTransition(action, { ...context, requestId }),
    requestId,
  };
}

/**
 * Extract the API Gateway request ID from an event for use as correlation ID.
 * Supports both REST API and WebSocket API event formats.
 * @param {Object} event - API Gateway event.
 * @returns {string|undefined} The request ID or undefined.
 */
function extractRequestId(event) {
  if (!event || !event.requestContext) {
    return undefined;
  }
  // REST API: event.requestContext.requestId
  // WebSocket API: event.requestContext.requestId
  return event.requestContext.requestId || undefined;
}

module.exports = {
  info,
  warn,
  error,
  debug,
  stateTransition,
  createLogger,
  extractRequestId,
};

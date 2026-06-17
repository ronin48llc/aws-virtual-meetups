'use strict';

/**
 * Standard API response builders for the Virtual Meetup Platform.
 * All responses include CORS headers for SPA access.
 * @module shared/response
 */

const { CORS_HEADERS } = require('./constants');

/**
 * Build a standard API Gateway response object.
 * @param {number} statusCode - HTTP status code.
 * @param {Object|string} body - Response body (will be JSON-stringified if object).
 * @param {Object} [extraHeaders={}] - Additional headers to include.
 * @returns {Object} API Gateway response object.
 */
function buildResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * 200 OK response.
 * @param {Object} data - Response payload.
 * @returns {Object} API Gateway response.
 */
function success(data) {
  return buildResponse(200, data);
}

/**
 * 201 Created response.
 * @param {Object} data - Response payload.
 * @returns {Object} API Gateway response.
 */
function created(data) {
  return buildResponse(201, data);
}

/**
 * 400 Bad Request response.
 * @param {string} message - Error description.
 * @returns {Object} API Gateway response.
 */
function badRequest(message) {
  return buildResponse(400, { error: 'Bad Request', message });
}

/**
 * 401 Unauthorized response.
 * @param {string} [message='Authentication required'] - Error description.
 * @returns {Object} API Gateway response.
 */
function unauthorized(message = 'Authentication required') {
  return buildResponse(401, { error: 'Unauthorized', message });
}

/**
 * 403 Forbidden response.
 * @param {string} [message='Access denied'] - Error description.
 * @returns {Object} API Gateway response.
 */
function forbidden(message = 'Access denied') {
  return buildResponse(403, { error: 'Forbidden', message });
}

/**
 * 404 Not Found response.
 * @param {string} [message='Resource not found'] - Error description.
 * @returns {Object} API Gateway response.
 */
function notFound(message = 'Resource not found') {
  return buildResponse(404, { error: 'Not Found', message });
}

/**
 * 429 Too Many Requests response.
 * @param {string} [message='Too many requests. Try again later.'] - Error description.
 * @returns {Object} API Gateway response.
 */
function tooManyRequests(message = 'Too many requests. Try again later.') {
  return buildResponse(429, { error: 'Too Many Requests', message });
}

/**
 * 500 Internal Server Error response.
 * @param {string} [message='Internal server error'] - Error description.
 * @returns {Object} API Gateway response.
 */
function serverError(message = 'Internal server error') {
  return buildResponse(500, { error: 'Internal Server Error', message });
}

module.exports = {
  buildResponse,
  success,
  created,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  tooManyRequests,
  serverError,
};

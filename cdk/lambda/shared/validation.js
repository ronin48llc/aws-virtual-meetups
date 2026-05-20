'use strict';

/**
 * Input validation helpers for the Virtual Meetup Platform.
 * @module shared/validation
 */

/**
 * Custom error class for validation failures.
 * Allows callers to distinguish validation errors from unexpected errors.
 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate that all required fields are present and non-empty in an object.
 * @param {Object} obj - The object to validate.
 * @param {string[]} fields - Array of required field names.
 * @returns {{ valid: boolean, missing: string[] }} Validation result with list of missing fields.
 */
function validateRequiredFields(obj, fields) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, missing: fields };
  }

  const missing = fields.filter((field) => {
    const value = obj[field];
    return value === undefined || value === null || value === '';
  });

  return { valid: missing.length === 0, missing };
}

/**
 * Check if a date string represents a future date.
 * @param {string} dateStr - ISO 8601 date string to check.
 * @returns {boolean} True if the date is in the future.
 */
function isFutureDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return false;
  }
  return date.getTime() > Date.now();
}

/**
 * Check if a date string is a valid ISO 8601 date.
 * @param {string} dateStr - The date string to validate.
 * @returns {boolean} True if the string is a valid date.
 */
function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return false;
  }
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

/**
 * Validate an email address format.
 * Uses a practical regex that covers standard email formats.
 * @param {string} email - The email address to validate.
 * @returns {boolean} True if the email format is valid.
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Validate a string length is within bounds.
 * @param {string} str - The string to validate.
 * @param {number} min - Minimum length (inclusive).
 * @param {number} max - Maximum length (inclusive).
 * @returns {boolean} True if the string length is within bounds.
 */
function isValidLength(str, min, max) {
  if (!str || typeof str !== 'string') {
    return false;
  }
  const len = str.trim().length;
  return len >= min && len <= max;
}

/**
 * Sanitize a string by trimming whitespace and removing control characters.
 * @param {string} str - The string to sanitize.
 * @returns {string} The sanitized string.
 */
function sanitize(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  return str.trim().replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Parse and validate a JSON request body.
 * @param {string|Object} body - The request body (string or already-parsed object).
 * @returns {{ valid: boolean, data: Object|null, error: string|null }} Parse result.
 */
function parseBody(body) {
  if (!body) {
    return { valid: false, data: null, error: 'Request body is empty' };
  }

  if (typeof body === 'object') {
    return { valid: true, data: body, error: null };
  }

  try {
    const data = JSON.parse(body);
    return { valid: true, data, error: null };
  } catch (_err) {
    return { valid: false, data: null, error: 'Invalid JSON in request body' };
  }
}

/**
 * Compute derived duration fields from scheduledStart and request data.
 * Enforces mutual exclusivity of scheduledEnd and durationMinutes.
 *
 * @param {string} scheduledStart - ISO 8601 start time.
 * @param {Object} data - Request body with optional scheduledEnd or durationMinutes.
 * @returns {{ scheduledEnd: string, durationMinutes: number } | null} Computed values or null for open-ended.
 * @throws {ValidationError} If both scheduledEnd and durationMinutes are provided.
 */
function computeDurationFields(scheduledStart, data) {
  if (data.scheduledEnd && data.durationMinutes) {
    throw new ValidationError('Only one of scheduledEnd or durationMinutes may be provided');
  }
  if (data.scheduledEnd) {
    const start = new Date(scheduledStart).getTime();
    const end = new Date(data.scheduledEnd).getTime();
    return { scheduledEnd: data.scheduledEnd, durationMinutes: Math.round((end - start) / 60000) };
  }
  if (data.durationMinutes) {
    const start = new Date(scheduledStart).getTime();
    const end = new Date(start + data.durationMinutes * 60000).toISOString();
    return { scheduledEnd: end, durationMinutes: data.durationMinutes };
  }
  return null; // open-ended
}

/**
 * Validate duration fields.
 * @param {string} scheduledEnd - ISO 8601 end time.
 * @param {number} durationMinutes - Duration in minutes.
 * @param {string} scheduledStart - ISO 8601 start time.
 * @returns {{ valid: boolean, error: string | null }}
 */
function validateDurationFields(scheduledEnd, durationMinutes, scheduledStart) {
  // Validate scheduledEnd is a valid ISO 8601 date
  const endDate = new Date(scheduledEnd);
  if (!scheduledEnd || typeof scheduledEnd !== 'string' || isNaN(endDate.getTime())) {
    return { valid: false, error: 'scheduledEnd must be a valid ISO 8601 date' };
  }

  // Validate scheduledEnd is after scheduledStart
  const startDate = new Date(scheduledStart);
  if (endDate.getTime() <= startDate.getTime()) {
    return { valid: false, error: 'scheduledEnd must be after scheduledStart' };
  }

  // Validate durationMinutes is a positive integer
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    return { valid: false, error: 'durationMinutes must be a positive integer' };
  }

  // Validate durationMinutes does not exceed 480
  if (durationMinutes > 480) {
    return { valid: false, error: 'durationMinutes must not exceed 480 (8 hours)' };
  }

  return { valid: true, error: null };
}

module.exports = {
  ValidationError,
  validateRequiredFields,
  isFutureDate,
  isValidDate,
  isValidEmail,
  isValidLength,
  sanitize,
  parseBody,
  computeDurationFields,
  validateDurationFields,
};

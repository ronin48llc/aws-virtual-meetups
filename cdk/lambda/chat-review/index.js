'use strict';

/**
 * IVS Chat Message Review Handler
 * 
 * Receives IVS Chat message review events and returns ALLOW or DENY decisions.
 * Rejects messages that:
 * - Exceed 500 characters
 * - Contain base64 data patterns (e.g., data:image/...;base64,)
 * - Contain URLs matching a configurable blocklist
 * 
 * Environment Variables:
 * - URL_BLOCKLIST: Comma-separated list of domain patterns to block
 *   (e.g., "drive.google.com,dropbox.com,wetransfer.com,mega.nz")
 */

const MAX_MESSAGE_LENGTH = 500;

// Base64 data URI pattern: data:<mediatype>;base64,<data>
const BASE64_DATA_URI_PATTERN = /data:[a-z0-9+\-./]+;base64,/i;

// Long base64 string pattern: 50+ consecutive base64 characters containing
// a mix of uppercase and lowercase (indicating encoded binary data, not normal text)
const LONG_BASE64_PATTERN = /(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])[A-Za-z0-9+/=]{50,}/;

/**
 * Escape special regex characters in a string
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for use in RegExp
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, (match) => '\\' + match);
}

/**
 * Parse URL blocklist from environment variable
 * @returns {RegExp[]} Array of regex patterns for blocked URLs
 */
function getUrlBlocklist() {
  const blocklist = process.env.URL_BLOCKLIST || '';
  if (!blocklist.trim()) {
    return [];
  }

  return blocklist
    .split(',')
    .map(pattern => pattern.trim())
    .filter(pattern => pattern.length > 0)
    .map(pattern => {
      const escaped = escapeRegex(pattern);
      return new RegExp(escaped, 'i');
    });
}

/**
 * Check if message contains any blocked URLs
 * @param {string} content - Message content
 * @param {RegExp[]} blocklist - Array of blocked URL patterns
 * @returns {boolean} True if message contains a blocked URL
 */
function containsBlockedUrl(content, blocklist) {
  // First check if the message contains any URL-like pattern
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urls = content.match(urlPattern);

  if (!urls || urls.length === 0) {
    // Also check for domain references without protocol
    for (const pattern of blocklist) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }

  for (const url of urls) {
    for (const pattern of blocklist) {
      if (pattern.test(url)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if message contains base64 data patterns
 * @param {string} content - Message content
 * @returns {boolean} True if message contains base64 data
 */
function containsBase64Data(content) {
  if (BASE64_DATA_URI_PATTERN.test(content)) {
    return true;
  }
  if (LONG_BASE64_PATTERN.test(content)) {
    return true;
  }
  return false;
}

/**
 * IVS Chat Message Review Handler
 * 
 * Event format:
 * {
 *   "Content": "message text",
 *   "MessageId": "...",
 *   "RoomArn": "...",
 *   "Attributes": {...},
 *   "SenderId": "..."
 * }
 * 
 * Response format:
 * {
 *   "ReviewResult": "ALLOW" | "DENY",
 *   "Content": "original or modified content"
 * }
 */
exports.handler = async (event) => {
  const content = event.Content || '';

  // Check message length
  if (content.length > MAX_MESSAGE_LENGTH) {
    console.log(`Message rejected: exceeds ${MAX_MESSAGE_LENGTH} characters (${content.length} chars)`);
    return {
      ReviewResult: 'DENY',
      Content: content,
    };
  }

  // Check for base64 data patterns
  if (containsBase64Data(content)) {
    console.log('Message rejected: contains base64 data pattern');
    return {
      ReviewResult: 'DENY',
      Content: content,
    };
  }

  // Check URL blocklist
  const blocklist = getUrlBlocklist();
  if (blocklist.length > 0 && containsBlockedUrl(content, blocklist)) {
    console.log('Message rejected: contains blocked URL');
    return {
      ReviewResult: 'DENY',
      Content: content,
    };
  }

  // Message passes all checks
  return {
    ReviewResult: 'ALLOW',
    Content: content,
  };
};

// Export internal functions for testing
exports._internals = {
  MAX_MESSAGE_LENGTH,
  getUrlBlocklist,
  containsBlockedUrl,
  containsBase64Data,
  escapeRegex,
  BASE64_DATA_URI_PATTERN,
  LONG_BASE64_PATTERN,
};

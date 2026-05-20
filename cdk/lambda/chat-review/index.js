'use strict';

/**
 * IVS Chat Message Review Handler
 *
 * Receives IVS Chat message review events and returns ALLOW or DENY decisions.
 * Rejects messages that:
 * - Exceed 500 characters
 * - Contain base64 data patterns (e.g., data:image/...;base64,)
 * - Contain blocklisted domain references anywhere in the content
 *
 * Environment Variables:
 * - URL_BLOCKLIST: Comma-separated list of domain patterns to block
 *   (e.g., "drive.google.com,dropbox.com,wetransfer.com,mega.nz")
 *
 * The blocklist is compiled once at module load and cached for the lifetime of
 * the Lambda execution environment. To pick up a new blocklist, redeploy.
 */

const MAX_MESSAGE_LENGTH = 500;

// Base64 data URI pattern: data:<mediatype>;base64,<data>
const BASE64_DATA_URI_PATTERN = /data:[a-z0-9+\-./]+;base64,/i;

// Long base64 string pattern: 50+ consecutive base64 characters containing
// a mix of uppercase and lowercase (indicating encoded binary data, not normal text)
const LONG_BASE64_PATTERN = /(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])[A-Za-z0-9+/=]{50,}/;

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, (match) => '\\' + match);
}

/**
 * Parse URL blocklist from environment variable. Called once at module load.
 */
function getUrlBlocklist() {
  const blocklist = process.env.URL_BLOCKLIST || '';
  if (!blocklist.trim()) {
    return [];
  }

  return blocklist
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => new RegExp(escapeRegex(pattern), 'i'));
}

// Issue #95: cache the compiled blocklist at module load. The previous
// implementation recompiled on every invocation, which both wastes work on
// chatty rooms and made the bare-domain check easy to bypass (see below).
const CACHED_BLOCKLIST = getUrlBlocklist();

/**
 * Issue #95: scan the full message content against the blocklist.
 *
 * The previous implementation extracted http(s) URLs first and only scanned
 * those — falling back to a bare-content scan ONLY when zero URLs were
 * present. That created a trivial bypass: pad any blocked bare-domain
 * reference with any unrelated URL, e.g.
 *   "http://example.com  drive.google.com/evil"
 * which had URLs and so skipped the bare-domain scan entirely.
 *
 * The blocklist is already authored as substring patterns (e.g.
 * "drive.google.com"), so the correct semantics are "deny if the pattern
 * appears anywhere in the message." That's a single regex test per pattern.
 *
 * @param {string} content - Full message content (unmodified).
 * @param {RegExp[]} blocklist - Compiled blocklist (defaults to module cache).
 * @returns {boolean} True if any pattern matches the content.
 */
function containsBlockedUrl(content, blocklist = CACHED_BLOCKLIST) {
  for (const pattern of blocklist) {
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

function containsBase64Data(content) {
  if (BASE64_DATA_URI_PATTERN.test(content)) {
    return true;
  }
  if (LONG_BASE64_PATTERN.test(content)) {
    return true;
  }
  return false;
}

exports.handler = async (event) => {
  const content = event.Content || '';

  if (content.length > MAX_MESSAGE_LENGTH) {
    console.log(`Message rejected: exceeds ${MAX_MESSAGE_LENGTH} characters (${content.length} chars)`);
    return { ReviewResult: 'DENY', Content: content };
  }

  if (containsBase64Data(content)) {
    console.log('Message rejected: contains base64 data pattern');
    return { ReviewResult: 'DENY', Content: content };
  }

  if (CACHED_BLOCKLIST.length > 0 && containsBlockedUrl(content)) {
    console.log('Message rejected: contains blocked URL');
    return { ReviewResult: 'DENY', Content: content };
  }

  return { ReviewResult: 'ALLOW', Content: content };
};

exports._internals = {
  MAX_MESSAGE_LENGTH,
  getUrlBlocklist,
  containsBlockedUrl,
  containsBase64Data,
  escapeRegex,
  BASE64_DATA_URI_PATTERN,
  LONG_BASE64_PATTERN,
  CACHED_BLOCKLIST,
};

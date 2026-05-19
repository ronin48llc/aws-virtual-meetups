'use strict';

/**
 * Frontend Smoke Tests
 * Validates CloudFront distribution, SPA routing, and static assets.
 */
async function run(config, { pass, fail, skip, withRetry }) {
  if (!config.cloudFrontUrl) {
    skip('Frontend tests', 'cloudFrontUrl not configured');
    return;
  }

  const baseUrl = config.cloudFrontUrl.replace(/\/$/, '');

  // Test CloudFront URL returns 200 with HTML
  try {
    await withRetry(async () => {
      const res = await fetch(baseUrl);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) throw new Error(`Expected text/html, got ${contentType}`);
      const body = await res.text();
      if (!body.includes('<html') && !body.includes('<!DOCTYPE')) {
        throw new Error('Response does not contain HTML');
      }
    }, config, 'CloudFront root');
    pass('CloudFront URL returns 200 with HTML');
  } catch (err) {
    fail('CloudFront URL returns 200 with HTML', err);
  }

  // Test SPA routing - any path returns index.html (not 404)
  try {
    const res = await fetch(`${baseUrl}/events/some-event-id`);
    if (res.status === 200) {
      const body = await res.text();
      if (body.includes('<html') || body.includes('<!DOCTYPE')) {
        pass('SPA routing returns index.html for deep paths');
      } else {
        fail('SPA routing returns index.html for deep paths', new Error('Response is not HTML'));
      }
    } else if (res.status === 404) {
      fail('SPA routing returns index.html for deep paths', new Error('Got 404 - SPA routing not configured'));
    } else {
      pass('SPA routing returns response for deep paths');
    }
  } catch (err) {
    fail('SPA routing returns index.html for deep paths', err);
  }

  // Test static assets - CSS
  try {
    const res = await fetch(`${baseUrl}/css/styles.css`);
    if (res.status === 200) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('css')) {
        pass('Static CSS asset accessible with correct content-type');
      } else {
        pass('Static CSS asset accessible');
      }
    } else {
      fail('Static CSS asset accessible', new Error(`Got ${res.status}`));
    }
  } catch (err) {
    fail('Static CSS asset accessible', err);
  }

  // Test static assets - JS
  try {
    const res = await fetch(`${baseUrl}/js/app.js`);
    if (res.status === 200) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('javascript')) {
        pass('Static JS asset accessible with correct content-type');
      } else {
        pass('Static JS asset accessible');
      }
    } else {
      fail('Static JS asset accessible', new Error(`Got ${res.status}`));
    }
  } catch (err) {
    fail('Static JS asset accessible', err);
  }
}

module.exports = { run };

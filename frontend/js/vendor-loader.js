'use strict';

// Dynamically load the IVS Chat Messaging SDK and expose it on
// window.IVSChat. This lives in a same-origin file (rather than inline
// in index.html) so the CloudFront CSP can disallow inline scripts.
//
// NOTE: browsers do not apply Subresource Integrity to dynamic
// import() calls without an import map — locking down the chat SDK
// is tracked as a follow-up.
(async function() {
  try {
    var module = await import('https://cdn.jsdelivr.net/npm/amazon-ivs-chat-messaging@1/+esm');
    window.IVSChat = module;
  } catch (e) {
    console.warn('Failed to load IVS Chat SDK:', e);
  }
})();

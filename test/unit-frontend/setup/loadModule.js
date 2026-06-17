'use strict';

/**
 * Loads a frontend browser-script module into the current jsdom realm and
 * returns the symbol it defines — without modifying anything under frontend/.
 *
 * The frontend modules are plain <script> files that assign their public API
 * to a top-level binding (e.g. `const Fingerprint = (() => {...})()`). Such a
 * binding is reachable by sibling scripts in a browser, but a Node `require`
 * cannot see it because the file has no `module.exports`. We reproduce the
 * browser behaviour by wrapping the source in a function whose final statement
 * returns the binding. Free identifiers in the source (`document`, `navigator`,
 * `screen`, `WebSocket`, `crypto`, ...) resolve against the jsdom globals Jest
 * installs, so the code runs exactly as it would in the page.
 *
 * Each call re-evaluates the source, giving every test a fresh module instance
 * (important for the singleton state inside websocket.js).
 *
 * @param {string} fileName   File under frontend/js, e.g. 'fingerprint.js'
 * @param {string} exportName The top-level symbol to return, e.g. 'Fingerprint'
 * @returns {*} the module's public API object
 */
const fs = require('fs');
const path = require('path');

const FRONTEND_JS = path.resolve(__dirname, '..', '..', '..', 'frontend', 'js');

function loadModule(fileName, exportName) {
  const src = fs.readFileSync(path.join(FRONTEND_JS, fileName), 'utf8');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `${src}\n;return typeof ${exportName} !== 'undefined' ? ${exportName} : undefined;`
  );
  const mod = factory();
  if (mod === undefined) {
    throw new Error(`loadModule: '${exportName}' was not defined by ${fileName}`);
  }
  return mod;
}

module.exports = { loadModule, FRONTEND_JS };

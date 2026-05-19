/**
 * Auth Module — Cognito SDK Integration
 *
 * Provides sign-in, sign-up, sign-out, token management,
 * and user state using amazon-cognito-identity-js (loaded via CDN).
 */

const Auth = (() => {
  // Configuration — set these after deployment
  const CONFIG = {
    UserPoolId: window.COGNITO_USER_POOL_ID || '',
    ClientId: window.COGNITO_CLIENT_ID || '',
  };

  const TOKEN_KEYS = {
    idToken: 'meetup_id_token',
    accessToken: 'meetup_access_token',
    refreshToken: 'meetup_refresh_token',
    user: 'meetup_user',
  };

  let currentUser = null;
  let userPool = null;
  const listeners = [];

  /**
   * Initialize the auth module. Must be called after Cognito SDK is loaded.
   */
  function init() {
    if (typeof AmazonCognitoIdentity === 'undefined') {
      console.warn('Auth: amazon-cognito-identity-js not loaded. Auth features disabled.');
      return;
    }

    if (!CONFIG.UserPoolId || !CONFIG.ClientId) {
      console.warn('Auth: Cognito configuration missing. Set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID.');
      return;
    }

    userPool = new AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: CONFIG.UserPoolId,
      ClientId: CONFIG.ClientId,
    });

    // Restore session from stored tokens
    _restoreSession();
  }

  /**
   * Sign up a new user with email and password.
   * @param {string} email
   * @param {string} password
   * @param {string} displayName
   * @returns {Promise<object>} The sign-up result
   */
  function signUp(email, password, displayName) {
    return new Promise((resolve, reject) => {
      if (!userPool) {
        return reject(new Error('Auth not initialized'));
      }

      const attributes = [
        new AmazonCognitoIdentity.CognitoUserAttribute({
          Name: 'email',
          Value: email,
        }),
      ];

      if (displayName) {
        // Store displayName in the email attribute's nickname or just skip
        // custom:displayName is not in the User Pool schema
      }

      userPool.signUp(email, password, attributes, null, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  }

  /**
   * Confirm sign-up with verification code.
   * @param {string} email
   * @param {string} code
   * @returns {Promise<void>}
   */
  function confirmSignUp(email, code) {
    return new Promise((resolve, reject) => {
      if (!userPool) {
        return reject(new Error('Auth not initialized'));
      }

      const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.confirmRegistration(code, true, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  }

  /**
   * Sign in with email and password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<object>} The authenticated user info
   */
  function signIn(email, password) {
    return new Promise((resolve, reject) => {
      if (!userPool) {
        return reject(new Error('Auth not initialized'));
      }

      const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
        Username: email,
        Password: password,
      });

      const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
        Username: email,
        Pool: userPool,
      });

      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          _storeSession(session, email);
          _notifyListeners();
          resolve(getCurrentUser());
        },
        onFailure: (err) => {
          reject(err);
        },
        newPasswordRequired: () => {
          reject(new Error('New password required. Please contact support.'));
        },
      });
    });
  }

  /**
   * Sign out the current user.
   */
  function signOut() {
    if (userPool) {
      const cognitoUser = userPool.getCurrentUser();
      if (cognitoUser) {
        cognitoUser.signOut();
      }
    }

    _clearSession();
    _notifyListeners();
  }

  /**
   * Get the current authenticated user info.
   * @returns {object|null} User object with email and tokens, or null
   */
  function getCurrentUser() {
    if (currentUser) {
      return { ...currentUser };
    }

    const stored = localStorage.getItem(TOKEN_KEYS.user);
    if (stored) {
      try {
        currentUser = JSON.parse(stored);
        return { ...currentUser };
      } catch (e) {
        _clearSession();
      }
    }

    return null;
  }

  /**
   * Check if a user is currently authenticated.
   * @returns {boolean}
   */
  function isAuthenticated() {
    const user = getCurrentUser();
    if (!user || !user.idToken) {
      return false;
    }

    // Check token expiry
    try {
      const payload = _decodeToken(user.idToken);
      const now = Math.floor(Date.now() / 1000);
      return payload.exp > now;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the current ID token for API calls.
   * @returns {string|null}
   */
  function getIdToken() {
    const user = getCurrentUser();
    return user ? user.idToken : null;
  }

  /**
   * Get the current access token.
   * @returns {string|null}
   */
  function getAccessToken() {
    const user = getCurrentUser();
    return user ? user.accessToken : null;
  }

  /**
   * Register a listener for auth state changes.
   * @param {function} callback
   */
  function onAuthStateChange(callback) {
    if (typeof callback === 'function') {
      listeners.push(callback);
    }
  }

  /**
   * Remove an auth state change listener.
   * @param {function} callback
   */
  function offAuthStateChange(callback) {
    const idx = listeners.indexOf(callback);
    if (idx > -1) {
      listeners.splice(idx, 1);
    }
  }

  // --- Private helpers ---

  function _storeSession(session, email) {
    const idToken = session.getIdToken().getJwtToken();
    const accessToken = session.getAccessToken().getJwtToken();
    const refreshToken = session.getRefreshToken().getToken();

    const payload = _decodeToken(idToken);

    currentUser = {
      email: email || payload.email || '',
      displayName: payload['custom:displayName'] || payload.email || email,
      sub: payload.sub,
      idToken,
      accessToken,
      refreshToken,
    };

    localStorage.setItem(TOKEN_KEYS.idToken, idToken);
    localStorage.setItem(TOKEN_KEYS.accessToken, accessToken);
    localStorage.setItem(TOKEN_KEYS.refreshToken, refreshToken);
    localStorage.setItem(TOKEN_KEYS.user, JSON.stringify(currentUser));
  }

  function _restoreSession() {
    const stored = localStorage.getItem(TOKEN_KEYS.user);
    if (stored) {
      try {
        currentUser = JSON.parse(stored);
        // Validate token hasn't expired
        if (!isAuthenticated()) {
          _clearSession();
        }
      } catch (e) {
        _clearSession();
      }
    }
  }

  function _clearSession() {
    currentUser = null;
    localStorage.removeItem(TOKEN_KEYS.idToken);
    localStorage.removeItem(TOKEN_KEYS.accessToken);
    localStorage.removeItem(TOKEN_KEYS.refreshToken);
    localStorage.removeItem(TOKEN_KEYS.user);
  }

  function _decodeToken(token) {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  }

  function _notifyListeners() {
    const user = getCurrentUser();
    listeners.forEach((cb) => {
      try {
        cb(user);
      } catch (e) {
        console.error('Auth listener error:', e);
      }
    });
  }

  // Public API
  return {
    init,
    signUp,
    confirmSignUp,
    signIn,
    signOut,
    getCurrentUser,
    isAuthenticated,
    getIdToken,
    getAccessToken,
    onAuthStateChange,
    offAuthStateChange,
  };
})();

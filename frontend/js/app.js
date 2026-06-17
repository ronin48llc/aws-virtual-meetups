/**
 * App Module — Client-Side Router & Application Shell
 *
 * Hash-based SPA router with page components for:
 *   /              — Home (event listing)
 *   /events/:id    — Event detail / landing page
 *   /events/:id/waiting — Waiting room
 *   /events/:id/live    — Live session
 *   /manage        — Manage events (authenticated)
 */

const App = (() => {
  const routes = [];
  let currentRoute = null;
  let appContainer = null;

  // --- Route definitions ---

  function defineRoutes() {
    route('/', HomePage);
    route('/events/:id', EventDetailPage);
    route('/events/:id/waiting', WaitingRoomPage);
    route('/events/:id/live', LiveSessionPage);
    route('/manage', ManageEventsPage);
    route('/profile', ProfilePage);
  }

  /**
   * Register a route pattern with a page component.
   * @param {string} pattern - URL pattern (supports :param)
   * @param {function} component - Page render function
   */
  function route(pattern, component) {
    const paramNames = [];
    const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({
      pattern,
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
      component,
    });
  }

  /**
   * Match a path against registered routes.
   * @param {string} path
   * @returns {object|null} { component, params }
   */
  function matchRoute(path) {
    for (const r of routes) {
      const match = path.match(r.regex);
      if (match) {
        const params = {};
        r.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        return { component: r.component, params };
      }
    }
    return null;
  }

  /**
   * Navigate to a path (updates hash and renders).
   * @param {string} path
   */
  function navigate(path) {
    window.location.hash = '#' + path;
  }

  /**
   * Get the current path from the hash.
   * @returns {string}
   */
  function getCurrentPath() {
    const hash = window.location.hash.slice(1) || '/';
    return hash.startsWith('/') ? hash : '/' + hash;
  }

  /**
   * Render the current route.
   */
  function render() {
    const path = getCurrentPath();

    // Prompt before leaving a live session
    const wasOnLive = currentRoute && currentRoute.path && currentRoute.path.includes('/live');
    const goingToLive = path.includes('/live');

    // Clean up live session when navigating away
    if (typeof LiveSession !== 'undefined' && wasOnLive) {
      LiveSession.disconnect();
    }

    // Clean up anonymous viewer when navigating away
    if (typeof AnonymousViewer !== 'undefined' && wasOnLive) {
      AnonymousViewer.disconnect();
    }

    const matched = matchRoute(path);

    if (matched) {
      currentRoute = { path, ...matched };
      appContainer.innerHTML = matched.component(matched.params);
    } else {
      currentRoute = null;
      appContainer.innerHTML = NotFoundPage();
    }

    updateNavActiveState(path);
  }

  /**
   * Update navigation link active states.
   * @param {string} path
   */
  function updateNavActiveState(path) {
    document.querySelectorAll('.nav__link').forEach((link) => {
      const href = link.getAttribute('data-route');
      if (href === path || (href === '/' && path === '/') || (href !== '/' && path.startsWith(href))) {
        link.classList.add('nav__link--active');
      } else {
        link.classList.remove('nav__link--active');
      }
    });

    // Update auth UI
    updateAuthUI();
  }

  /**
   * Update the auth section in the nav bar.
   */
  function updateAuthUI() {
    const authContainer = document.getElementById('nav-auth');
    if (!authContainer) return;

    // Show/hide Manage Events nav link based on role
    const manageLink = document.querySelector('[data-route="/manage"]');
    if (manageLink) {
      var isOrganizer = false;
      if (Auth.isAuthenticated()) {
        var user = Auth.getCurrentUser();
        if (user && user.idToken) {
          try {
            var payload = JSON.parse(atob(user.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            isOrganizer = payload['custom:role'] === 'organizer';
          } catch (e) {}
        }
      }
      manageLink.parentElement.style.display = isOrganizer ? '' : 'none';
    }

    if (Auth.isAuthenticated()) {
      const user = Auth.getCurrentUser();
      authContainer.innerHTML = `
        <a href="#/profile" class="nav__link" style="cursor: pointer; font-size: 13px;">${escapeHtml(user.displayName || user.email)}</a>
        <button class="btn btn--outline" style="color: white; border-color: rgba(255,255,255,0.3);" onclick="App.handleSignOut()">Sign Out</button>
      `;
    } else {
      authContainer.innerHTML = `
        <button class="btn btn--primary" onclick="App.showAuthModal('signin')">Sign In</button>
        <button class="btn btn--outline" style="color: white; border-color: rgba(255,255,255,0.3); margin-left: 8px;" onclick="App.showAuthModal('signup')">Sign Up</button>
      `;
    }
  }

  /**
   * Show the auth modal (sign-in or sign-up).
   * @param {string} mode - 'signin' or 'signup'
   */
  function showAuthModal(mode = 'signin') {
    const overlay = document.getElementById('auth-modal-overlay');
    if (!overlay) return;

    overlay.classList.add('modal-overlay--visible');
    renderAuthForm(mode);
  }

  /**
   * Hide the auth modal.
   */
  function hideAuthModal() {
    const overlay = document.getElementById('auth-modal-overlay');
    if (overlay) {
      overlay.classList.remove('modal-overlay--visible');
    }
  }

  /**
   * Render the auth form inside the modal.
   * @param {string} mode
   */
  function renderAuthForm(mode) {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;

    if (mode === 'signup') {
      modal.innerHTML = `
        <h2 class="modal__title">Create Account</h2>
        <div class="modal__error" id="auth-error"></div>
        <form id="auth-form" onsubmit="App.handleSignUp(event)">
          <div class="form-group">
            <label for="auth-name">Display Name</label>
            <input type="text" id="auth-name" class="form-input" placeholder="Your name" required>
          </div>
          <div class="form-group">
            <label for="auth-email">Email</label>
            <input type="email" id="auth-email" class="form-input" placeholder="you@example.com" required>
          </div>
          <div class="form-group">
            <label for="auth-password">Password</label>
            <input type="password" id="auth-password" class="form-input" placeholder="Min 8 characters" required minlength="8">
          </div>
          <div class="form-group">
            <label for="auth-password-confirm">Confirm Password</label>
            <input type="password" id="auth-password-confirm" class="form-input" placeholder="Re-enter password" required minlength="8">
          </div>
          <button type="submit" class="btn btn--primary" style="width: 100%;">Sign Up</button>
        </form>
        <div class="modal__toggle">
          Already have an account? <a onclick="App.showAuthModal('signin')">Sign In</a>
        </div>
        <div class="mt-md text-center">
          <button class="btn btn--sm" onclick="App.hideAuthModal()">Cancel</button>
        </div>
      `;
    } else {
      modal.innerHTML = `
        <h2 class="modal__title">Sign In</h2>
        <div class="modal__error" id="auth-error"></div>
        <form id="auth-form" onsubmit="App.handleSignIn(event)">
          <div class="form-group">
            <label for="auth-email">Email</label>
            <input type="email" id="auth-email" class="form-input" placeholder="you@example.com" required>
          </div>
          <div class="form-group">
            <label for="auth-password">Password</label>
            <input type="password" id="auth-password" class="form-input" placeholder="Your password" required>
          </div>
          <button type="submit" class="btn btn--primary" style="width: 100%;">Sign In</button>
        </form>
        <div class="modal__toggle" style="margin-top: 8px;">
          <a onclick="App.showForgotPassword()" style="cursor: pointer;">Forgot Password?</a>
        </div>
        <div class="modal__toggle">
          Don't have an account? <a onclick="App.showAuthModal('signup')">Sign Up</a>
        </div>
        <div class="mt-md text-center">
          <button class="btn btn--sm" onclick="App.hideAuthModal()">Cancel</button>
        </div>
      `;
    }
  }

  /**
   * Handle sign-in form submission.
   */
  async function handleSignIn(event) {
    event.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');

    try {
      await Auth.signIn(email, password);
      hideAuthModal();
      render();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Sign in failed';
        errorEl.style.display = 'block';
      }
    }
  }

  /**
   * Handle sign-up form submission.
   */
  async function handleSignUp(event) {
    event.preventDefault();
    const name = document.getElementById('auth-name').value;
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const passwordConfirm = document.getElementById('auth-password-confirm').value;
    const errorEl = document.getElementById('auth-error');

    // Validate password confirmation
    if (password !== passwordConfirm) {
      if (errorEl) {
        errorEl.textContent = 'Passwords do not match';
        errorEl.style.display = 'block';
      }
      return;
    }

    try {
      await Auth.signUp(email, password, name);
      // Show confirmation message
      const modal = document.getElementById('auth-modal');
      if (modal) {
        modal.innerHTML = `
          <h2 class="modal__title">Verify Email</h2>
          <p class="text-center mb-md">We sent a verification code to <strong>${escapeHtml(email)}</strong>. Enter it below to complete sign-up.</p>
          <div class="modal__error" id="auth-error"></div>
          <form onsubmit="App.handleConfirm(event, '${escapeHtml(email)}')">
            <div class="form-group">
              <label for="auth-code">Verification Code</label>
              <input type="text" id="auth-code" class="form-input" placeholder="123456" required>
            </div>
            <button type="submit" class="btn btn--primary" style="width: 100%;">Verify</button>
          </form>
          <div class="mt-md text-center">
            <button class="btn btn--sm" onclick="App.hideAuthModal()">Cancel</button>
          </div>
        `;
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Sign up failed';
        errorEl.style.display = 'block';
      }
    }
  }

  /**
   * Handle confirmation code submission.
   */
  async function handleConfirm(event, email) {
    event.preventDefault();
    const code = document.getElementById('auth-code').value;
    const errorEl = document.getElementById('auth-error');

    try {
      await Auth.confirmSignUp(email, code);
      hideAuthModal();
      showAuthModal('signin');
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Verification failed';
        errorEl.style.display = 'block';
      }
    }
  }

  /**
   * Handle sign-out.
   */
  function handleSignOut() {
    Auth.signOut();
    navigate('/');
  }

  // --- Page Components ---

  function HomePage() {
    // Only show "Create Event" for organizers
    var createBtn = '';
    if (Auth.isAuthenticated()) {
      var user = Auth.getCurrentUser();
      if (user && user.idToken) {
        try {
          var payload = JSON.parse(atob(user.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload['custom:role'] === 'organizer') {
            createBtn = '<a href="#/manage" class="btn btn--primary">Create Event</a>';
          }
        } catch (e) {}
      }
    }

    // Load events after render
    setTimeout(loadHomeEvents, 0);

    return `
      <div class="page-content">
        <div class="container">
          <section class="hero">
            <h1 class="hero__title">AWS Virtual Meetups</h1>
            <p class="hero__subtitle">Join live virtual meetups hosted by AWS user groups. Learn, connect, and grow with the community.</p>
            ${createBtn}
          </section>
          <section class="mt-lg">
            <input type="text" id="event-search" placeholder="Search events..." oninput="App.filterEvents()" style="width: 100%; max-width: 400px; padding: 10px 16px; border: 1px solid #D1D5DB; border-radius: 4px; font-size: 14px; margin-bottom: 16px;">
          </section>
          <section class="mt-lg">
            <h2>Popular Events</h2>
            <div class="grid grid--events mt-md" id="popular-events-list">
              <div class="card">
                <p class="card__description">Loading popular events...</p>
              </div>
            </div>
          </section>
          <section class="mt-lg">
            <h2>Live Now</h2>
            <div class="grid grid--events mt-md" id="events-live">
              <div class="card"><p class="card__description" style="color: #5a6b7b;">No live events right now.</p></div>
            </div>
          </section>
          <section class="mt-lg">
            <h2>Upcoming Events</h2>
            <div class="grid grid--events mt-md" id="events-list">
              <div class="card">
                <p class="card__description">Loading events...</p>
              </div>
            </div>
          </section>
          <section class="mt-lg">
            <h2>Past Events</h2>
            <div class="grid grid--events mt-md" id="events-past">
              <div class="card"><p class="card__description" style="color: #5a6b7b;">Loading past events...</p></div>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function renderEventCard(evt) {
    var startDate = evt.scheduledStart ? new Date(evt.scheduledStart).toLocaleString() : 'TBD';
    var eventUrl = '#/events/' + (evt.eventId || evt.id);
    var durationInfo = '';
    if (evt.durationMinutes) {
      durationInfo = '<p class="card__meta" style="color: #555;">Duration: ' + escapeHtml(formatDurationMinutes(evt.durationMinutes)) + '</p>';
    }
    var status = evt.status || 'scheduled';
    var badgeClass, badgeLabel;
    if (status === 'live' || status === 'staging') {
      badgeClass = 'badge--live';
      badgeLabel = '● LIVE';
    } else if (status === 'ended' || status === 'published') {
      badgeClass = 'badge--ended';
      badgeLabel = 'Past';
    } else {
      badgeClass = 'badge--upcoming';
      badgeLabel = 'Upcoming';
    }
    return '<div class="card">' +
      '<span class="badge ' + badgeClass + '">' + badgeLabel + '</span>' +
      '<h3 class="card__title mt-sm">' + escapeHtml(evt.title || 'Untitled') + '</h3>' +
      '<p class="card__meta">' + escapeHtml(startDate) + '</p>' +
      durationInfo +
      '<p class="card__description">' + escapeHtml(evt.description || '') + '</p>' +
      '<a href="' + eventUrl + '" class="btn btn--outline mt-md">View Event</a>' +
    '</div>';
  }

  function renderPopular(events, popularContainer) {
    if (!popularContainer) return;
    var sorted = events.slice().sort(function(a, b) {
      return (b.signupCount || 0) - (a.signupCount || 0);
    });
    var popularHtml = '';
    var popularCount = Math.min(sorted.length, 3);
    for (var j = 0; j < popularCount; j++) {
      var pEvt = sorted[j];
      var pStartDate = pEvt.scheduledStart ? new Date(pEvt.scheduledStart).toLocaleString() : 'TBD';
      var pEventUrl = '#/events/' + (pEvt.eventId || pEvt.id);
      popularHtml += '<div class="card">' +
        '<span class="badge badge--upcoming">🔥 Popular</span>' +
        '<h3 class="card__title mt-sm">' + escapeHtml(pEvt.title || 'Untitled') + '</h3>' +
        '<p class="card__meta">' + escapeHtml(pStartDate) + '</p>' +
        '<p class="card__description">' + escapeHtml(pEvt.description || '') + '</p>' +
        '<a href="' + pEventUrl + '" class="btn btn--outline mt-md">View Event</a>' +
      '</div>';
    }
    popularContainer.innerHTML = popularHtml || '<div class="card"><p class="card__description">No events yet.</p></div>';
  }

  /**
   * Load upcoming events from the API and render them on the homepage.
   * Follows `nextCursor` via a "Load more" button so the GET /events endpoint
   * stays bounded per request.
   */
  async function loadHomeEvents() {
    var container = document.getElementById('events-list');
    var popularContainer = document.getElementById('popular-events-list');
    var liveContainer = document.getElementById('events-live');
    var pastContainer = document.getElementById('events-past');
    if (!container) return;

    var apiBase = window.API_BASE_URL || '/api';
    var accumulated = [];

    async function fetchPage(cursor) {
      var url = apiBase + '/events';
      if (cursor) url += '?cursor=' + encodeURIComponent(cursor);
      var res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load events');
      return res.json();
    }

    function renderSections(nextCursor) {
      var live = accumulated.filter(function(e) { return e.status === 'live' || e.status === 'staging'; });
      var upcoming = accumulated.filter(function(e) { return e.status === 'scheduled'; });
      var past = accumulated.filter(function(e) { return e.status === 'ended' || e.status === 'published'; });

      // Live section
      if (liveContainer) {
        liveContainer.innerHTML = live.length
          ? live.map(renderEventCard).join('')
          : '<div class="card"><p class="card__description" style="color: #5a6b7b;">No live events right now.</p></div>';
      }

      // Upcoming section
      var upcomingHtml = '';
      for (var i = 0; i < upcoming.length; i++) {
        upcomingHtml += renderEventCard(upcoming[i]);
      }
      if (nextCursor) {
        upcomingHtml += '<div class="card" style="text-align: center;">' +
          '<button type="button" class="btn btn--outline" id="events-load-more">Load more</button>' +
          '</div>';
      }
      container.innerHTML = upcomingHtml || '<div class="card"><p class="card__description">No upcoming events. Check back soon!</p></div>';

      if (nextCursor) {
        var btn = document.getElementById('events-load-more');
        if (btn) {
          btn.addEventListener('click', async function() {
            btn.disabled = true;
            btn.textContent = 'Loading...';
            try {
              var nextData = await fetchPage(nextCursor);
              var nextEvents = nextData.events || [];
              accumulated = accumulated.concat(nextEvents);
              renderSections(nextData.nextCursor);
            } catch (_e) {
              btn.disabled = false;
              btn.textContent = 'Load more';
            }
          });
        }
      }

      // Past section
      if (pastContainer) {
        pastContainer.innerHTML = past.length
          ? past.map(renderEventCard).join('')
          : '<div class="card"><p class="card__description" style="color: #5a6b7b;">No past events yet.</p></div>';
      }

      renderPopular(accumulated, popularContainer);
    }

    try {
      var data = await fetchPage(null);
      accumulated = data.events || data || [];
      renderSections(data.nextCursor);
    } catch (_err) {
      container.innerHTML = '<div class="card"><p class="card__description">Failed to load events.</p></div>';
      if (pastContainer) pastContainer.innerHTML = '';
    }
  }

  function EventDetailPage(params) {
    // Load event details after render
    setTimeout(function() { loadEventDetail(params.id); }, 0);

    return `
      <div class="page-content">
        <div class="container">
          <div class="card" style="max-width: 700px; margin: 0 auto;" id="event-detail-card">
            <p class="card__description">Loading event...</p>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Load event details from API and render the detail page.
   */
  async function loadEventDetail(eventId) {
    var container = document.getElementById('event-detail-card');
    if (!container) return;

    try {
      var apiBase = window.API_BASE_URL || '/api';
      var res = await fetch(apiBase + '/events/' + encodeURIComponent(eventId));
      if (!res.ok) throw new Error('Event not found');
      var evt = await res.json();

      var startDate = evt.scheduledStart ? new Date(evt.scheduledStart).toLocaleString() : 'TBD';
      var statusBadge = evt.status === 'live' ? 'badge--live' : (evt.status === 'ended' ? 'badge--ended' : 'badge--upcoming');
      var statusLabel = evt.status || 'scheduled';

      // Shareable URL
      var shareUrl = window.location.origin + '/#/events/' + eventId;

      var html = '<span class="badge ' + statusBadge + '">' + escapeHtml(statusLabel) + '</span>' +
        '<h1 class="card__title mt-sm">' + escapeHtml(evt.title || 'Untitled Event') + '</h1>' +
        '<p class="card__meta">' + escapeHtml(startDate) + '</p>';

      // Show scheduled end time and duration when present
      if (evt.scheduledEnd) {
        var endDate = new Date(evt.scheduledEnd).toLocaleString();
        html += '<p class="card__meta" style="color: #555;">Ends: ' + escapeHtml(endDate) + '</p>';
      }
      if (evt.durationMinutes) {
        html += '<p class="card__meta" style="color: #555;">Duration: ' + escapeHtml(formatDurationMinutes(evt.durationMinutes)) + '</p>';
      }

      html += '<p class="card__description">' + escapeHtml(evt.description || '') + '</p>';

      // Shareable link — subtle, with copy button
      html += '<div class="mt-sm" style="font-size: 12px; color: #6b7280;">' +
        '<button class="btn btn--sm btn--outline" onclick="navigator.clipboard.writeText(\'' + shareUrl + '\');this.textContent=\'✓ Copied!\';" style="font-size: 11px;">📋 Share Link</button>' +
      '</div>';

      // Show content based on status
      // Engagement metrics section for ended/published events
      if (evt.metrics) {
        var metricsHtml = '<div class="mt-md" style="padding: 12px 16px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e1e4e8;">';
        metricsHtml += '<h4 style="margin: 0 0 8px 0; font-size: 14px; color: #24292f;">Event Stats</h4>';
        metricsHtml += '<div style="display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: #57606a;">';
        metricsHtml += '<span>👥 ' + (evt.metrics.totalAttendees || 0) + ' attendees</span>';
        metricsHtml += '<span>❓ ' + (evt.metrics.totalQuestions || 0) + ' questions asked</span>';
        if (evt.metrics.durationSeconds) {
          var durH = Math.floor(evt.metrics.durationSeconds / 3600);
          var durM = Math.floor((evt.metrics.durationSeconds % 3600) / 60);
          var durStr = durH > 0 ? durH + 'h ' + durM + 'm' : durM + 'm';
          metricsHtml += '<span>⏱️ Duration: ' + durStr + '</span>';
        }
        metricsHtml += '</div></div>';
        html += metricsHtml;
      }

      // Registration section — unified with auth
      var registrationSection = '';
      if (Auth.isAuthenticated()) {
        // User is signed in — one-click register
        registrationSection = '<div class="mt-lg">' +
          '<h3>Register</h3>' +
          '<div id="signup-message" style="display:none; margin-top:8px; padding:8px 12px; border-radius:4px;"></div>' +
          '<p class="mt-sm text-muted">Signed in as ' + escapeHtml(Auth.getCurrentUser().email || '') + '</p>' +
          '<button class="btn btn--primary mt-md" onclick="App.handleEventSignup(event, \'' + eventId + '\')">Register for this Event</button>' +
        '</div>';
      } else {
        // Not signed in — prompt to sign in
        registrationSection = '<div class="mt-lg">' +
          '<h3>Register</h3>' +
          '<p class="mt-sm text-muted">Sign in to register for this event and receive updates.</p>' +
          '<button class="btn btn--primary mt-md" onclick="App.showAuthModal(\'signin\')">Sign In to Register</button>' +
        '</div>';
      }

      if (evt.displayMode === 'live' || evt.status === 'live' || evt.displayMode === 'staging' || evt.status === 'staging') {
        html += '<div class="mt-lg">' +
          '<a href="#/events/' + eventId + '/live" class="btn btn--primary">Join Live Session</a>' +
        '</div>';
        html += registrationSection;
      } else if (evt.displayMode === 'ended' || evt.status === 'ended') {
        if (evt.recordingUrl || evt.hlsPlaybackUrl) {
          var playbackUrl = evt.hlsPlaybackUrl || evt.recordingUrl;
          // Show recording player for everyone (authenticated or anonymous)
          html += '<div class="mt-lg"><h3>Recording</h3>'
            + '<div style="background: #0d1117; border-radius: 8px; overflow: hidden; margin-top: 12px;">'
            + '<video id="recording-player" controls style="width: 100%; max-height: 480px;" playsinline></video>'
            + '</div></div>';
          // Initialize HLS.js after render
          setTimeout(function() {
            var video = document.getElementById('recording-player');
            if (video && window.Hls && Hls.isSupported()) {
              var hls = new Hls();
              hls.loadSource(playbackUrl);
              hls.attachMedia(video);
            } else if (video) {
              video.src = playbackUrl;
            }
          }, 100);
        } else {
          html += '<div class="mt-lg"><p class="text-muted">This event has ended. A recording may be available shortly.</p></div>';
        }
      } else if (evt.displayMode === 'cancelled' || evt.status === 'cancelled') {
        html += '<div class="mt-lg"><p class="text-muted">This event was cancelled.</p></div>';
      } else {
        // Scheduled — show countdown + registration
        if (evt.countdown && evt.countdown > 0) {
          var hours = Math.floor(evt.countdown / 3600);
          var mins = Math.floor((evt.countdown % 3600) / 60);
          html += '<p class="mt-md" style="color: #FF9900; font-weight: 600;">Starts in ' + hours + 'h ' + mins + 'm</p>';
        }
        html += registrationSection;
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = '<p style="color: #e63946;">Failed to load event: ' + escapeHtml(err.message) + '</p>';
    }
  }

  /**
   * Handle event sign-up form submission.
   */
  async function handleEventSignup(formEvent, eventId) {
    if (formEvent && formEvent.preventDefault) formEvent.preventDefault();

    var msgEl = document.getElementById('signup-message');
    var user = Auth.getCurrentUser();
    if (!user) {
      App.showAuthModal('signin');
      return;
    }

    try {
      var apiBase = window.API_BASE_URL || '/api';
      var token = Auth.getIdToken();

      var res = await fetch(apiBase + '/events/' + encodeURIComponent(eventId) + '/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ displayName: user.email, email: user.email }),
      });

      if (res.ok || res.status === 201) {
        if (msgEl) {
          msgEl.style.display = 'block';
          msgEl.style.background = '#d4edda';
          msgEl.style.color = '#155724';
          msgEl.textContent = '✓ Registered! You will receive updates about this event.';
        }
        // Hide the register button
        var btn = formEvent && formEvent.target;
        if (btn && btn.tagName === 'BUTTON') btn.style.display = 'none';
      } else {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || 'Registration failed (' + res.status + ')');
      }
    } catch (err) {
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.background = '#f8d7da';
        msgEl.style.color = '#721c24';
        msgEl.textContent = err.message || 'Registration failed. Please try again.';
      }
    }
  }

  function WaitingRoomPage(params) {
    return `
      <div class="page-content">
        <div class="container">
          <div class="waiting-room">
            <h1>Waiting Room</h1>
            <p class="text-muted mt-sm">Event: ${escapeHtml(params.id)}</p>
            <div class="waiting-room__countdown" id="countdown">--:--:--</div>
            <p class="text-muted">The session will begin shortly. You'll be redirected automatically when the presenter starts.</p>
            <div class="mt-lg">
              <div class="card" style="max-width: 500px; margin: 0 auto;">
                <h4>💡 Did you know?</h4>
                <p class="card__description mt-sm">AWS has over 400+ user groups worldwide, connecting cloud enthusiasts in local communities.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function LiveSessionPage(params) {
    // Auto-join the live session after render
    setTimeout(function() { joinLiveSession(params.id); }, 0);

    // For unauthenticated users, render a minimal container for AnonymousViewer
    if (!Auth.isAuthenticated()) {
      return `
        <div id="live-session-container" class="live-session" style="min-height: 100vh;">
          <div id="live-session-status" style="text-align: center; padding: 40px;">
            <p style="color: #8b949e;">Connecting to live session...</p>
          </div>
        </div>
      `;
    }

    // Use the LiveSession module's renderPage if available
    if (typeof LiveSession !== 'undefined') {
      return LiveSession.renderPage(params);
    }

    return `
      <div class="live-session">
        <div class="container" style="padding-top: var(--space-md);">
          <div style="display: flex; align-items: center; gap: var(--space-md); margin-bottom: var(--space-md);">
            <span class="badge badge--live">Live</span>
            <h2 style="color: var(--color-text-inverse);">Event: ${escapeHtml(params.id)}</h2>
          </div>
          <div id="live-session-status" style="text-align: center; padding: 40px;">
            <p style="color: #8b949e;">Connecting to live session...</p>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Join a live session by calling the join API and initializing IVS.
   * If the user is not authenticated, routes to AnonymousViewer for view-only access.
   */
  async function joinLiveSession(eventId) {
    var statusEl = document.getElementById('live-session-status') || document.getElementById('stage-placeholder');

    if (!Auth.isAuthenticated()) {
      // Route unauthenticated users to anonymous live viewing
      if (typeof AnonymousViewer !== 'undefined' && typeof Fingerprint !== 'undefined') {
        var wsUrl = window.WS_BASE_URL || 'wss://ws.yourdomain.com';
        AnonymousViewer.initLive({ eventId: eventId, wsUrl: wsUrl });
      } else {
        if (statusEl) statusEl.innerHTML = '<p style="color: #e63946;">Unable to load anonymous viewing module. Please reload the page.</p>';
      }
      return;
    }

    try {
      var apiBase = window.API_BASE_URL || '/api';
      var token = Auth.getIdToken();

      var res = await fetch(apiBase + '/events/' + encodeURIComponent(eventId) + '/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
      });

      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || 'Failed to join (' + res.status + ')');
      }

      var joinData = await res.json();

      // If event is in staging and user is not the presenter, show waiting screen
      if (joinData.status === 'waiting') {
        showWaitingScreen(eventId, statusEl);
        return;
      }

      // Determine event status from join response (presenter in staging gets tokens)
      var currentEventStatus = joinData.eventStatus || 'live';

      // Initialize LiveSession with tokens
      if (typeof LiveSession !== 'undefined' && joinData.stageToken) {
        var wsUrl = resolveWsBaseUrl();
        if (!wsUrl) {
          if (statusEl) {
            statusEl.innerHTML = '<p style="color: #e63946;">Live session unavailable: WebSocket endpoint not configured.</p>' +
              '<button class="btn btn--outline mt-md" onclick="App.navigate(\'/events/' + eventId + '\')">Back to Event</button>';
          }
          return;
        }
        LiveSession.init({
          eventId: eventId,
          participantToken: joinData.stageToken.token,
          chatToken: joinData.chatToken ? joinData.chatToken.token : null,
          role: joinData.role || 'attendee',
          userId: Auth.getCurrentUser().sub || '',
          email: Auth.getCurrentUser().email || '',
          eventStatus: currentEventStatus,
          wsUrl: wsUrl + '?token=' + encodeURIComponent(token) + '&eventId=' + encodeURIComponent(eventId) + '&userId=' + encodeURIComponent(Auth.getCurrentUser().sub || '') + '&role=' + encodeURIComponent(joinData.role || 'attendee') + '&displayName=' + encodeURIComponent(Auth.getCurrentUser().email || '') + '&email=' + encodeURIComponent(Auth.getCurrentUser().email || ''),
        });
      } else if (statusEl) {
        statusEl.innerHTML = '<p style="color: #7AA116;">✓ Connected to session as <strong>' + escapeHtml(joinData.role || 'attendee') + '</strong></p>' +
          '<p class="mt-sm" style="color: #8b949e;">IVS Web Broadcast SDK not loaded. Video streaming requires the SDK to be included.</p>';
      }
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = '<p style="color: #e63946;">Failed to join session: ' + escapeHtml(err.message) + '</p>' +
          '<button class="btn btn--outline mt-md" onclick="App.navigate(\'/events/' + eventId + '\')">Back to Event</button>';
      }
    }
  }

  /**
   * Show a waiting screen for attendees when event is in staging.
   * Auto-polls every 5 seconds until the event goes live.
   */
  function showWaitingScreen(eventId, statusEl) {
    var container = statusEl || document.getElementById('live-session-status') || document.getElementById('stage-placeholder');
    if (container) {
      container.innerHTML = '<div style="text-align: center; padding: 60px 20px;">' +
        '<h2 style="color: #e6edf3; margin-bottom: 12px;">Starting soon...</h2>' +
        '<p style="color: #8b949e; font-size: 16px;">The presenter is setting up. The session will begin shortly.</p>' +
        '<div style="margin-top: 24px;"><span class="badge badge--upcoming" style="font-size: 14px; padding: 6px 16px;">Waiting for presenter</span></div>' +
      '</div>';
    }

    // Auto-poll every 5 seconds
    var pollInterval = setInterval(async function() {
      try {
        var apiBase = window.API_BASE_URL || '/api';
        var token = Auth.getIdToken();
        if (!token) {
          clearInterval(pollInterval);
          return;
        }

        var res = await fetch(apiBase + '/events/' + encodeURIComponent(eventId) + '/join', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
        });

        if (!res.ok) return;

        var joinData = await res.json();

        // Still waiting
        if (joinData.status === 'waiting') return;

        // Event is now live — stop polling and initialize session
        clearInterval(pollInterval);

        if (typeof LiveSession !== 'undefined' && joinData.stageToken) {
          var wsUrl = resolveWsBaseUrl();
          if (!wsUrl) {
            // The polling path is fire-and-forget; surface the misconfig in
            // the console (resolveWsBaseUrl already did) and bail this tick.
            return;
          }
          LiveSession.init({
            eventId: eventId,
            participantToken: joinData.stageToken.token,
            chatToken: joinData.chatToken ? joinData.chatToken.token : null,
            role: joinData.role || 'attendee',
            userId: Auth.getCurrentUser().sub || '',
            email: Auth.getCurrentUser().email || '',
            eventStatus: 'live',
            wsUrl: wsUrl + '?token=' + encodeURIComponent(token) + '&eventId=' + encodeURIComponent(eventId) + '&userId=' + encodeURIComponent(Auth.getCurrentUser().sub || '') + '&role=' + encodeURIComponent(joinData.role || 'attendee') + '&displayName=' + encodeURIComponent(Auth.getCurrentUser().email || '') + '&email=' + encodeURIComponent(Auth.getCurrentUser().email || ''),
          });
        }
      } catch (err) {
        // Silently retry on next interval
      }
    }, 5000);
  }

  function ManageEventsPage() {
    if (!Auth.isAuthenticated()) {
      return `
        <div class="page-content">
          <div class="container text-center">
            <h1>Manage Events</h1>
            <p class="text-muted mt-md">You need to sign in to manage events.</p>
            <button class="btn btn--primary mt-lg" onclick="App.showAuthModal('signin')">Sign In</button>
          </div>
        </div>
      `;
    }

    // Check if user has organizer role
    var user = Auth.getCurrentUser();
    var token = user && user.idToken;
    var isOrganizer = false;
    if (token) {
      try {
        var payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        isOrganizer = payload['custom:role'] === 'organizer';
      } catch (e) {}
    }

    if (!isOrganizer) {
      return `
        <div class="page-content">
          <div class="container text-center">
            <h1>Manage Events</h1>
            <p class="text-muted mt-md">Only organizers can manage events. Contact an admin to upgrade your account.</p>
            <a href="#/" class="btn btn--primary mt-lg">Go Home</a>
          </div>
        </div>
      `;
    }

    // Use the ManageEvents module if available
    if (typeof ManageEvents !== 'undefined') {
      setTimeout(function() { ManageEvents.init(); }, 0);
      return ManageEvents.renderPage();
    }

    return `
      <div class="page-content">
        <div class="container">
          <h1>Manage Events</h1>
          <p class="text-muted mt-md">Loading...</p>
        </div>
      </div>
    `;
  }

  /**
   * Filter events on the homepage by search term (Fix #4).
   */
  function filterEvents() {
    var searchInput = document.getElementById('event-search');
    if (!searchInput) return;
    var term = searchInput.value.toLowerCase().trim();

    var containers = [document.getElementById('events-list'), document.getElementById('popular-events-list')];
    containers.forEach(function(container) {
      if (!container) return;
      var cards = container.querySelectorAll('.card');
      cards.forEach(function(card) {
        var title = (card.querySelector('.card__title') || {}).textContent || '';
        var desc = (card.querySelector('.card__description') || {}).textContent || '';
        var matches = !term || title.toLowerCase().indexOf(term) !== -1 || desc.toLowerCase().indexOf(term) !== -1;
        card.style.display = matches ? '' : 'none';
      });
    });
  }

  /**
   * Profile page component (Fix #5).
   */
  function ProfilePage() {
    if (!Auth.isAuthenticated()) {
      return `
        <div class="page-content">
          <div class="container text-center">
            <h1>Profile</h1>
            <p class="text-muted mt-md">You need to sign in to view your profile.</p>
            <button class="btn btn--primary mt-lg" onclick="App.showAuthModal('signin')">Sign In</button>
          </div>
        </div>
      `;
    }

    var user = Auth.getCurrentUser();
    var email = user.email || '';
    var displayName = user.displayName || email;
    var role = 'attendee';
    var memberSince = '';

    if (user.idToken) {
      try {
        var payload = JSON.parse(atob(user.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        role = payload['custom:role'] || 'attendee';
        if (payload.auth_time) {
          memberSince = new Date(payload.auth_time * 1000).toLocaleDateString();
        }
      } catch (e) {}
    }

    return `
      <div class="page-content">
        <div class="container">
          <div class="card" style="max-width: 500px; margin: 0 auto;">
            <h1 class="card__title">Profile</h1>
            <div class="mt-lg">
              <div class="form-group">
                <label>Display Name</label>
                <p style="padding: 8px 0; font-size: 16px;">${escapeHtml(displayName)}</p>
              </div>
              <div class="form-group">
                <label>Email</label>
                <p style="padding: 8px 0; font-size: 16px;">${escapeHtml(email)}</p>
              </div>
              <div class="form-group">
                <label>Role</label>
                <p style="padding: 8px 0; font-size: 16px; text-transform: capitalize;">${escapeHtml(role)}</p>
              </div>
              ${memberSince ? '<div class="form-group"><label>Member Since</label><p style="padding: 8px 0; font-size: 16px;">' + escapeHtml(memberSince) + '</p></div>' : ''}
            </div>
            <div class="mt-lg">
              <a href="#/" class="btn btn--outline">Back to Events</a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Show forgot password form (Fix #6).
   */
  function showForgotPassword() {
    var modal = document.getElementById('auth-modal');
    if (!modal) return;

    modal.innerHTML = `
      <h2 class="modal__title">Reset Password</h2>
      <div class="modal__error" id="auth-error"></div>
      <p class="text-center mb-md" style="font-size: 14px; color: #5A6B7B;">Enter your email and we'll send you a reset code.</p>
      <form id="auth-form" onsubmit="App.handleForgotPassword(event)">
        <div class="form-group">
          <label for="auth-email">Email</label>
          <input type="email" id="auth-email" class="form-input" placeholder="you@example.com" required>
        </div>
        <button type="submit" class="btn btn--primary" style="width: 100%;">Send Reset Code</button>
      </form>
      <div class="modal__toggle">
        <a onclick="App.showAuthModal('signin')" style="cursor: pointer;">Back to Sign In</a>
      </div>
      <div class="mt-md text-center">
        <button class="btn btn--sm" onclick="App.hideAuthModal()">Cancel</button>
      </div>
    `;
  }

  /**
   * Handle forgot password form submission (Fix #6).
   */
  async function handleForgotPassword(event) {
    event.preventDefault();
    var email = document.getElementById('auth-email').value;
    var errorEl = document.getElementById('auth-error');

    try {
      await Auth.forgotPassword(email);
      // Show code + new password form
      var modal = document.getElementById('auth-modal');
      if (modal) {
        modal.innerHTML = `
          <h2 class="modal__title">Enter Reset Code</h2>
          <div class="modal__error" id="auth-error"></div>
          <p class="text-center mb-md" style="font-size: 14px; color: #5A6B7B;">Check your email for the verification code.</p>
          <form onsubmit="App.handleResetPassword(event, '${escapeHtml(email)}')">
            <div class="form-group">
              <label for="auth-code">Verification Code</label>
              <input type="text" id="auth-code" class="form-input" placeholder="123456" required>
            </div>
            <div class="form-group">
              <label for="auth-new-password">New Password</label>
              <input type="password" id="auth-new-password" class="form-input" placeholder="Min 8 characters" required minlength="8">
            </div>
            <button type="submit" class="btn btn--primary" style="width: 100%;">Reset Password</button>
          </form>
          <div class="mt-md text-center">
            <button class="btn btn--sm" onclick="App.hideAuthModal()">Cancel</button>
          </div>
        `;
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Failed to send reset code';
        errorEl.style.display = 'block';
      }
    }
  }

  /**
   * Handle reset password with code (Fix #6).
   */
  async function handleResetPassword(event, email) {
    event.preventDefault();
    var code = document.getElementById('auth-code').value;
    var newPassword = document.getElementById('auth-new-password').value;
    var errorEl = document.getElementById('auth-error');

    try {
      await Auth.confirmForgotPassword(email, code, newPassword);
      hideAuthModal();
      showAuthModal('signin');
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Password reset failed';
        errorEl.style.display = 'block';
      }
    }
  }

  function NotFoundPage() {
    return `
      <div class="page-content">
        <div class="container text-center">
          <h1>404</h1>
          <p class="text-muted mt-md">Page not found.</p>
          <a href="#/" class="btn btn--primary mt-lg">Go Home</a>
        </div>
      </div>
    `;
  }

  // --- Utilities ---

  /**
   * Format duration in minutes as a human-readable string (e.g., "1h 30m").
   * @param {number} minutes - Duration in minutes.
   * @returns {string} Formatted duration string.
   */
  function formatDurationMinutes(minutes) {
    if (!minutes || minutes <= 0) return '';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (h > 0 && m > 0) return h + 'h ' + m + 'm';
    if (h > 0) return h + 'h';
    return m + 'm';
  }

  function escapeHtml(str) {
    // Escapes all five HTML/attr-significant chars so the result is safe to
    // interpolate into both element text and attribute contexts (incl.
    // single- or double-quoted onclick="...").
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Resolve the WebSocket base URL from runtime config.
   *
   * Issue #125: previously fell back to a hardcoded API Gateway
   * URL belonging to one specific deployment, which coupled
   * every SPA copy to that one deployment's endpoint.
   * window.WS_BASE_URL must be set by config.js (see PR #23
   * scaffolding) before live-session features work.
   *
   * @returns {string|null} The configured WS base URL, or null
   *                        if not configured (caller must bail).
   */
  function resolveWsBaseUrl() {
    if (typeof window !== 'undefined' && window.WS_BASE_URL) {
      return window.WS_BASE_URL;
    }
    console.error('App: WS_BASE_URL is not configured. Live sessions require window.WS_BASE_URL to be set in config.js.');
    return null;
  }

  // --- Initialization ---

  function init() {
    appContainer = document.getElementById('app');
    if (!appContainer) {
      console.error('App: #app container not found');
      return;
    }

    defineRoutes();

    // Initialize auth
    Auth.init();

    // Listen for hash changes
    window.addEventListener('hashchange', render);

    // While in a live session, open the Events nav link in a NEW TAB instead of
    // routing the current tab away — otherwise an accidental click drops the user
    // out of the webinar. The broader "warn before leaving" UX is tracked in #163.
    document.addEventListener('click', function(e) {
      var link = e.target && e.target.closest && e.target.closest('a.nav__link[data-route="/"]');
      if (!link) return;
      if (getCurrentPath().includes('/live')) {
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener');
      }
    });

    // Prompt before closing/refreshing the page while in a live session
    window.addEventListener('beforeunload', function(e) {
      var path = getCurrentPath();
      if (path.includes('/live')) {
        e.preventDefault();
        e.returnValue = 'You are in a live session. Are you sure you want to leave?';
        return e.returnValue;
      }
    });

    // Initial render
    render();

    // Listen for auth state changes
    Auth.onAuthStateChange(() => {
      updateAuthUI();
    });
  }

  // Public API
  return {
    init,
    navigate,
    render,
    showAuthModal,
    hideAuthModal,
    handleSignIn,
    handleSignUp,
    handleConfirm,
    handleSignOut,
    handleEventSignup,
    filterEvents,
    showForgotPassword,
    handleForgotPassword,
    handleResetPassword,
  };
})();

// Boot the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

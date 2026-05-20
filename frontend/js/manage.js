/**
 * Event Management Module — Organizer CRUD UI
 *
 * Provides the event management interface for authenticated organizers:
 * - Create, edit, delete events
 * - Event list showing organizer's events
 * - Start/stop event controls
 * - Sign-up list viewer
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 18.1, 18.2, 18.3
 */

const ManageEvents = (() => {
  'use strict';

  // --- State ---
  let events = [];
  let currentEventId = null;
  let isLoading = false;

  // --- Configuration ---
  var API_BASE = window.API_BASE_URL || '/api';

  // --- Page Rendering ---

  /**
   * Render the manage events page.
   * Req 18.1: Require authentication before allowing Event management.
   * @returns {string} HTML string
   */
  function renderPage() {
    if (!Auth.isAuthenticated()) {
      return _renderUnauthenticated();
    }
    return _renderManagePage();
  }

  /**
   * Initialize the manage page after DOM insertion.
   * Loads the organizer's events from the API.
   */
  function init() {
    if (!Auth.isAuthenticated()) return;
    loadEvents();
  }

  // --- Event CRUD ---

  /**
   * Load all events for the current organizer.
   */
  async function loadEvents() {
    isLoading = true;
    _renderEventList();

    try {
      var response = await _apiRequest('GET', '/events?mine=true');
      events = response.events || response || [];
      isLoading = false;
      _renderEventList();
    } catch (err) {
      isLoading = false;
      events = [];
      _renderEventList(window.I18n.t('errors.event.loadFailed', { detail: err.message || window.I18n.t('errors.unknown') }));
    }
  }

  /**
   * Create a new event.
   * Req 14.1: Generate unique URL and store metadata.
   * Req 14.3: Reject if scheduled start time is in the past.
   * @param {Event} formEvent - Form submit event
   */
  async function createEvent(formEvent) {
    formEvent.preventDefault();

    var title = document.getElementById('event-title');
    var description = document.getElementById('event-description');
    var startTime = document.getElementById('event-start-time');

    if (!title || !description || !startTime) return;

    var titleVal = title.value.trim();
    var descVal = description.value.trim();
    var startVal = startTime.value;

    // Validate required fields
    if (!titleVal || !startVal) {
      _showFormError('Title and start time are required.');
      return;
    }

    // Req 14.3: Reject if start time is in the past
    var startDate = new Date(startVal);
    if (startDate <= new Date()) {
      _showFormError('Scheduled start time must be in the future.');
      return;
    }

    _setFormLoading(true);

    try {
      var payload = {
        title: titleVal,
        description: descVal,
        scheduledStart: startDate.toISOString()
      };

      // Include optional durationMinutes if provided
      var durationInput = document.getElementById('event-duration');
      if (durationInput && durationInput.value.trim() !== '') {
        var durationVal = parseInt(durationInput.value, 10);
        if (!isNaN(durationVal) && durationVal >= 1 && durationVal <= 480) {
          payload.durationMinutes = durationVal;
        }
      }

      await _apiRequest('POST', '/events', payload);
      _setFormLoading(false);
      _hideCreateForm();
      await loadEvents();
      _showNotification('Event created successfully.');
    } catch (err) {
      _setFormLoading(false);
      _showFormError(err.message || window.I18n.t('errors.event.createFailed'));
    }
  }

  /**
   * Edit an existing event.
   * Req 18.2: Update metadata and retain existing URL.
   * @param {Event} formEvent - Form submit event
   */
  async function editEvent(formEvent) {
    formEvent.preventDefault();

    if (!currentEventId) return;

    var title = document.getElementById('edit-event-title');
    var description = document.getElementById('edit-event-description');
    var startTime = document.getElementById('edit-event-start-time');

    if (!title || !startTime) return;

    var titleVal = title.value.trim();
    var descVal = description ? description.value.trim() : '';
    var startVal = startTime.value;

    if (!titleVal || !startVal) {
      _showFormError('Title and start time are required.');
      return;
    }

    _setFormLoading(true);

    try {
      var payload = {
        title: titleVal,
        description: descVal,
        scheduledStartTime: new Date(startVal).toISOString()
      };

      // Include optional durationMinutes if provided
      var editDurationInput = document.getElementById('edit-event-duration');
      if (editDurationInput && editDurationInput.value.trim() !== '') {
        var editDurationVal = parseInt(editDurationInput.value, 10);
        if (!isNaN(editDurationVal) && editDurationVal >= 1 && editDurationVal <= 480) {
          payload.durationMinutes = editDurationVal;
        }
      }

      await _apiRequest('PUT', '/events/' + currentEventId, payload);
      _setFormLoading(false);
      _hideEditForm();
      currentEventId = null;
      await loadEvents();
      _showNotification('Event updated successfully.');
    } catch (err) {
      _setFormLoading(false);
      _showFormError(err.message || window.I18n.t('errors.event.updateFailed'));
    }
  }

  /**
   * Delete an event.
   * Req 18.3: Remove from public listing and display cancellation notice.
   * @param {string} eventIdToDelete - Event ID to delete
   */
  async function deleteEvent(eventIdToDelete) {
    if (!eventIdToDelete) return;

    var confirmed = confirm('Are you sure you want to delete this event? This action cannot be undone.');
    if (!confirmed) return;

    try {
      await _apiRequest('DELETE', '/events/' + eventIdToDelete);
      await loadEvents();
      _showNotification('Event deleted.');
    } catch (err) {
      _showNotification(window.I18n.t('errors.event.deleteFailed', { detail: err.message || window.I18n.t('errors.unknown') }));
    }
  }

  // --- Start/Stop Event Controls ---

  /**
   * Start a live event session (enter Green Room).
   * @param {string} id - Event ID to start
   */
  async function startEvent(id) {
    if (!id) return;

    try {
      await _apiRequest('POST', '/events/' + id + '/start');
      _showNotification('Entering Green Room. Set up your devices before going live.');
      // Redirect presenter to the live session page (green room)
      window.location.hash = '#/events/' + id + '/live';
    } catch (err) {
      _showNotification(window.I18n.t('errors.event.startFailed', { detail: err.message || window.I18n.t('errors.unknown') }));
    }
  }

  /**
   * Stop/end a live event session.
   * @param {string} id - Event ID to stop
   */
  async function stopEvent(id) {
    if (!id) return;

    var confirmed = confirm('Are you sure you want to end this event? This will disconnect all attendees.');
    if (!confirmed) return;

    try {
      await _apiRequest('POST', '/events/' + id + '/stop');
      await loadEvents();
      _showNotification('Event ended.');
    } catch (err) {
      _showNotification(window.I18n.t('errors.event.stopFailed', { detail: err.message || window.I18n.t('errors.unknown') }));
    }
  }

  // --- Sign-Up List Viewer ---

  /**
   * View the sign-up list for an event.
   * @param {string} id - Event ID
   */
  async function viewSignups(id) {
    if (!id) return;

    var container = document.getElementById('signups-panel');
    if (!container) return;

    container.style.display = 'block';
    container.innerHTML = '<p style="color: #8b949e;">Loading sign-ups...</p>';

    try {
      var response = await _apiRequest('GET', '/events/' + id + '/signups');
      var signups = response.signups || response || [];
      _renderSignupList(container, signups, id);
    } catch (err) {
      container.innerHTML = '<p style="color: #e63946;">' + _escapeHtml(window.I18n.t('errors.event.signupsLoadFailed', { detail: err.message || window.I18n.t('errors.unknown') })) + '</p>';
    }
  }

  /**
   * Close the sign-up list panel.
   */
  function closeSignups() {
    var container = document.getElementById('signups-panel');
    if (container) {
      container.style.display = 'none';
      container.innerHTML = '';
    }
  }

  // --- UI Form Controls ---

  /**
   * Show the create event form.
   */
  function showCreateForm() {
    var form = document.getElementById('create-event-form');
    if (form) {
      form.style.display = 'block';
    }
  }

  /**
   * Show the edit form for a specific event.
   * @param {string} id - Event ID to edit
   */
  function showEditForm(id) {
    var evt = events.find(function(e) { return e.eventId === id || e.id === id; });
    if (!evt) return;

    currentEventId = id;
    var container = document.getElementById('edit-event-form');
    if (!container) return;

    var startTimeLocal = '';
    if (evt.scheduledStartTime) {
      var d = new Date(evt.scheduledStartTime);
      startTimeLocal = d.toISOString().slice(0, 16);
    }

    var durationVal = evt.durationMinutes || '';

    container.innerHTML = '<form onsubmit="ManageEvents.editEvent(event)">' +
      '<h3 style="margin-bottom: 12px;">Edit Event</h3>' +
      '<div class="form-group">' +
        '<label for="edit-event-title">Title</label>' +
        '<input type="text" id="edit-event-title" class="form-input" value="' + _escapeAttr(evt.title || '') + '" required>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="edit-event-description">Description</label>' +
        '<textarea id="edit-event-description" class="form-input" rows="3">' + _escapeHtml(evt.description || '') + '</textarea>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="edit-event-start-time">Start Time</label>' +
        '<input type="datetime-local" id="edit-event-start-time" class="form-input" value="' + startTimeLocal + '" required>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="edit-event-duration">Duration (minutes, optional)</label>' +
        '<input type="number" id="edit-event-duration" class="form-input" placeholder="e.g. 60" min="1" max="480" value="' + _escapeAttr(String(durationVal)) + '">' +
      '</div>' +
      '<div id="form-error" style="display: none; color: #e63946; margin-bottom: 8px;"></div>' +
      '<div style="display: flex; gap: 8px;">' +
        '<button type="submit" class="btn btn--primary" id="form-submit-btn">Save Changes</button>' +
        '<button type="button" class="btn btn--outline" onclick="ManageEvents.hideEditForm()">Cancel</button>' +
      '</div>' +
    '</form>';

    container.style.display = 'block';
  }

  /**
   * Hide the edit form.
   */
  function hideEditForm() {
    var container = document.getElementById('edit-event-form');
    if (container) {
      container.style.display = 'none';
      container.innerHTML = '';
    }
    currentEventId = null;
  }

  // --- Private Rendering ---

  function _renderUnauthenticated() {
    return '<div class="page-content">' +
      '<div class="container text-center">' +
        '<h1>Manage Events</h1>' +
        '<p class="text-muted mt-md">You need to sign in to manage events.</p>' +
        '<button class="btn btn--primary mt-lg" onclick="App.showAuthModal(\'signin\')">Sign In</button>' +
      '</div>' +
    '</div>';
  }

  function _renderManagePage() {
    return '<div class="page-content">' +
      '<div class="container">' +
        '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">' +
          '<h1>Manage Events</h1>' +
          '<button class="btn btn--primary" onclick="ManageEvents.showCreateForm()">+ Create Event</button>' +
        '</div>' +

        // Create event form (hidden by default)
        '<div id="create-event-form" style="display: none; margin-bottom: 24px; padding: 20px; background: #f8f9fa; border-radius: 8px;">' +
          '<form onsubmit="ManageEvents.createEvent(event)">' +
            '<h3 style="margin-bottom: 12px;">Create New Event</h3>' +
            '<div class="form-group">' +
              '<label for="event-title">Title</label>' +
              '<input type="text" id="event-title" class="form-input" placeholder="Event title" required>' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="event-description">Description</label>' +
              '<textarea id="event-description" class="form-input" rows="3" placeholder="Describe your event..."></textarea>' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="event-start-time">Scheduled Start Time</label>' +
              '<input type="datetime-local" id="event-start-time" class="form-input" required>' +
            '</div>' +
            '<div class="form-group">' +
              '<label for="event-duration">Duration (minutes, optional)</label>' +
              '<input type="number" id="event-duration" class="form-input" placeholder="e.g. 60" min="1" max="480">' +
            '</div>' +
            '<div id="form-error" style="display: none; color: #e63946; margin-bottom: 8px;"></div>' +
            '<div style="display: flex; gap: 8px;">' +
              '<button type="submit" class="btn btn--primary" id="form-submit-btn">Create Event</button>' +
              '<button type="button" class="btn btn--outline" onclick="ManageEvents.hideCreateForm()">Cancel</button>' +
            '</div>' +
          '</form>' +
        '</div>' +

        // Edit event form placeholder
        '<div id="edit-event-form" style="display: none; margin-bottom: 24px; padding: 20px; background: #f8f9fa; border-radius: 8px;"></div>' +

        // Event list
        '<div id="manage-events-list"></div>' +

        // Sign-up list panel
        '<div id="signups-panel" style="display: none; margin-top: 24px; padding: 20px; background: #f8f9fa; border-radius: 8px;"></div>' +
      '</div>' +
    '</div>';
  }

  function _renderEventList(errorMessage) {
    var container = document.getElementById('manage-events-list');
    if (!container) return;

    if (isLoading) {
      container.innerHTML = '<div class="card"><p class="text-muted">Loading your events...</p></div>';
      return;
    }

    if (errorMessage) {
      container.innerHTML = '<div class="card"><p style="color: #e63946;">' + _escapeHtml(errorMessage) + '</p></div>';
      return;
    }

    if (!events || events.length === 0) {
      container.innerHTML = '<div class="card">' +
        '<h3 class="card__title">No events yet</h3>' +
        '<p class="card__description">Create your first event to get started.</p>' +
      '</div>';
      return;
    }

    var html = '<div class="grid grid--events">';
    for (var i = 0; i < events.length; i++) {
      html += _renderEventCard(events[i]);
    }
    html += '</div>';
    container.innerHTML = html;
  }

  function _renderEventCard(evt) {
    var id = evt.eventId || evt.id;
    var status = evt.status || 'scheduled';
    var badgeClass = status === 'live' ? 'badge--live' : (status === 'staging' ? 'badge--live' : (status === 'ended' ? 'badge--ended' : 'badge--upcoming'));
    var startTime = evt.scheduledStart ? new Date(evt.scheduledStart).toLocaleString() : (evt.scheduledStartTime ? new Date(evt.scheduledStartTime).toLocaleString() : 'TBD');
    var eventUrl = window.location.origin + '/#/events/' + id;

    // View Event link (always shown)
    var viewLink = '<a href="#/events/' + _escapeAttr(id) + '" class="btn btn--outline btn--sm">🔗 View Event</a>';

    var controls = '';
    if (status === 'scheduled') {
      controls = '<div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">' +
        '<button class="btn btn--primary btn--sm" onclick="ManageEvents.startEvent(\'' + _escapeAttr(id) + '\')">🎬 Enter Green Room</button>' +
        viewLink +
        '<button class="btn btn--outline btn--sm" onclick="ManageEvents.showEditForm(\'' + _escapeAttr(id) + '\')">✏️ Edit</button>' +
        '<button class="btn btn--outline btn--sm" onclick="ManageEvents.viewSignups(\'' + _escapeAttr(id) + '\')">👥 Sign-ups</button>' +
        '<button class="btn btn--outline btn--sm" style="color: #e63946; border-color: #e63946;" onclick="ManageEvents.deleteEvent(\'' + _escapeAttr(id) + '\')">🗑️ Delete</button>' +
      '</div>';
    } else if (status === 'live' || status === 'staging') {
      controls = '<div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">' +
        '<button class="btn btn--primary btn--sm" style="background: #e63946;" onclick="ManageEvents.stopEvent(\'' + _escapeAttr(id) + '\')">⏹ End Event</button>' +
        viewLink +
        '<button class="btn btn--outline btn--sm" onclick="ManageEvents.viewSignups(\'' + _escapeAttr(id) + '\')">👥 Sign-ups</button>' +
      '</div>';
    } else {
      controls = '<div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">' +
        viewLink +
        '<button class="btn btn--outline btn--sm" onclick="ManageEvents.viewSignups(\'' + _escapeAttr(id) + '\')">👥 Sign-ups</button>' +
        '<button class="btn btn--outline btn--sm" style="color: #e63946; border-color: #e63946;" onclick="ManageEvents.deleteEvent(\'' + _escapeAttr(id) + '\')">🗑️ Delete</button>' +
      '</div>';
    }

    // Shareable URL row
    var urlRow = '<div style="margin-top: 8px; font-size: 12px; color: #6b7280; word-break: break-all;">' +
      '<span style="font-weight: 500;">URL:</span> <a href="#/events/' + _escapeAttr(id) + '" style="color: #1B659D;">' + _escapeHtml(eventUrl) + '</a>' +
    '</div>';

    return '<div class="card">' +
      '<span class="badge ' + badgeClass + '">' + _escapeHtml(status) + '</span>' +
      '<h3 class="card__title mt-sm">' + _escapeHtml(evt.title || 'Untitled Event') + '</h3>' +
      '<p class="card__meta">' + _escapeHtml(startTime) + '</p>' +
      '<p class="card__description">' + _escapeHtml(evt.description || '') + '</p>' +
      urlRow +
      controls +
    '</div>';
  }

  function _renderSignupList(container, signups, eventIdForPanel) {
    if (!signups || signups.length === 0) {
      container.innerHTML = '<div style="display: flex; justify-content: space-between; align-items: center;">' +
        '<h3>Sign-ups</h3>' +
        '<button class="btn btn--sm btn--outline" onclick="ManageEvents.closeSignups()">Close</button>' +
      '</div>' +
      '<p class="text-muted mt-sm">No sign-ups yet for this event.</p>';
      return;
    }

    var html = '<div style="display: flex; justify-content: space-between; align-items: center;">' +
      '<h3>Sign-ups (' + signups.length + ')</h3>' +
      '<button class="btn btn--sm btn--outline" onclick="ManageEvents.closeSignups()">Close</button>' +
    '</div>' +
    '<table style="width: 100%; margin-top: 12px; border-collapse: collapse;">' +
      '<thead><tr style="border-bottom: 1px solid #dee2e6;">' +
        '<th style="text-align: left; padding: 8px;">Email</th>' +
        '<th style="text-align: left; padding: 8px;">Name</th>' +
        '<th style="text-align: left; padding: 8px;">Signed Up</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < signups.length; i++) {
      var s = signups[i];
      html += '<tr style="border-bottom: 1px solid #f0f0f0;">' +
        '<td style="padding: 8px;">' + _escapeHtml(s.email || '') + '</td>' +
        '<td style="padding: 8px;">' + _escapeHtml(s.displayName || s.name || '-') + '</td>' +
        '<td style="padding: 8px;">' + (s.signedUpAt ? new Date(s.signedUpAt).toLocaleString() : '-') + '</td>' +
      '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // --- Private Helpers ---

  function _hideCreateForm() {
    var form = document.getElementById('create-event-form');
    if (form) {
      form.style.display = 'none';
      // Reset form fields
      var inputs = form.querySelectorAll('input, textarea');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].value = '';
      }
    }
  }

  function _hideEditForm() {
    hideEditForm();
  }

  function _showFormError(message) {
    var el = document.getElementById('form-error');
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
    }
  }

  function _setFormLoading(loading) {
    var btn = document.getElementById('form-submit-btn');
    if (btn) {
      btn.disabled = loading;
      if (loading) {
        btn.setAttribute('data-original-text', btn.textContent);
        btn.textContent = 'Saving...';
      } else {
        var original = btn.getAttribute('data-original-text');
        if (original) btn.textContent = original;
      }
    }
  }

  function _showNotification(message) {
    // Use global notification if available, otherwise alert
    if (typeof showNotification === 'function') {
      showNotification(message);
    } else {
      var notif = document.getElementById('manage-notification');
      if (!notif) {
        notif = document.createElement('div');
        notif.id = 'manage-notification';
        notif.style.cssText = 'position: fixed; top: 16px; right: 16px; padding: 12px 20px; background: #232F3E; color: #fff; border-radius: 8px; z-index: 9999; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);';
        document.body.appendChild(notif);
      }
      notif.textContent = message;
      notif.style.display = 'block';
      setTimeout(function() {
        notif.style.display = 'none';
      }, 4000);
    }
  }

  /**
   * Make an authenticated API request.
   * @param {string} method - HTTP method
   * @param {string} path - API path
   * @param {object} [body] - Request body
   * @returns {Promise<object>} Response data
   */
  async function _apiRequest(method, path, body) {
    var token = Auth.getIdToken();
    if (!token) {
      throw new Error('Not authenticated. Please sign in.');
    }

    var options = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    var response = await fetch(API_BASE + path, options);

    if (!response.ok) {
      var errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = {};
      }
      throw new Error(errorData.message || errorData.error || 'Request failed (' + response.status + ')');
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {};
    }

    return response.json();
  }

  function _escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function _escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Public API ---
  return {
    renderPage: renderPage,
    init: init,
    loadEvents: loadEvents,
    createEvent: createEvent,
    editEvent: editEvent,
    deleteEvent: deleteEvent,
    startEvent: startEvent,
    stopEvent: stopEvent,
    viewSignups: viewSignups,
    closeSignups: closeSignups,
    showCreateForm: showCreateForm,
    showEditForm: showEditForm,
    hideEditForm: hideEditForm,
    hideCreateForm: _hideCreateForm
  };
})();

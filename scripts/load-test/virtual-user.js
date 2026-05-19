'use strict';

const WebSocket = require('ws');

class VirtualUser {
  constructor(userId, config, report) {
    this.userId = userId;
    this.config = config;
    this.report = report;
    this.ws = null;
    this.authToken = null;
  }

  async authenticate() {
    const start = Date.now();
    try {
      // Simulate authentication - in real usage this would call Cognito
      const res = await fetch(`${this.config.apiUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `${this.config.testUserPrefix}-${this.userId}`,
          password: this.config.testUserPassword,
        }),
      });
      if (!res.ok) {
        throw new Error(`Auth failed: ${res.status}`);
      }
      const data = await res.json();
      this.authToken = data.token || data.IdToken || 'mock-token';
      this.report.recordLatency('authenticate', Date.now() - start);
    } catch (err) {
      this.report.recordError('authenticate', err);
      throw err;
    }
  }

  async connectWebSocket(eventId) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const url = `${this.config.wsUrl}?token=${this.authToken}&eventId=${eventId}`;
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        this.ws.terminate();
        const err = new Error('WebSocket connect timeout');
        this.report.recordError('ws_connect', err);
        reject(err);
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.report.recordLatency('ws_connect', Date.now() - start);
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.report.recordError('ws_connect', err);
        reject(err);
      });
    });
  }

  async sendAction(action, payload) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const err = new Error('WebSocket not connected');
        this.report.recordError(action, err);
        return reject(err);
      }

      const message = JSON.stringify({ action, ...payload });
      this.ws.send(message, (err) => {
        if (err) {
          this.report.recordError(action, err);
          return reject(err);
        }
        this.report.recordLatency(action, Date.now() - start);
        resolve();
      });
    });
  }

  async httpRequest(method, path, body) {
    const operation = `${method} ${path}`;
    const start = Date.now();
    try {
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
        },
      };
      if (body) {
        options.body = JSON.stringify(body);
      }
      const res = await fetch(`${this.config.apiUrl}${path}`, options);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      this.report.recordLatency(operation, Date.now() - start);
      return data;
    } catch (err) {
      this.report.recordError(operation, err);
      throw err;
    }
  }

  async disconnect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = VirtualUser;

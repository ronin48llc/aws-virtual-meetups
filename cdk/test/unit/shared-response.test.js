'use strict';

const {
  buildResponse,
  success,
  created,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  serverError,
} = require('../../lambda/shared/response');

describe('shared/response', () => {
  describe('buildResponse', () => {
    it('returns correct structure with CORS headers', () => {
      const res = buildResponse(200, { ok: true });
      expect(res.statusCode).toBe(200);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    it('handles string body without double-stringifying', () => {
      const res = buildResponse(200, '{"raw":true}');
      expect(res.body).toBe('{"raw":true}');
    });

    it('merges extra headers', () => {
      const res = buildResponse(200, {}, { 'X-Custom': 'value' });
      expect(res.headers['X-Custom']).toBe('value');
    });
  });

  describe('success', () => {
    it('returns 200 with data', () => {
      const res = success({ items: [1, 2, 3] });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ items: [1, 2, 3] });
    });
  });

  describe('created', () => {
    it('returns 201 with data', () => {
      const res = created({ id: 'evt_123' });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ id: 'evt_123' });
    });
  });

  describe('badRequest', () => {
    it('returns 400 with error message', () => {
      const res = badRequest('Missing title');
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Bad Request');
      expect(body.message).toBe('Missing title');
    });
  });

  describe('unauthorized', () => {
    it('returns 401 with default message', () => {
      const res = unauthorized();
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Authentication required');
    });

    it('returns 401 with custom message', () => {
      const res = unauthorized('Token expired');
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Token expired');
    });
  });

  describe('forbidden', () => {
    it('returns 403 with default message', () => {
      const res = forbidden();
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Forbidden');
      expect(body.message).toBe('Access denied');
    });
  });

  describe('notFound', () => {
    it('returns 404 with default message', () => {
      const res = notFound();
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not Found');
    });
  });

  describe('serverError', () => {
    it('returns 500 with default message', () => {
      const res = serverError();
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Internal Server Error');
      expect(body.message).toBe('Internal server error');
    });

    it('returns 500 with custom message', () => {
      const res = serverError('Database connection failed');
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Database connection failed');
    });
  });
});

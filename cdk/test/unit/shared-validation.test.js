'use strict';

const {
  validateRequiredFields,
  isFutureDate,
  isValidDate,
  isValidEmail,
  isValidLength,
  sanitize,
  parseBody,
} = require('../../lambda/shared/validation');

describe('shared/validation', () => {
  describe('validateRequiredFields', () => {
    it('returns valid when all fields are present', () => {
      const result = validateRequiredFields({ title: 'Test', description: 'Desc' }, ['title', 'description']);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('returns invalid with missing fields', () => {
      const result = validateRequiredFields({ title: 'Test' }, ['title', 'description']);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(['description']);
    });

    it('treats empty string as missing', () => {
      const result = validateRequiredFields({ title: '' }, ['title']);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(['title']);
    });

    it('treats null as missing', () => {
      const result = validateRequiredFields({ title: null }, ['title']);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(['title']);
    });

    it('handles null/undefined object', () => {
      const result = validateRequiredFields(null, ['title']);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(['title']);
    });
  });

  describe('isFutureDate', () => {
    it('returns true for a future date', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      expect(isFutureDate(future)).toBe(true);
    });

    it('returns false for a past date', () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      expect(isFutureDate(past)).toBe(false);
    });

    it('returns false for invalid date string', () => {
      expect(isFutureDate('not-a-date')).toBe(false);
    });
  });

  describe('isValidDate', () => {
    it('returns true for valid ISO date', () => {
      expect(isValidDate('2024-01-15T10:30:00Z')).toBe(true);
    });

    it('returns false for invalid date', () => {
      expect(isValidDate('not-a-date')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isValidDate(null)).toBe(false);
      expect(isValidDate(undefined)).toBe(false);
    });
  });

  describe('isValidEmail', () => {
    it('returns true for valid email', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
    });

    it('returns true for email with subdomain', () => {
      expect(isValidEmail('user@mail.example.com')).toBe(true);
    });

    it('returns false for missing @', () => {
      expect(isValidEmail('userexample.com')).toBe(false);
    });

    it('returns false for missing domain', () => {
      expect(isValidEmail('user@')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidEmail('')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isValidEmail(null)).toBe(false);
    });
  });

  describe('isValidLength', () => {
    it('returns true when within bounds', () => {
      expect(isValidLength('hello', 1, 10)).toBe(true);
    });

    it('returns true at exact min boundary', () => {
      expect(isValidLength('a', 1, 10)).toBe(true);
    });

    it('returns true at exact max boundary', () => {
      expect(isValidLength('1234567890', 1, 10)).toBe(true);
    });

    it('returns false when too short', () => {
      expect(isValidLength('', 1, 10)).toBe(false);
    });

    it('returns false when too long', () => {
      expect(isValidLength('12345678901', 1, 10)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isValidLength(null, 1, 10)).toBe(false);
    });
  });

  describe('sanitize', () => {
    it('trims whitespace', () => {
      expect(sanitize('  hello  ')).toBe('hello');
    });

    it('removes control characters', () => {
      expect(sanitize('hello\x00world')).toBe('helloworld');
    });

    it('returns empty string for null', () => {
      expect(sanitize(null)).toBe('');
    });
  });

  describe('parseBody', () => {
    it('parses valid JSON string', () => {
      const result = parseBody('{"title":"Test"}');
      expect(result.valid).toBe(true);
      expect(result.data).toEqual({ title: 'Test' });
    });

    it('returns object directly if already parsed', () => {
      const obj = { title: 'Test' };
      const result = parseBody(obj);
      expect(result.valid).toBe(true);
      expect(result.data).toBe(obj);
    });

    it('returns error for invalid JSON', () => {
      const result = parseBody('not json');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid JSON in request body');
    });

    it('returns error for empty body', () => {
      const result = parseBody(null);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Request body is empty');
    });
  });
});

'use strict';

const {
  EVENT_STATUS,
  KEY_PREFIX,
  SK,
  GSI,
  BRANDING,
  USER_ROLE,
  SESSION_ROLE,
  QUESTION_STATUS,
  CORS_HEADERS,
} = require('../../lambda/shared/constants');

describe('shared/constants', () => {
  describe('EVENT_STATUS', () => {
    it('should define all lifecycle statuses', () => {
      expect(EVENT_STATUS.SCHEDULED).toBe('scheduled');
      expect(EVENT_STATUS.LIVE).toBe('live');
      expect(EVENT_STATUS.ENDED).toBe('ended');
      expect(EVENT_STATUS.PUBLISHED).toBe('published');
    });

    it('should be frozen', () => {
      expect(Object.isFrozen(EVENT_STATUS)).toBe(true);
    });
  });

  describe('KEY_PREFIX', () => {
    it('should define all DynamoDB key prefixes', () => {
      expect(KEY_PREFIX.EVENT).toBe('EVENT#');
      expect(KEY_PREFIX.USER).toBe('USER#');
      expect(KEY_PREFIX.SIGNUP).toBe('SIGNUP#');
      expect(KEY_PREFIX.CONN).toBe('CONN#');
      expect(KEY_PREFIX.HAND).toBe('HAND#');
      expect(KEY_PREFIX.QUESTION).toBe('QUESTION#');
    });

    it('should be frozen', () => {
      expect(Object.isFrozen(KEY_PREFIX)).toBe(true);
    });
  });

  describe('SK', () => {
    it('should define sort key constants', () => {
      expect(SK.METADATA).toBe('METADATA');
      expect(SK.PROFILE).toBe('PROFILE');
      expect(SK.RECORDING).toBe('RECORDING');
    });
  });

  describe('GSI', () => {
    it('should define GSI key constants', () => {
      expect(GSI.GSI1_UPCOMING_PK).toBe('EVENTS#UPCOMING');
    });
  });

  describe('BRANDING', () => {
    it('should define AWS community branding colors', () => {
      expect(BRANDING.AWS_ORANGE).toBe('#FF9900');
      expect(BRANDING.SQUID_INK).toBe('#232F3E');
      expect(BRANDING.CLOUD_BLUE).toBe('#1B659D');
      expect(BRANDING.LIME).toBe('#7AA116');
    });
  });

  describe('USER_ROLE', () => {
    it('should define platform roles', () => {
      expect(USER_ROLE.ORGANIZER).toBe('organizer');
      expect(USER_ROLE.MEMBER).toBe('member');
    });
  });

  describe('SESSION_ROLE', () => {
    it('should define session participant roles', () => {
      expect(SESSION_ROLE.PRESENTER).toBe('presenter');
      expect(SESSION_ROLE.CO_PRESENTER).toBe('co-presenter');
      expect(SESSION_ROLE.ATTENDEE).toBe('attendee');
    });
  });

  describe('QUESTION_STATUS', () => {
    it('should define question statuses', () => {
      expect(QUESTION_STATUS.QUEUED).toBe('queued');
      expect(QUESTION_STATUS.ANSWERED).toBe('answered');
      expect(QUESTION_STATUS.DISMISSED).toBe('dismissed');
    });
  });

  describe('CORS_HEADERS', () => {
    it('should include required CORS headers', () => {
      expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
      expect(CORS_HEADERS['Access-Control-Allow-Headers']).toContain('Authorization');
      expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('GET');
    });
  });
});

'use strict';

const { info, warn, error, debug, stateTransition, createLogger, extractRequestId } = require('../../lambda/shared/logger');

describe('shared/logger', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('info', () => {
    it('should emit JSON with INFO level', () => {
      info('Test message');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('INFO');
      expect(output.message).toBe('Test message');
      expect(output.timestamp).toBeDefined();
    });

    it('should include context fields', () => {
      info('Event created', {
        requestId: 'req-123',
        eventId: 'evt_abc',
        userId: 'user-1',
        action: 'createEvent',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.requestId).toBe('req-123');
      expect(output.eventId).toBe('evt_abc');
      expect(output.userId).toBe('user-1');
      expect(output.action).toBe('createEvent');
    });

    it('should include duration field', () => {
      info('Request completed', { duration: 150 });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.duration).toBe(150);
    });

    it('should include error field', () => {
      info('Error occurred', { error: 'Something went wrong' });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.error).toBe('Something went wrong');
    });

    it('should merge extra fields', () => {
      info('Custom data', { extra: { method: 'POST', path: '/events' } });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.method).toBe('POST');
      expect(output.path).toBe('/events');
    });

    it('should omit undefined fields for clean output', () => {
      info('Minimal log');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(Object.keys(output)).toEqual(['timestamp', 'level', 'message']);
    });
  });

  describe('warn', () => {
    it('should emit JSON with WARN level', () => {
      warn('Warning message');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('WARN');
      expect(output.message).toBe('Warning message');
    });
  });

  describe('error', () => {
    it('should emit JSON with ERROR level', () => {
      error('Error message', { error: 'details' });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('ERROR');
      expect(output.message).toBe('Error message');
      expect(output.error).toBe('details');
    });
  });

  describe('debug', () => {
    it('should emit JSON with DEBUG level', () => {
      debug('Debug message');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('DEBUG');
    });
  });

  describe('stateTransition', () => {
    it('should log state transitions with previous and new state', () => {
      stateTransition('eventStart', {
        eventId: 'evt_123',
        userId: 'user-1',
        previousState: 'scheduled',
        newState: 'live',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('INFO');
      expect(output.message).toBe('State transition: eventStart');
      expect(output.action).toBe('eventStart');
      expect(output.eventId).toBe('evt_123');
      expect(output.previousState).toBe('scheduled');
      expect(output.newState).toBe('live');
    });
  });

  describe('createLogger', () => {
    it('should create a logger bound to the request ID from REST API event', () => {
      const event = {
        requestContext: {
          requestId: 'apigw-req-456',
        },
      };

      const logger = createLogger(event);
      expect(logger.requestId).toBe('apigw-req-456');

      logger.info('Bound log');
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.requestId).toBe('apigw-req-456');
    });

    it('should create a logger bound to the request ID from WebSocket event', () => {
      const event = {
        requestContext: {
          requestId: 'ws-req-789',
          connectionId: 'conn-abc',
        },
      };

      const logger = createLogger(event);
      expect(logger.requestId).toBe('ws-req-789');
    });

    it('should handle missing requestContext gracefully', () => {
      const logger = createLogger({});
      expect(logger.requestId).toBeUndefined();

      logger.info('No request ID');
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.requestId).toBeUndefined();
    });

    it('should provide all log level methods', () => {
      const logger = createLogger({ requestContext: { requestId: 'r1' } });

      logger.info('info');
      logger.warn('warn');
      logger.error('error');
      logger.debug('debug');

      expect(consoleSpy).toHaveBeenCalledTimes(4);
      expect(JSON.parse(consoleSpy.mock.calls[0][0]).level).toBe('INFO');
      expect(JSON.parse(consoleSpy.mock.calls[1][0]).level).toBe('WARN');
      expect(JSON.parse(consoleSpy.mock.calls[2][0]).level).toBe('ERROR');
      expect(JSON.parse(consoleSpy.mock.calls[3][0]).level).toBe('DEBUG');
    });

    it('should provide stateTransition method with bound requestId', () => {
      const logger = createLogger({ requestContext: { requestId: 'r2' } });

      logger.stateTransition('roleChange', {
        eventId: 'evt_1',
        previousState: 'attendee',
        newState: 'co-presenter',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.requestId).toBe('r2');
      expect(output.action).toBe('roleChange');
      expect(output.previousState).toBe('attendee');
      expect(output.newState).toBe('co-presenter');
    });
  });

  describe('extractRequestId', () => {
    it('should extract requestId from event.requestContext', () => {
      expect(extractRequestId({ requestContext: { requestId: 'abc' } })).toBe('abc');
    });

    it('should return undefined for null event', () => {
      expect(extractRequestId(null)).toBeUndefined();
    });

    it('should return undefined for event without requestContext', () => {
      expect(extractRequestId({})).toBeUndefined();
    });
  });
});

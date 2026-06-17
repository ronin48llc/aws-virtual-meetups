'use strict';

describe('Chat Review Handler', () => {
  let handler;
  let internals;

  beforeEach(() => {
    jest.resetModules();
    process.env.URL_BLOCKLIST = '';
  });

  afterEach(() => {
    delete process.env.URL_BLOCKLIST;
  });

  function loadHandler() {
    const mod = require('../../lambda/chat-review/index');
    handler = mod.handler;
    internals = mod._internals;
    return mod;
  }

  function buildEvent(content, overrides = {}) {
    return {
      Content: content,
      MessageId: 'msg-123',
      RoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/test-room',
      Attributes: {},
      SenderId: 'user-456',
      ...overrides,
    };
  }

  describe('Message length validation', () => {
    it('allows messages within 500 character limit', async () => {
      loadHandler();
      const event = buildEvent('Hello, this is a normal message!');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
      expect(result.Content).toBe('Hello, this is a normal message!');
    });

    it('allows messages exactly at 500 characters', async () => {
      loadHandler();
      const content = 'a'.repeat(500);
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
      expect(result.Content).toBe(content);
    });

    it('rejects messages exceeding 500 characters', async () => {
      loadHandler();
      const content = 'a'.repeat(501);
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
      expect(result.Content).toBe(content);
    });

    it('rejects very long messages', async () => {
      loadHandler();
      const content = 'x'.repeat(10000);
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });
  });

  describe('Base64 data pattern detection', () => {
    it('rejects messages with data:image base64 URI', async () => {
      loadHandler();
      const content = 'Check this out: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('rejects messages with data:application base64 URI', async () => {
      loadHandler();
      const content = 'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago=';
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('rejects messages with data:text base64 URI', async () => {
      loadHandler();
      const content = 'data:text/html;base64,PGh0bWw+PGJvZHk+SGVsbG88L2JvZHk+PC9odG1sPg==';
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('rejects messages with long base64 strings (50+ chars)', async () => {
      loadHandler();
      // Realistic base64 with mixed case (PNG header encoded)
      const base64String = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADU';
      const content = `Here is some data: ${base64String}`;
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('allows messages with short alphanumeric strings', async () => {
      loadHandler();
      const content = 'The meeting code is ABC123XYZ and the room is 456DEF';
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });

    it('allows normal messages that mention "base64" as text', async () => {
      loadHandler();
      const content = 'How do I encode to base64?';
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });
  });

  describe('URL blocklist', () => {
    it('rejects messages containing blocked URLs', async () => {
      process.env.URL_BLOCKLIST = 'drive.google.com,dropbox.com,wetransfer.com';
      loadHandler();

      const event = buildEvent('Check this file: https://drive.google.com/file/d/abc123');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('rejects messages with dropbox links', async () => {
      process.env.URL_BLOCKLIST = 'drive.google.com,dropbox.com,wetransfer.com';
      loadHandler();

      const event = buildEvent('Download from https://dropbox.com/s/xyz/file.pdf');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('rejects messages with blocked domain without protocol', async () => {
      process.env.URL_BLOCKLIST = 'mega.nz,wetransfer.com';
      loadHandler();

      const event = buildEvent('Get it from mega.nz/file/abc');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('allows messages with non-blocked URLs', async () => {
      process.env.URL_BLOCKLIST = 'drive.google.com,dropbox.com';
      loadHandler();

      const event = buildEvent('Check out https://example.com/article');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });

    it('allows all URLs when blocklist is empty', async () => {
      process.env.URL_BLOCKLIST = '';
      loadHandler();

      const event = buildEvent('https://drive.google.com/file/d/abc123');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });

    it('allows all URLs when blocklist env var is not set', async () => {
      delete process.env.URL_BLOCKLIST;
      loadHandler();

      const event = buildEvent('https://dropbox.com/s/xyz/file.pdf');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });

    it('handles blocklist with extra whitespace', async () => {
      process.env.URL_BLOCKLIST = ' drive.google.com , dropbox.com , wetransfer.com ';
      loadHandler();

      const event = buildEvent('Link: https://wetransfer.com/downloads/abc');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    it('performs case-insensitive URL matching', async () => {
      process.env.URL_BLOCKLIST = 'dropbox.com';
      loadHandler();

      const event = buildEvent('Get it from https://DROPBOX.COM/s/file');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
    });

    // Issue #95: previously, the presence of any http(s) URL would skip the
    // bare-domain scan entirely, so an attacker could pad a blocked
    // bare-domain reference with any unrelated URL and evade moderation.
    describe('Issue #95: bare-domain check must run even when URLs present', () => {
      it('denies blocked bare-domain reference alongside a benign URL', async () => {
        process.env.URL_BLOCKLIST = 'drive.google.com,dropbox.com';
        loadHandler();

        const event = buildEvent('http://example.com drive.google.com/evil');
        const result = await handler(event);

        expect(result.ReviewResult).toBe('DENY');
      });

      it('denies blocked bare-domain after a wikipedia link', async () => {
        process.env.URL_BLOCKLIST = 'dropbox.com';
        loadHandler();

        const event = buildEvent('See https://en.wikipedia.org/wiki/X and also dropbox.com/share/abc');
        const result = await handler(event);

        expect(result.ReviewResult).toBe('DENY');
      });

      it('denies blocked domain mid-sentence among multiple URLs', async () => {
        process.env.URL_BLOCKLIST = 'mega.nz';
        loadHandler();

        const event = buildEvent('Mirrors: https://archive.org https://example.com — original on mega.nz/file/abc — backup elsewhere');
        const result = await handler(event);

        expect(result.ReviewResult).toBe('DENY');
      });

      it('case-insensitive bare-domain bypass also blocked', async () => {
        process.env.URL_BLOCKLIST = 'wetransfer.com';
        loadHandler();

        const event = buildEvent('https://example.com — file at WeTransfer.COM/downloads/xyz');
        const result = await handler(event);

        expect(result.ReviewResult).toBe('DENY');
      });
    });

    describe('Issue #95: blocklist memoization', () => {
      it('compiles the blocklist once at module load, not per invocation', () => {
        process.env.URL_BLOCKLIST = 'drive.google.com';
        const mod = loadHandler();
        const first = mod._internals.CACHED_BLOCKLIST;

        // Mutating the env var after module load must not change cached blocklist.
        process.env.URL_BLOCKLIST = 'something-else.com';
        const second = mod._internals.CACHED_BLOCKLIST;

        expect(second).toBe(first);
        expect(first).toHaveLength(1);
        expect(first[0].test('drive.google.com')).toBe(true);
        expect(first[0].test('something-else.com')).toBe(false);
      });
    });
  });

  describe('Edge cases', () => {
    it('handles empty message content', async () => {
      loadHandler();
      const event = buildEvent('');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
      expect(result.Content).toBe('');
    });

    it('handles missing Content field', async () => {
      loadHandler();
      const event = {
        MessageId: 'msg-123',
        RoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/test-room',
        Attributes: {},
        SenderId: 'user-456',
      };
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
      expect(result.Content).toBe('');
    });

    it('allows normal chat messages', async () => {
      process.env.URL_BLOCKLIST = 'drive.google.com,dropbox.com';
      loadHandler();

      const event = buildEvent('Great presentation! I have a question about slide 3.');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });

    it('allows messages with emojis', async () => {
      loadHandler();
      const event = buildEvent('Great talk! 🎉👏 Really enjoyed it!');
      const result = await handler(event);

      expect(result.ReviewResult).toBe('ALLOW');
    });

    it('returns original content in response even when denied', async () => {
      loadHandler();
      const content = 'a'.repeat(501);
      const event = buildEvent(content);
      const result = await handler(event);

      expect(result.ReviewResult).toBe('DENY');
      expect(result.Content).toBe(content);
    });
  });

  describe('Internal functions', () => {
    beforeEach(() => {
      loadHandler();
    });

    describe('getUrlBlocklist', () => {
      it('returns empty array when env var is empty', () => {
        process.env.URL_BLOCKLIST = '';
        const result = internals.getUrlBlocklist();
        expect(result).toEqual([]);
      });

      it('returns empty array when env var is whitespace only', () => {
        process.env.URL_BLOCKLIST = '   ';
        const result = internals.getUrlBlocklist();
        expect(result).toEqual([]);
      });

      it('parses comma-separated patterns into regex array', () => {
        process.env.URL_BLOCKLIST = 'drive.google.com,dropbox.com';
        const result = internals.getUrlBlocklist();
        expect(result).toHaveLength(2);
        expect(result[0]).toBeInstanceOf(RegExp);
        expect(result[1]).toBeInstanceOf(RegExp);
      });

      it('escapes special regex characters in patterns', () => {
        process.env.URL_BLOCKLIST = 'mega.nz';
        const result = internals.getUrlBlocklist();
        // The dot should be escaped, so "meganZ" should NOT match
        expect(result[0].test('meganZ')).toBe(false);
        // But "mega.nz" should match
        expect(result[0].test('mega.nz')).toBe(true);
      });
    });

    describe('containsBase64Data', () => {
      it('detects data URI patterns', () => {
        expect(internals.containsBase64Data('data:image/png;base64,abc')).toBe(true);
      });

      it('detects long base64 strings', () => {
        expect(internals.containsBase64Data('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADU')).toBe(true);
      });

      it('does not flag short strings', () => {
        expect(internals.containsBase64Data('Hello world')).toBe(false);
      });

      it('does not flag strings just under threshold', () => {
        // Single-case repeated chars don't match the mixed-case pattern
        expect(internals.containsBase64Data('A'.repeat(49))).toBe(false);
      });
    });

    describe('containsBlockedUrl', () => {
      it('detects blocked URLs with protocol', () => {
        const blocklist = [/dropbox\.com/i];
        expect(internals.containsBlockedUrl('https://dropbox.com/file', blocklist)).toBe(true);
      });

      it('detects blocked domains without protocol', () => {
        const blocklist = [/mega\.nz/i];
        expect(internals.containsBlockedUrl('get it from mega.nz/file', blocklist)).toBe(true);
      });

      it('returns false for non-blocked content', () => {
        const blocklist = [/dropbox\.com/i];
        expect(internals.containsBlockedUrl('visit example.com', blocklist)).toBe(false);
      });

      it('returns false for empty blocklist', () => {
        expect(internals.containsBlockedUrl('https://dropbox.com/file', [])).toBe(false);
      });
    });
  });
});

'use strict';

// Set env before requiring handler
process.env.AWS_REGION = 'us-east-1';
process.env.RECORDING_BUCKET_NAME = 'test-recordings-bucket';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token';
process.env.GITHUB_REPO = 'meetup-recordings';
process.env.GITHUB_OWNER = 'aws-community';
process.env.CLOUDFRONT_DOMAIN = 'd1234567890.cloudfront.net';
process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:VirtualMeetup-EmailSender';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: mockSend })),
    GetObjectCommand: jest.fn((params) => ({ input: params })),
    __mockSend: mockSend,
  };
});

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const mockSend = jest.fn();
  return {
    SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
    GetSecretValueCommand: jest.fn((params) => ({ input: params })),
    __mockSend: mockSend,
  };
});

jest.mock('@aws-sdk/client-lambda', () => {
  const mockSend = jest.fn();
  return {
    LambdaClient: jest.fn(() => ({ send: mockSend })),
    InvokeCommand: jest.fn((params) => ({ input: params })),
    __mockSend: mockSend,
  };
});

// Mock global fetch
global.fetch = jest.fn();

const { handler, _internals } = require('../../lambda/publisher/index');
const {
  extractS3Details,
  extractEventId,
  parseTranscriptSegments,
  formatTimestamp,
  generateWebVTT,
  generateJekyllPost,
  escapeYaml,
  formatDateForFilename,
} = _internals;

const s3Module = require('@aws-sdk/client-s3');
const secretsModule = require('@aws-sdk/client-secrets-manager');
const lambdaModule = require('@aws-sdk/client-lambda');

describe('Publisher Lambda - extractS3Details', () => {
  it('extracts bucket and key from EventBridge S3 event detail', () => {
    const event = {
      detail: {
        bucket: { name: 'my-bucket' },
        object: { key: 'recordings/evt_123/metadata.json' },
      },
    };
    const result = extractS3Details(event);
    expect(result).toEqual({
      bucket: 'my-bucket',
      key: 'recordings/evt_123/metadata.json',
    });
  });

  it('extracts from requestParameters format', () => {
    const event = {
      detail: {
        requestParameters: {
          bucketName: 'alt-bucket',
          key: 'recordings/evt_456/media/master.m3u8',
        },
      },
    };
    const result = extractS3Details(event);
    expect(result).toEqual({
      bucket: 'alt-bucket',
      key: 'recordings/evt_456/media/master.m3u8',
    });
  });

  it('returns null for events without S3 details', () => {
    const event = { detail: {} };
    expect(extractS3Details(event)).toBeNull();
  });

  it('returns null for events without detail', () => {
    const event = {};
    expect(extractS3Details(event)).toBeNull();
  });
});

describe('Publisher Lambda - extractEventId', () => {
  it('extracts eventId from recordings prefix key', () => {
    expect(extractEventId('recordings/evt_abc123/media/master.m3u8')).toBe('evt_abc123');
  });

  it('extracts eventId from metadata key', () => {
    expect(extractEventId('recordings/my-event-id/metadata.json')).toBe('my-event-id');
  });

  it('returns null for keys without recordings prefix', () => {
    expect(extractEventId('other/path/file.json')).toBeNull();
  });

  it('returns null for empty key', () => {
    expect(extractEventId('')).toBeNull();
  });
});

describe('Publisher Lambda - parseTranscriptSegments', () => {
  it('parses timestamped transcript lines', () => {
    const text = '00:00:01.000 --> 00:00:04.500 | Welcome to the meetup\n00:00:05.000 --> 00:00:08.000 | Today we discuss Lambda';
    const segments = parseTranscriptSegments(text);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      startTime: '00:00:01.000',
      endTime: '00:00:04.500',
      text: 'Welcome to the meetup',
    });
    expect(segments[1]).toEqual({
      startTime: '00:00:05.000',
      endTime: '00:00:08.000',
      text: 'Today we discuss Lambda',
    });
  });

  it('handles plain text lines with auto-generated timestamps', () => {
    const text = 'Hello world\nSecond line\nThird line';
    const segments = parseTranscriptSegments(text);
    expect(segments).toHaveLength(3);
    expect(segments[0].startTime).toBe('00:00:00.000');
    expect(segments[0].endTime).toBe('00:00:05.000');
    expect(segments[0].text).toBe('Hello world');
    expect(segments[1].startTime).toBe('00:00:05.000');
    expect(segments[1].endTime).toBe('00:00:10.000');
    expect(segments[2].startTime).toBe('00:00:10.000');
    expect(segments[2].endTime).toBe('00:00:15.000');
  });

  it('returns empty array for empty text', () => {
    expect(parseTranscriptSegments('')).toEqual([]);
    expect(parseTranscriptSegments(null)).toEqual([]);
    expect(parseTranscriptSegments(undefined)).toEqual([]);
  });

  it('skips blank lines', () => {
    const text = 'Line one\n\n\nLine two\n';
    const segments = parseTranscriptSegments(text);
    expect(segments).toHaveLength(2);
  });
});

describe('Publisher Lambda - formatTimestamp', () => {
  it('formats 0 seconds', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000');
  });

  it('formats seconds only', () => {
    expect(formatTimestamp(45)).toBe('00:00:45.000');
  });

  it('formats minutes and seconds', () => {
    expect(formatTimestamp(125)).toBe('00:02:05.000');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatTimestamp(3661)).toBe('01:01:01.000');
  });
});

describe('Publisher Lambda - generateWebVTT', () => {
  it('generates valid WebVTT with header', () => {
    const segments = [
      { startTime: '00:00:01.000', endTime: '00:00:04.000', text: 'Hello' },
    ];
    const vtt = generateWebVTT(segments);
    expect(vtt).toMatch(/^WEBVTT\n/);
  });

  it('generates numbered cues', () => {
    const segments = [
      { startTime: '00:00:01.000', endTime: '00:00:04.000', text: 'First cue' },
      { startTime: '00:00:05.000', endTime: '00:00:08.000', text: 'Second cue' },
    ];
    const vtt = generateWebVTT(segments);
    expect(vtt).toContain('1\n00:00:01.000 --> 00:00:04.000\nFirst cue');
    expect(vtt).toContain('2\n00:00:05.000 --> 00:00:08.000\nSecond cue');
  });

  it('returns only header for empty segments', () => {
    const vtt = generateWebVTT([]);
    expect(vtt).toBe('WEBVTT\n\n');
  });
});

describe('Publisher Lambda - generateJekyllPost', () => {
  const metadata = {
    title: 'AWS Lambda Deep Dive',
    description: 'Learn advanced Lambda patterns',
    scheduledStart: '2024-03-15T18:00:00Z',
    duration: 5400,
  };
  const hlsUrl = 'https://d123.cloudfront.net/recordings/evt_123/media/master.m3u8';
  const captionPath = '/assets/captions/evt_123.vtt';

  it('includes YAML front matter', () => {
    const post = generateJekyllPost(metadata, hlsUrl, captionPath);
    expect(post).toMatch(/^---\n/);
    expect(post).toContain('title: "AWS Lambda Deep Dive"');
    expect(post).toContain('date: 2024-03-15T18:00:00Z');
    expect(post).toContain('description: "Learn advanced Lambda patterns"');
    expect(post).toContain(`hls_url: "${hlsUrl}"`);
    expect(post).toContain(`caption_url: "${captionPath}"`);
    expect(post).toContain('duration: 5400');
    expect(post).toContain('layout: recording');
  });

  it('includes HLS player script', () => {
    const post = generateJekyllPost(metadata, hlsUrl, captionPath);
    expect(post).toContain('hls.js');
    expect(post).toContain('recording-player');
    expect(post).toContain(hlsUrl);
  });

  it('includes caption track reference', () => {
    const post = generateJekyllPost(metadata, hlsUrl, captionPath);
    expect(post).toContain(`<track kind="captions" src="${captionPath}"`);
  });

  it('handles missing metadata fields gracefully', () => {
    const minimalMetadata = {};
    const post = generateJekyllPost(minimalMetadata, hlsUrl, captionPath);
    expect(post).toContain('title: "Untitled Event"');
    expect(post).toContain('duration: 0');
  });

  it('escapes quotes in title', () => {
    const metaWithQuotes = { ...metadata, title: 'Event "Special" Edition' };
    const post = generateJekyllPost(metaWithQuotes, hlsUrl, captionPath);
    expect(post).toContain('title: "Event \\"Special\\" Edition"');
  });
});

describe('Publisher Lambda - escapeYaml', () => {
  it('escapes double quotes', () => {
    expect(escapeYaml('hello "world"')).toBe('hello \\"world\\"');
  });

  it('replaces newlines with spaces', () => {
    expect(escapeYaml('line1\nline2')).toBe('line1 line2');
  });

  it('handles empty string', () => {
    expect(escapeYaml('')).toBe('');
  });
});

describe('Publisher Lambda - formatDateForFilename', () => {
  it('formats ISO date string to YYYY-MM-DD', () => {
    expect(formatDateForFilename('2024-03-15T18:00:00Z')).toBe('2024-03-15');
  });

  it('formats date-only string', () => {
    expect(formatDateForFilename('2024-01-01')).toBe('2024-01-01');
  });

  it('returns today for invalid date', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(formatDateForFilename('not-a-date')).toBe(today);
  });

  it('returns today for undefined', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(formatDateForFilename(undefined)).toBe(today);
  });
});

describe('Publisher Lambda - handler integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockReset();
    lambdaModule.__mockSend.mockResolvedValue({});
  });

  function mockS3Responses(metadata, transcript) {
    const s3Send = s3Module.__mockSend;
    s3Send.mockImplementation((command) => {
      const key = command.input.Key;
      if (key.includes('metadata.json')) {
        return Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(metadata)) },
        });
      }
      if (key.includes('transcript.txt')) {
        return Promise.resolve({
          Body: { transformToString: () => Promise.resolve(transcript) },
        });
      }
      return Promise.reject(new Error(`Unexpected S3 key: ${key}`));
    });
  }

  function mockSecretsManager(token) {
    const smSend = secretsModule.__mockSend;
    smSend.mockResolvedValue({ SecretString: token });
  }

  function mockGitHubApi() {
    global.fetch.mockImplementation((url) => {
      if (url.includes('/git/ref/heads/main')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ object: { sha: 'abc123' } }),
        });
      }
      if (url.includes('/git/commits/abc123')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tree: { sha: 'tree123' } }),
        });
      }
      if (url.includes('/git/blobs')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sha: 'blob_' + Math.random().toString(36).slice(2) }),
        });
      }
      if (url.includes('/git/trees')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sha: 'newtree123' }),
        });
      }
      if (url.includes('/git/commits') && !url.includes('abc123')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sha: 'newcommit123' }),
        });
      }
      if (url.includes('/git/refs/heads/main')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ object: { sha: 'newcommit123' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  it('processes a valid EventBridge event and commits to GitHub', async () => {
    const metadata = {
      title: 'AWS Lambda Deep Dive',
      description: 'Learn advanced patterns',
      scheduledStart: '2024-03-15T18:00:00Z',
      duration: 5400,
    };
    const transcript = '00:00:01.000 --> 00:00:05.000 | Welcome everyone\n00:00:06.000 --> 00:00:10.000 | Today we talk about Lambda';

    mockS3Responses(metadata, transcript);
    mockSecretsManager('ghp_test_token_123');
    mockGitHubApi();

    const event = {
      detail: {
        bucket: { name: 'test-recordings-bucket' },
        object: { key: 'recordings/evt_abc123/metadata.json' },
      },
    };

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.eventId).toBe('evt_abc123');
    expect(body.message).toBe('Published successfully');

    // Verify GitHub API was called
    expect(global.fetch).toHaveBeenCalled();
    // Should have called: get ref, get commit, 3 blobs, create tree, create commit, update ref = 8 calls
    expect(global.fetch).toHaveBeenCalledTimes(8);
  });

  it('skips events without valid S3 details', async () => {
    const event = { detail: {} };
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Skipped');
  });

  it('skips events where eventId cannot be extracted', async () => {
    const event = {
      detail: {
        bucket: { name: 'test-bucket' },
        object: { key: 'other/path/file.json' },
      },
    };
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Skipped');
  });

  it('throws error when S3 read fails', async () => {
    const s3Send = s3Module.__mockSend;
    s3Send.mockRejectedValue(new Error('NoSuchKey'));

    const event = {
      detail: {
        bucket: { name: 'test-bucket' },
        object: { key: 'recordings/evt_fail/metadata.json' },
      },
    };

    await expect(handler(event)).rejects.toThrow('NoSuchKey');
  });

  it('throws error when GitHub API fails', async () => {
    const metadata = {
      title: 'Test Event',
      description: 'Test',
      scheduledStart: '2024-01-01T00:00:00Z',
      duration: 60,
    };
    const transcript = 'Hello world';

    mockS3Responses(metadata, transcript);
    mockSecretsManager('ghp_token');

    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const event = {
      detail: {
        bucket: { name: 'test-bucket' },
        object: { key: 'recordings/evt_ghfail/metadata.json' },
      },
    };

    await expect(handler(event)).rejects.toThrow('Failed to get ref');
  });

  it('invokes email Lambda with recap payload on successful publication', async () => {
    const metadata = {
      title: 'AWS Lambda Deep Dive',
      description: 'Learn advanced patterns',
      scheduledStart: '2024-03-15T18:00:00Z',
      duration: 5400,
    };
    const transcript = '00:00:01.000 --> 00:00:05.000 | Welcome everyone';

    mockS3Responses(metadata, transcript);
    mockSecretsManager('ghp_test_token_123');
    mockGitHubApi();

    const event = {
      detail: {
        bucket: { name: 'test-recordings-bucket' },
        object: { key: 'recordings/evt_recap123/metadata.json' },
      },
    };

    await handler(event);

    // Verify email Lambda was invoked
    expect(lambdaModule.__mockSend).toHaveBeenCalledTimes(1);
    const invokeCall = lambdaModule.InvokeCommand.mock.calls[0][0];
    expect(invokeCall.FunctionName).toBe(process.env.EMAIL_LAMBDA_ARN);
    expect(invokeCall.InvocationType).toBe('Event');
    const payload = JSON.parse(invokeCall.Payload);
    expect(payload.type).toBe('recap');
    expect(payload.eventId).toBe('evt_recap123');
    expect(payload.playbackUrl).toBe('https://d1234567890.cloudfront.net/recordings/evt_recap123/media/master.m3u8');
    expect(payload.duration).toBe(5400);
  });

  it('does not fail publication when email Lambda invocation fails', async () => {
    const metadata = {
      title: 'Test Event',
      description: 'Test',
      scheduledStart: '2024-01-01T00:00:00Z',
      duration: 120,
    };
    const transcript = 'Hello world';

    mockS3Responses(metadata, transcript);
    mockSecretsManager('ghp_token');
    mockGitHubApi();

    // Make email Lambda invocation fail
    lambdaModule.__mockSend.mockRejectedValue(new Error('Lambda invoke failed'));

    const event = {
      detail: {
        bucket: { name: 'test-recordings-bucket' },
        object: { key: 'recordings/evt_emailfail/metadata.json' },
      },
    };

    // Publication should still succeed
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Published successfully');
  });
});

// Issue #117: CDK provisions the GitHub token secret as a JSON template
// — `{ "token": "...", "placeholder": "..." }`. The previous implementation
// returned the whole JSON string as the auth token, producing
// `Authorization: token {"token":"...",...}` and a 401 from GitHub.
describe('Publisher Lambda - getGitHubToken (#117)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts the `token` field when SecretString is a JSON object', async () => {
    secretsModule.__mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ token: 'ghp_abc123', placeholder: 'noise' }),
    });

    const token = await _internals.getGitHubToken();
    expect(token).toBe('ghp_abc123');
  });

  it('returns the value as-is when SecretString is a plain token string', async () => {
    // Operators who overwrite the secret in the console with a plain
    // string (no JSON wrapper) must keep working.
    secretsModule.__mockSend.mockResolvedValueOnce({
      SecretString: 'ghp_plain_token_value',
    });

    const token = await _internals.getGitHubToken();
    expect(token).toBe('ghp_plain_token_value');
  });

  it('falls back to raw string when JSON parses but has no `token` field', async () => {
    secretsModule.__mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ placeholder: 'noise', other: 'fields' }),
    });

    const token = await _internals.getGitHubToken();
    // The raw JSON gets returned verbatim — better than throwing because
    // an operator may have stored an unusual format. Authentication will
    // fail downstream, which is the right signal.
    expect(token).toBe('{"placeholder":"noise","other":"fields"}');
  });

  it('throws when SecretString is empty', async () => {
    secretsModule.__mockSend.mockResolvedValueOnce({
      SecretString: '',
    });

    await expect(_internals.getGitHubToken()).rejects.toThrow(/missing or empty/);
  });

  it('throws when SecretString is missing/undefined', async () => {
    secretsModule.__mockSend.mockResolvedValueOnce({});

    await expect(_internals.getGitHubToken()).rejects.toThrow(/missing or empty/);
  });
});

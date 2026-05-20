'use strict';

// Tests for issue #81: POST /events/{id}/transcription/start must verify
// the requester owns the event before issuing Transcribe SigV4 credentials.
// Separate file from transcription.test.js to keep the DDB mock isolated;
// the original file has 28 tests that exercise the no-DDB / unit-level
// helpers and don't need the ownership-check path mocked.

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.AWS_SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDHqa0AP';
process.env.TABLE_NAME = 'TestTable';

const { handler } = require('../../lambda/transcription/index');

function buildEvent({ id, claims, body = { sourceLanguage: 'en-US' } }) {
  return {
    httpMethod: 'POST',
    resource: '/events/{id}/transcription/start',
    pathParameters: { id },
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims } },
  };
}

const ownerClaims = { sub: 'owner-123', email: 'owner@example.com' };
const otherClaims = { sub: 'attacker-456', email: 'attacker@example.com' };

describe('Transcription start ownership check (issue #81)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
  });

  test('returns 404 when the event does not exist', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handler(buildEvent({ id: 'evt_missing', claims: ownerClaims }));
    expect(result.statusCode).toBe(404);
  });

  test('returns 403 when the caller is not the event owner', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'EVENT#evt_a', SK: 'METADATA', ownerUserId: 'owner-123' },
    });

    const result = await handler(buildEvent({ id: 'evt_a', claims: otherClaims }));
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).message).toMatch(/owner/);
    // Critically: only ONE DDB call (the ownership GET); no presigned-URL generation reached.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('returns 200 + presigned URL when the caller IS the event owner', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'EVENT#evt_a', SK: 'METADATA', ownerUserId: 'owner-123' },
    });

    const result = await handler(buildEvent({ id: 'evt_a', claims: ownerClaims }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(typeof body.presignedUrl).toBe('string');
    expect(body.presignedUrl).toMatch(/^wss:\/\/transcribestreaming/);
    expect(body.eventId).toBe('evt_a');
  });
});

'use strict';

// Caption language lanes (multi-language captions).
// Covers: setCaptionLanguage row updates + validation, per-lane caption
// fan-out with one Translate call per distinct lane, targeted per-lane
// sends, translate-failure fallback to the original text, and caption
// segment persistence for post-event VTT assembly.

// Mock AWS SDK
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

// Mock API Gateway Management API
const mockApiSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

// Mock IVS Real-Time
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
  DisconnectParticipantCommand: jest.fn((params) => ({ type: 'DisconnectParticipant', params })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
}));

// Mock IVS Chat
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: jest.fn() })),
  DisconnectUserCommand: jest.fn((params) => ({ type: 'DisconnectUser', params })),
}));

// Mock Amazon Translate. The real package ships with the nodejs20 Lambda
// runtime but is not a local devDependency — hence { virtual: true }.
const mockTranslateSend = jest.fn();
jest.mock('@aws-sdk/client-translate', () => ({
  TranslateClient: jest.fn(() => ({ send: mockTranslateSend })),
  TranslateTextCommand: jest.fn((params) => ({ type: 'TranslateText', params })),
}), { virtual: true });

// Mock broadcast (event-wide + targeted lane sends)
const mockBroadcast = jest.fn();
const mockGetConnectionsForEvent = jest.fn();
const mockSendToConnections = jest.fn();
jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: mockBroadcast,
  getConnectionsForEvent: mockGetConnectionsForEvent,
  sendToConnections: mockSendToConnections,
}));

// Mock rate limiter — always allow in tests
jest.mock('../../lambda/websocket/rate-limiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }),
  RATE_LIMIT: 60,
  RATE_WINDOW_SECONDS: 60,
}));

// Always allow through — expiry paths are covered in
// websocket-signaling-tokenexp.test.js.
jest.mock('../../lambda/websocket/auth-check', () => ({
  checkConnectionAuth: jest.fn().mockResolvedValue({ allowed: true, connection: null }),
}));

process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler } = require('../../lambda/websocket/signaling');

function buildEvent(body, connectionId) {
  return {
    requestContext: { connectionId, routeKey: body.action },
    body: JSON.stringify(body),
  };
}

function buildCaptionEvent(data, connectionId = 'conn-presenter') {
  return buildEvent({ action: 'broadcastCaption', eventId: 'evt_1', data }, connectionId);
}

/** Find the sendToConnections call that targeted exactly these connection IDs. */
function laneSend(connectionIds) {
  const call = mockSendToConnections.mock.calls.find(
    ([ids]) => JSON.stringify(ids) === JSON.stringify(connectionIds)
  );
  return call ? call[1] : undefined;
}

/** All docClient sends of a given mocked command type. */
function ddbCalls(type) {
  return mockSend.mock.calls.filter(([cmd]) => cmd.type === type).map(([cmd]) => cmd);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({});
  mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });
  mockSendToConnections.mockResolvedValue({ sent: 1, failed: 0, cleaned: 0 });
  // Deterministic fake translation: "[<target>] <text>"
  mockTranslateSend.mockImplementation(async (cmd) => ({
    TranslatedText: `[${cmd.params.TargetLanguageCode}] ${cmd.params.Text}`,
  }));
});

describe('broadcastCaption language lanes', () => {
  const MIXED_CONNECTIONS = [
    { connectionId: 'conn-presenter', role: 'presenter', eventId: 'evt_1' },
    { connectionId: 'conn-att-none', role: 'attendee', eventId: 'evt_1' },
    { connectionId: 'conn-att-en', role: 'attendee', eventId: 'evt_1', captionLang: 'en' },
    { connectionId: 'conn-att-es1', role: 'attendee', eventId: 'evt_1', captionLang: 'es' },
    { connectionId: 'conn-att-es2', role: 'attendee', eventId: 'evt_1', captionLang: 'es' },
    { connectionId: 'conn-att-fr', role: 'attendee', eventId: 'evt_1', captionLang: 'fr' },
  ];

  it('partitions connections into lanes: captionLang absent or === src joins the original lane', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);

    const result = await handler(buildCaptionEvent({ text: 'Hello everyone', language: 'en', isFinal: true }));
    expect(result.statusCode).toBe(200);

    // Original lane: presenter + no-captionLang attendee + explicit 'en'.
    const original = laneSend(['conn-presenter', 'conn-att-none', 'conn-att-en']);
    expect(original).toEqual(expect.objectContaining({
      type: 'CAPTION',
      eventId: 'evt_1',
      data: expect.objectContaining({
        text: 'Hello everyone',
        language: 'en',
        original: true,
        isFinal: true,
      }),
    }));

    // Nothing goes event-wide when translated lanes exist.
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('makes ONE Translate call per distinct non-source lane and sends each lane its own text', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);

    await handler(buildCaptionEvent({ text: 'Hello everyone', language: 'en' }));

    // Two es-lane connections share one call; fr gets its own — 2 total.
    expect(mockTranslateSend).toHaveBeenCalledTimes(2);
    const translateParams = mockTranslateSend.mock.calls.map(([cmd]) => cmd.params);
    expect(translateParams).toEqual(expect.arrayContaining([
      { Text: 'Hello everyone', SourceLanguageCode: 'en', TargetLanguageCode: 'es' },
      { Text: 'Hello everyone', SourceLanguageCode: 'en', TargetLanguageCode: 'fr' },
    ]));

    // Targeted sends: each lane's group got its own translated text.
    expect(mockSendToConnections).toHaveBeenCalledTimes(3);
    expect(laneSend(['conn-att-es1', 'conn-att-es2']).data).toEqual(expect.objectContaining({
      text: '[es] Hello everyone',
      language: 'es',
      original: false,
    }));
    expect(laneSend(['conn-att-fr']).data).toEqual(expect.objectContaining({
      text: '[fr] Hello everyone',
      language: 'fr',
      original: false,
    }));
  });

  it('falls back to event-wide broadcast when every connection is on the original lane', async () => {
    mockGetConnectionsForEvent.mockResolvedValue([
      { connectionId: 'conn-presenter', role: 'presenter', eventId: 'evt_1' },
      { connectionId: 'conn-att-none', role: 'attendee', eventId: 'evt_1' },
    ]);

    const result = await handler(buildCaptionEvent({ text: 'Solo lane', language: 'en' }));
    expect(result.statusCode).toBe(200);

    expect(mockBroadcast).toHaveBeenCalledWith('evt_1', expect.objectContaining({
      type: 'CAPTION',
      data: expect.objectContaining({ text: 'Solo lane', language: 'en', original: true }),
    }));
    expect(mockSendToConnections).not.toHaveBeenCalled();
    expect(mockTranslateSend).not.toHaveBeenCalled();
  });

  it('sends the ORIGINAL text (original:true, language:lane) to a lane whose translation fails', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);
    mockTranslateSend.mockImplementation(async (cmd) => {
      if (cmd.params.TargetLanguageCode === 'fr') {
        throw new Error('Translate throttled');
      }
      return { TranslatedText: `[${cmd.params.TargetLanguageCode}] ${cmd.params.Text}` };
    });

    const result = await handler(buildCaptionEvent({ text: 'Hello everyone', language: 'en' }));
    expect(result.statusCode).toBe(200);

    // The failed lane is never silenced — it gets the original text.
    expect(laneSend(['conn-att-fr']).data).toEqual(expect.objectContaining({
      text: 'Hello everyone',
      language: 'fr',
      original: true,
    }));
    // The healthy lane is unaffected.
    expect(laneSend(['conn-att-es1', 'conn-att-es2']).data).toEqual(expect.objectContaining({
      text: '[es] Hello everyone',
      original: false,
    }));
  });

  it('persists one caption segment row with PK/SK/translations/ttl after fan-out', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);

    const before = Math.floor(Date.now() / 1000);
    await handler(buildCaptionEvent({ text: 'Hello everyone', language: 'en' }));
    const after = Math.floor(Date.now() / 1000);

    const puts = ddbCalls('Put');
    expect(puts).toHaveLength(1);
    const { TableName, Item } = puts[0].params;
    expect(TableName).toBe('TestTable');
    expect(Item.PK).toBe('EVENT#evt_1');
    expect(Item.SK).toMatch(/^CAPTION#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f]{4}$/);
    expect(Item.entityType).toBe('CAPTION');
    expect(Item.text).toBe('Hello everyone');
    expect(Item.language).toBe('en');
    // Only successful translations are stored.
    expect(Item.translations).toEqual({
      es: '[es] Hello everyone',
      fr: '[fr] Hello everyone',
    });
    expect(Item.timestamp).toBe(Item.SK.split('#')[1]);
    const thirtyDays = 30 * 24 * 60 * 60;
    expect(Item.ttl).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(Item.ttl).toBeLessThanOrEqual(after + thirtyDays);
  });

  it('omits failed lanes from the persisted translations map', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);
    mockTranslateSend.mockImplementation(async (cmd) => {
      if (cmd.params.TargetLanguageCode === 'fr') {
        throw new Error('Translate down');
      }
      return { TranslatedText: `[${cmd.params.TargetLanguageCode}] ${cmd.params.Text}` };
    });

    await handler(buildCaptionEvent({ text: 'Hello everyone', language: 'en' }));

    const puts = ddbCalls('Put');
    expect(puts).toHaveLength(1);
    expect(puts[0].params.Item.translations).toEqual({ es: '[es] Hello everyone' });
  });

  it('still returns 200 when segment persistence fails', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);
    mockSend.mockRejectedValue(new Error('DDB write throttled'));

    const result = await handler(buildCaptionEvent({ text: 'Hello everyone', language: 'en' }));
    expect(result.statusCode).toBe(200);
    // Fan-out already happened.
    expect(mockSendToConnections).toHaveBeenCalledTimes(3);
  });

  it('still rejects captions from non-presenters', async () => {
    mockGetConnectionsForEvent.mockResolvedValue(MIXED_CONNECTIONS);

    const result = await handler(buildCaptionEvent({ text: 'sneaky', language: 'en' }, 'conn-att-none'));
    expect(result.statusCode).toBe(403);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockSendToConnections).not.toHaveBeenCalled();
  });
});

describe('setCaptionLanguage', () => {
  it('updates captionLang on the SENDER connection row', async () => {
    const result = await handler(buildEvent(
      { action: 'setCaptionLanguage', eventId: 'evt_1', data: { language: 'es' } },
      'conn-attendee'
    ));
    expect(result.statusCode).toBe(200);

    const updates = ddbCalls('Update');
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(expect.objectContaining({
      TableName: 'TestConnectionsTable',
      Key: { connectionId: 'conn-attendee' },
      UpdateExpression: 'SET #captionLang = :lang',
      ExpressionAttributeNames: { '#captionLang': 'captionLang' },
      ExpressionAttributeValues: { ':lang': 'es' },
    }));
  });

  it('is allowed from anonymous connections (no presenter/role gate)', async () => {
    const result = await handler(buildEvent(
      { action: 'setCaptionLanguage', eventId: 'evt_1', data: { language: 'ja' } },
      'conn-anon-abc123'
    ));
    expect(result.statusCode).toBe(200);

    // No presenter authz lookup — the action never fetches the sender row.
    expect(ddbCalls('Get')).toHaveLength(0);
    expect(ddbCalls('Update')[0].params.Key).toEqual({ connectionId: 'conn-anon-abc123' });
  });

  it('rejects codes outside the supported set', async () => {
    const result = await handler(buildEvent(
      { action: 'setCaptionLanguage', eventId: 'evt_1', data: { language: 'xx' } },
      'conn-attendee'
    ));
    expect(result.statusCode).toBe(400);
    expect(ddbCalls('Update')).toHaveLength(0);
  });

  it('rejects a missing language', async () => {
    const result = await handler(buildEvent(
      { action: 'setCaptionLanguage', eventId: 'evt_1', data: {} },
      'conn-attendee'
    ));
    expect(result.statusCode).toBe(400);
    expect(ddbCalls('Update')).toHaveLength(0);
  });

  it('accepts every code the frontend offers', async () => {
    for (const code of ['en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'zh']) {
      const result = await handler(buildEvent(
        { action: 'setCaptionLanguage', eventId: 'evt_1', data: { language: code } },
        'conn-attendee'
      ));
      expect(result.statusCode).toBe(200);
    }
  });
});

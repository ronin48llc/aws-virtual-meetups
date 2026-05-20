'use strict';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockSend })),
  AdminDisableUserCommand: jest.fn((params) => ({ type: 'Disable', params })),
  AdminEnableUserCommand: jest.fn((params) => ({ type: 'Enable', params })),
  AdminGetUserCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

process.env.USER_POOL_ID = 'us-east-1_TEST';

const { handler } = require('../../lambda/admin-api/index');

function restEvent({ method, path, body, claims }) {
  return {
    httpMethod: method,
    path,
    body: body ? JSON.stringify(body) : undefined,
    requestContext: claims === undefined ? {} : { authorizer: { claims } },
  };
}

function httpV2Event({ method, path, body, claims }) {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: claims === undefined ? undefined : { jwt: { claims } },
    },
    body: body ? JSON.stringify(body) : undefined,
  };
}

const ORG = { sub: 'u-org', 'custom:role': 'organizer' };
const MEMBER = { sub: 'u-mem', 'custom:role': 'member' };

describe('admin-api authz gate (#93)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ Username: 'victim', Enabled: false, UserStatus: 'CONFIRMED' });
  });

  describe('rejects unauthenticated callers', () => {
    test('disable with no claims → 401', async () => {
      const res = await handler(restEvent({ method: 'POST', path: '/admin/disable', body: { username: 'victim' } }));
      expect(res.statusCode).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('enable with no claims → 401', async () => {
      const res = await handler(restEvent({ method: 'POST', path: '/admin/enable', body: { username: 'victim' } }));
      expect(res.statusCode).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('status with no claims → 401', async () => {
      const res = await handler(restEvent({ method: 'GET', path: '/admin/users/victim/status' }));
      expect(res.statusCode).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('rejects non-organizer roles', () => {
    test('member calling disable → 403', async () => {
      const res = await handler(restEvent({
        method: 'POST', path: '/admin/disable', body: { username: 'victim' }, claims: MEMBER,
      }));
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('claims with no role field → 403', async () => {
      const res = await handler(restEvent({
        method: 'POST', path: '/admin/enable', body: { username: 'victim' }, claims: { sub: 'u-roleless' },
      }));
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('claims with empty role string → 403', async () => {
      const res = await handler(restEvent({
        method: 'GET', path: '/admin/users/victim/status', claims: { sub: 'u-empty', 'custom:role': '' },
      }));
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('attacker spoofing role=organizerXX (case/substring) → 403', async () => {
      const res = await handler(restEvent({
        method: 'POST', path: '/admin/disable', body: { username: 'victim' },
        claims: { sub: 'u-spoof', 'custom:role': 'organizerXX' },
      }));
      expect(res.statusCode).toBe(403);
    });
  });

  describe('allows organizer through (REST event shape)', () => {
    test('organizer disables a user → 200', async () => {
      const res = await handler(restEvent({
        method: 'POST', path: '/admin/disable', body: { username: 'victim' }, claims: ORG,
      }));
      expect(res.statusCode).toBe(200);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toMatchObject({
        type: 'Disable',
        params: { UserPoolId: 'us-east-1_TEST', Username: 'victim' },
      });
    });

    test('organizer enables a user → 200', async () => {
      const res = await handler(restEvent({
        method: 'POST', path: '/admin/enable', body: { username: 'victim' }, claims: ORG,
      }));
      expect(res.statusCode).toBe(200);
      expect(mockSend.mock.calls[0][0].type).toBe('Enable');
    });

    test('organizer reads status → 200', async () => {
      const res = await handler(restEvent({
        method: 'GET', path: '/admin/users/victim/status', claims: ORG,
      }));
      expect(res.statusCode).toBe(200);
      expect(mockSend.mock.calls[0][0].type).toBe('Get');
    });
  });

  describe('allows organizer through (HTTP API v2 event shape)', () => {
    test('organizer disable via jwt.claims path → 200', async () => {
      const res = await handler(httpV2Event({
        method: 'POST', path: '/admin/disable', body: { username: 'victim' }, claims: ORG,
      }));
      expect(res.statusCode).toBe(200);
      expect(mockSend).toHaveBeenCalled();
    });

    test('v2 with member jwt.claims → 403', async () => {
      const res = await handler(httpV2Event({
        method: 'POST', path: '/admin/disable', body: { username: 'victim' }, claims: MEMBER,
      }));
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('regression — authz runs before payload validation', () => {
    test('non-organizer with no username in body → still 403 (not 400)', async () => {
      const res = await handler(restEvent({
        method: 'POST', path: '/admin/disable', body: {}, claims: MEMBER,
      }));
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

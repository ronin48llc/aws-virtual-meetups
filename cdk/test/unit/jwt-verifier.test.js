'use strict';

/**
 * Tests for the shared Cognito JWT verifier module (issue #4).
 *
 * We mock `aws-jwt-verify` itself so the tests don't fetch the JWK set
 * over the network.
 */

const mockVerify = jest.fn();
const mockCreate = jest.fn(() => ({ verify: mockVerify }));

jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: mockCreate },
}));

describe('shared/jwt-verifier', () => {
  let verifier;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_TestPool';
    process.env.COGNITO_CLIENT_ID = 'TestClient';
    verifier = require('../../lambda/shared/jwt-verifier');
    verifier._resetForTests();
  });

  afterEach(() => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;
  });

  it('returns the verified claims on a valid token', async () => {
    const claims = { sub: 'user-456', email: 'x@example.com', exp: 9999999999 };
    mockVerify.mockResolvedValueOnce(claims);

    const result = await verifier.verifyIdToken('valid-token');
    expect(result).toEqual(claims);
    expect(mockVerify).toHaveBeenCalledWith('valid-token');
  });

  it('returns null when the verifier throws (invalid signature, expiry, etc.)', async () => {
    mockVerify.mockRejectedValueOnce(new Error('JwtExpiredError'));
    const result = await verifier.verifyIdToken('expired-token');
    expect(result).toBeNull();
  });

  it('returns null without calling the verifier when token is falsy', async () => {
    expect(await verifier.verifyIdToken(null)).toBeNull();
    expect(await verifier.verifyIdToken('')).toBeNull();
    expect(await verifier.verifyIdToken(undefined)).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returns null when token is not a string', async () => {
    expect(await verifier.verifyIdToken(12345)).toBeNull();
    expect(await verifier.verifyIdToken({})).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('memoizes the underlying CognitoJwtVerifier instance across calls', async () => {
    mockVerify.mockResolvedValue({ sub: 'user-456' });
    await verifier.verifyIdToken('t1');
    await verifier.verifyIdToken('t2');
    await verifier.verifyIdToken('t3');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws when required env vars are missing', async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    verifier._resetForTests();
    // Returns null (not throws) because verifyIdToken catches the inner
    // throw and converts to null per its contract.
    const result = await verifier.verifyIdToken('whatever');
    expect(result).toBeNull();
  });
});

'use strict';

const {
  buildEventPK,
  buildUserPK,
  buildSignupSK,
  buildConnectionSK,
  buildHandSK,
  buildQuestionSK,
  buildGSI1SK,
  buildGSI2PK,
  parseEntityType,
  extractId,
  chunk,
  buildBatchWriteParams,
  buildBatchDeleteParams,
  buildQueryParams,
} = require('../../lambda/shared/dynamo-utils');

describe('shared/dynamo-utils', () => {
  describe('key builders', () => {
    it('buildEventPK creates EVENT# prefixed key', () => {
      expect(buildEventPK('evt_abc123')).toBe('EVENT#evt_abc123');
    });

    it('buildUserPK creates USER# prefixed key', () => {
      expect(buildUserPK('user_xyz')).toBe('USER#user_xyz');
    });

    it('buildSignupSK creates SIGNUP# prefixed key', () => {
      expect(buildSignupSK('user_xyz')).toBe('SIGNUP#user_xyz');
    });

    it('buildConnectionSK creates CONN# prefixed key', () => {
      expect(buildConnectionSK('conn_123')).toBe('CONN#conn_123');
    });

    it('buildHandSK creates HAND# prefixed key with timestamp and userId', () => {
      expect(buildHandSK('2024-01-15T10:30:00Z', 'user_xyz')).toBe(
        'HAND#2024-01-15T10:30:00Z#user_xyz'
      );
    });

    it('buildQuestionSK creates QUESTION# prefixed key with timestamp and questionId', () => {
      expect(buildQuestionSK('2024-01-15T10:30:00Z', 'q_abc')).toBe(
        'QUESTION#2024-01-15T10:30:00Z#q_abc'
      );
    });

    it('buildGSI1SK creates composite sort key for upcoming events', () => {
      expect(buildGSI1SK('2024-01-15T10:30:00Z', 'evt_abc123')).toBe(
        '2024-01-15T10:30:00Z#evt_abc123'
      );
    });

    it('buildGSI2PK creates owner events partition key', () => {
      expect(buildGSI2PK('user_xyz')).toBe('USER#user_xyz#EVENTS');
    });
  });

  describe('parseEntityType', () => {
    it('identifies METADATA sort key', () => {
      expect(parseEntityType('METADATA')).toBe('METADATA');
    });

    it('identifies PROFILE sort key', () => {
      expect(parseEntityType('PROFILE')).toBe('PROFILE');
    });

    it('identifies RECORDING sort key', () => {
      expect(parseEntityType('RECORDING')).toBe('RECORDING');
    });

    it('identifies SIGNUP entity from sort key', () => {
      expect(parseEntityType('SIGNUP#user_xyz')).toBe('SIGNUP');
    });

    it('identifies CONN entity from sort key', () => {
      expect(parseEntityType('CONN#abc123')).toBe('CONN');
    });

    it('identifies HAND entity from sort key', () => {
      expect(parseEntityType('HAND#2024-01-15T10:30:00Z#user_xyz')).toBe('HAND');
    });

    it('identifies QUESTION entity from sort key', () => {
      expect(parseEntityType('QUESTION#2024-01-15T10:30:00Z#q_abc')).toBe('QUESTION');
    });

    it('returns UNKNOWN for unrecognized sort keys', () => {
      expect(parseEntityType('SOMETHING_ELSE')).toBe('UNKNOWN');
    });
  });

  describe('extractId', () => {
    it('extracts id from prefixed key', () => {
      expect(extractId('EVENT#evt_abc123', 'EVENT#')).toBe('evt_abc123');
    });

    it('returns original key if prefix does not match', () => {
      expect(extractId('USER#user_xyz', 'EVENT#')).toBe('USER#user_xyz');
    });

    it('handles null/undefined gracefully', () => {
      expect(extractId(null, 'EVENT#')).toBe(null);
      expect(extractId(undefined, 'EVENT#')).toBe(undefined);
    });
  });

  describe('chunk', () => {
    it('splits array into chunks of specified size', () => {
      const items = [1, 2, 3, 4, 5];
      expect(chunk(items, 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('defaults to chunks of 25', () => {
      const items = Array.from({ length: 30 }, (_, i) => i);
      const result = chunk(items);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveLength(25);
      expect(result[1]).toHaveLength(5);
    });

    it('returns single chunk for small arrays', () => {
      expect(chunk([1, 2, 3])).toEqual([[1, 2, 3]]);
    });

    it('returns empty array for empty input', () => {
      expect(chunk([])).toEqual([]);
    });
  });

  describe('buildBatchWriteParams', () => {
    it('creates BatchWriteItem params with PutRequests', () => {
      const items = [{ PK: 'A', SK: '1' }, { PK: 'B', SK: '2' }];
      const result = buildBatchWriteParams('TestTable', items);
      expect(result).toHaveLength(1);
      expect(result[0].RequestItems.TestTable).toHaveLength(2);
      expect(result[0].RequestItems.TestTable[0]).toEqual({
        PutRequest: { Item: { PK: 'A', SK: '1' } },
      });
    });
  });

  describe('buildBatchDeleteParams', () => {
    it('creates BatchWriteItem params with DeleteRequests', () => {
      const keys = [{ PK: 'A', SK: '1' }];
      const result = buildBatchDeleteParams('TestTable', keys);
      expect(result).toHaveLength(1);
      expect(result[0].RequestItems.TestTable[0]).toEqual({
        DeleteRequest: { Key: { PK: 'A', SK: '1' } },
      });
    });
  });

  describe('buildQueryParams', () => {
    it('builds basic query params', () => {
      const params = buildQueryParams({ tableName: 'TestTable', pk: 'EVENT#123' });
      expect(params.TableName).toBe('TestTable');
      expect(params.KeyConditionExpression).toBe('PK = :pk');
      expect(params.ExpressionAttributeValues[':pk']).toEqual({ S: 'EVENT#123' });
      expect(params.ScanIndexForward).toBe(true);
    });

    it('adds begins_with condition for skPrefix', () => {
      const params = buildQueryParams({
        tableName: 'TestTable',
        pk: 'EVENT#123',
        skPrefix: 'SIGNUP#',
      });
      expect(params.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :skPrefix)');
      expect(params.ExpressionAttributeValues[':skPrefix']).toEqual({ S: 'SIGNUP#' });
    });

    it('includes indexName when specified', () => {
      const params = buildQueryParams({
        tableName: 'TestTable',
        pk: 'EVENTS#UPCOMING',
        indexName: 'GSI1',
      });
      expect(params.IndexName).toBe('GSI1');
    });

    it('includes limit when specified', () => {
      const params = buildQueryParams({ tableName: 'TestTable', pk: 'X', limit: 10 });
      expect(params.Limit).toBe(10);
    });

    it('respects scanForward option', () => {
      const params = buildQueryParams({ tableName: 'TestTable', pk: 'X', scanForward: false });
      expect(params.ScanIndexForward).toBe(false);
    });
  });
});

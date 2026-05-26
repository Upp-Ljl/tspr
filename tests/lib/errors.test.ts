/**
 * tests/lib/errors.test.ts
 * Tests for src/lib/errors.ts
 */

import { describe, it, expect } from 'vitest';
import {
  LocalSpriteError,
  SandboxError,
  CcError,
  ReportError,
  ErrCode,
  toMcpError,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
} from '../../src/lib/errors.js';

describe('LocalSpriteError', () => {
  it('stores code, message, cause, and data', () => {
    const cause = new Error('root cause');
    const err = new LocalSpriteError('ERR_TEST', 'test message', {
      cause,
      data: { key: 'value' },
    });

    expect(err.code).toBe('ERR_TEST');
    expect(err.message).toBe('test message');
    expect(err.cause).toBe(cause);
    expect(err.data).toEqual({ key: 'value' });
  });

  it('is an instance of Error', () => {
    const err = new LocalSpriteError('ERR_TEST', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LocalSpriteError);
  });

  it('name is LocalSpriteError', () => {
    const err = new LocalSpriteError('ERR_TEST', 'msg');
    expect(err.name).toBe('LocalSpriteError');
  });

  it('optional fields default to undefined', () => {
    const err = new LocalSpriteError('ERR_X', 'x');
    expect(err.cause).toBeUndefined();
    expect(err.data).toBeUndefined();
  });
});

describe('SandboxError', () => {
  it('is an instance of LocalSpriteError', () => {
    const err = new SandboxError('ERR_DOCKER_UNAVAILABLE', 'docker not running');
    expect(err).toBeInstanceOf(LocalSpriteError);
    expect(err).toBeInstanceOf(SandboxError);
  });

  it('name is SandboxError', () => {
    const err = new SandboxError('ERR_DOCKER_UNAVAILABLE', 'docker not running');
    expect(err.name).toBe('SandboxError');
  });
});

describe('CcError', () => {
  it('is an instance of LocalSpriteError', () => {
    const err = new CcError('ERR_CC_FAILED', 'claude failed');
    expect(err).toBeInstanceOf(LocalSpriteError);
    expect(err).toBeInstanceOf(CcError);
  });

  it('name is CcError', () => {
    const err = new CcError('ERR_CC_FAILED', 'claude failed');
    expect(err.name).toBe('CcError');
  });
});

describe('ReportError', () => {
  it('is an instance of LocalSpriteError', () => {
    const err = new ReportError('REPORT_SERIALIZATION_FAILED', 'circular ref');
    expect(err).toBeInstanceOf(LocalSpriteError);
    expect(err).toBeInstanceOf(ReportError);
  });
});

describe('ErrCode', () => {
  it('contains ERR_INVALID_PORT', () => {
    expect(ErrCode.ERR_INVALID_PORT).toBe('ERR_INVALID_PORT');
  });

  it('contains ERR_CC_FAILED', () => {
    expect(ErrCode.ERR_CC_FAILED).toBe('ERR_CC_FAILED');
  });

  it('contains ERR_DOCKER_UNAVAILABLE', () => {
    expect(ErrCode.ERR_DOCKER_UNAVAILABLE).toBe('ERR_DOCKER_UNAVAILABLE');
  });

  it('is frozen (immutable)', () => {
    expect(() => {
      (ErrCode as Record<string, string>)['NEW_KEY'] = 'x';
    }).toThrow();
  });
});

describe('toMcpError', () => {
  it('ERR_INVALID_PORT maps to -32602', () => {
    const err = new LocalSpriteError(ErrCode.ERR_INVALID_PORT, 'bad port');
    const mcp = toMcpError(err);
    expect(mcp.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(mcp.message).toBe(ErrCode.ERR_INVALID_PORT);
  });

  it('ERR_INVALID_PARAMS maps to -32602', () => {
    const err = new LocalSpriteError(ErrCode.ERR_INVALID_PARAMS, 'missing param');
    const mcp = toMcpError(err);
    expect(mcp.code).toBe(JSONRPC_INVALID_PARAMS);
  });

  it('ERR_CC_FAILED maps to -32603', () => {
    const err = new CcError(ErrCode.ERR_CC_FAILED, 'claude died');
    const mcp = toMcpError(err);
    expect(mcp.code).toBe(JSONRPC_INTERNAL_ERROR);
  });

  it('ERR_DOCKER_UNAVAILABLE maps to -32603', () => {
    const err = new SandboxError(ErrCode.ERR_DOCKER_UNAVAILABLE, 'no docker');
    const mcp = toMcpError(err);
    expect(mcp.code).toBe(JSONRPC_INTERNAL_ERROR);
  });

  it('data.code equals the error code', () => {
    const err = new LocalSpriteError(ErrCode.ERR_PROJECT_NOT_FOUND, 'not found');
    const mcp = toMcpError(err);
    expect((mcp.data as Record<string, unknown>)?.['code']).toBe(ErrCode.ERR_PROJECT_NOT_FOUND);
  });

  it('plain Error maps to -32603', () => {
    const err = new Error('unexpected');
    const mcp = toMcpError(err);
    expect(mcp.code).toBe(JSONRPC_INTERNAL_ERROR);
  });

  it('string maps to -32603', () => {
    const mcp = toMcpError('something went wrong');
    expect(mcp.code).toBe(JSONRPC_INTERNAL_ERROR);
  });

  it('null maps to -32603', () => {
    const mcp = toMcpError(null);
    expect(mcp.code).toBe(JSONRPC_INTERNAL_ERROR);
  });
});

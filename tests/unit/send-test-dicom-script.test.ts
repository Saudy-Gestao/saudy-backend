import { describe, expect, it, vi } from 'vitest';
import { runSendTestDicom } from '../../src/scripts/send-test-dicom';

describe('send-test-dicom script', () => {
  it('exits when no args are provided', async () => {
    const exit = vi.fn();
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runSendTestDicom({
      argv: ['node', 'script'],
      exit,
      logger,
    });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits when file does not exist', async () => {
    const exit = vi.fn();
    const logger = { log: vi.fn(), error: vi.fn() } as any;
    const fsMod = {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    } as any;

    await runSendTestDicom({
      argv: ['node', 'script', './missing.dcm'],
      fsMod,
      pathMod: { resolve: (p: string) => `/abs/${p}` } as any,
      exit,
      logger,
    });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uploads files and parses json response', async () => {
    const logger = { log: vi.fn(), error: vi.fn() } as any;
    const fsMod = {
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(Buffer.from('abc')),
    } as any;
    const fetchFn = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue('{"ok":true}'),
    });

    await runSendTestDicom({
      argv: ['node', 'script', './file1.dcm', 'a.b.c'],
      fsMod,
      pathMod: { resolve: (p: string) => `/abs/${p}` } as any,
      fetchFn: fetchFn as any,
      env: { API_URL: 'http://localhost:3000/dicom/' } as any,
      logger,
      exit: vi.fn(),
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('response', { ok: true });
  });

  it('logs raw text when response is not valid json', async () => {
    const logger = { log: vi.fn(), error: vi.fn() } as any;
    const fsMod = {
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(Buffer.from('abc')),
    } as any;
    const fetchFn = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue('not-json-at-all'),
    });

    await runSendTestDicom({
      argv: ['node', 'script', './file1.dcm'],
      fsMod,
      pathMod: { resolve: (p: string) => `/abs/${p}` } as any,
      fetchFn: fetchFn as any,
      env: {} as any,
      logger,
      exit: vi.fn(),
    });

    expect(logger.log).toHaveBeenCalledWith('response', 'not-json-at-all');
  });
});


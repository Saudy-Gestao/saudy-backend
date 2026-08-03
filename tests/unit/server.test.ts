import { beforeEach, describe, expect, it, vi } from 'vitest';

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('server bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.PORT;
  });

  it('starts app, schedules automations and runs first cycle', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const listen = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue(undefined);

    const syncAllBranchesHsmTemplates = vi.fn().mockResolvedValue({
      branches: 1,
      synced: 2,
      created: 3,
      updated: 4,
    });

    const processNoShows = vi.fn().mockResolvedValue({ sent: 1 });
    const processConfirmations = vi.fn().mockResolvedValue({ sent: 2 });
    const processHumanConversationTimeouts = vi.fn().mockResolvedValue({ closed: 1 });
    const startTemporaryDicomStudyCleanup = vi.fn();

    const setIntervalMock = vi.fn().mockReturnValue(123);

    const onHandlers: Record<string, Function> = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      onHandlers[event] = handler;
      return process;
    }) as any);

    vi.spyOn(global, 'setInterval').mockImplementation(setIntervalMock as any);
    vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined as any);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('../../src/app', () => ({
      default: {
        log: { info, error },
        listen,
      },
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      default: {
        $connect: connect,
        $disconnect: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({
      syncAllBranchesHsmTemplates,
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({
      default: {
        processNoShows,
        processConfirmations,
        processHumanConversationTimeouts,
      },
    }));

    vi.doMock('../../src/modules/dicom/temporary-prior-studies', () => ({
      startTemporaryDicomStudyCleanup,
    }));

    await import('../../src/server');
    await flushPromises();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' });

    expect(syncAllBranchesHsmTemplates).toHaveBeenCalledTimes(1);
    expect(processNoShows).toHaveBeenCalledTimes(1);
    expect(processConfirmations).toHaveBeenCalledTimes(1);
    expect(processHumanConversationTimeouts).toHaveBeenCalledTimes(1);
    expect(startTemporaryDicomStudyCleanup).toHaveBeenCalledTimes(1);

    expect(setIntervalMock).toHaveBeenCalledTimes(3);
    expect(onHandlers.SIGINT).toBeTypeOf('function');
    expect(onHandlers.SIGTERM).toBeTypeOf('function');

    expect(error).not.toHaveBeenCalled();
  });

  it('logs error and exits when startup fails', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const connect = vi.fn().mockRejectedValue(new Error('db down'));

    vi.spyOn(process, 'on').mockImplementation((((_event: string, _handler: Function) => process) as any));
    vi.spyOn(global, 'setInterval').mockImplementation(((() => 1) as any));
    vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined as any);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('../../src/app', () => ({
      default: {
        log: { info, error },
        listen: vi.fn(),
      },
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      default: {
        $connect: connect,
        $disconnect: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({
      syncAllBranchesHsmTemplates: vi.fn(),
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({
      default: {
        processNoShows: vi.fn(),
        processConfirmations: vi.fn(),
        processHumanConversationTimeouts: vi.fn(),
      },
    }));

    await import('../../src/server');
    await flushPromises();

    expect(error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('disconnects prisma and exits on shutdown signal', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);

    const onHandlers: Record<string, Function> = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      onHandlers[event] = handler;
      return process;
    }) as any);

    vi.spyOn(global, 'setInterval').mockImplementation(((() => 77) as any));
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('../../src/app', () => ({
      default: {
        log: { info: vi.fn(), error: vi.fn() },
        listen: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      default: {
        $connect: vi.fn().mockResolvedValue(undefined),
        $disconnect: disconnect,
      },
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({
      syncAllBranchesHsmTemplates: vi.fn().mockResolvedValue({
        branches: 0,
        synced: 0,
        created: 0,
        updated: 0,
      }),
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({
      default: {
        processNoShows: vi.fn().mockResolvedValue({}),
        processConfirmations: vi.fn().mockResolvedValue({}),
        processHumanConversationTimeouts: vi.fn().mockResolvedValue({}),
      },
    }));

    await import('../../src/server');
    await flushPromises();

    await onHandlers.SIGINT();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('handles automation cycle errors and executes interval callbacks', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);

    const syncAllBranchesHsmTemplates = vi
      .fn()
      .mockResolvedValueOnce({ branches: 0, synced: 0, created: 0, updated: 0 })
      .mockRejectedValueOnce(new Error('sync-fail'));

    const processNoShows = vi
      .fn()
      .mockResolvedValueOnce({ sent: 1 })
      .mockRejectedValueOnce(new Error('automation-fail'));
    const processConfirmations = vi.fn().mockResolvedValue({ sent: 2 });

    const processHumanConversationTimeouts = vi
      .fn()
      .mockResolvedValueOnce({ closed: 1 })
      .mockRejectedValueOnce(new Error('human-timeout-fail'));

    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(global, 'setInterval').mockImplementation(((cb: () => void) => {
      intervalCallbacks.push(cb);
      return 1 as any;
    }) as any);
    vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined as any);
    vi.spyOn(process, 'on').mockImplementation((((_event: string, _handler: Function) => process) as any));
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('../../src/app', () => ({
      default: {
        log: { info, error },
        listen: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      default: {
        $connect: connect,
        $disconnect: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({
      syncAllBranchesHsmTemplates,
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({
      default: {
        processNoShows,
        processConfirmations,
        processHumanConversationTimeouts,
      },
    }));

    await import('../../src/server');
    await flushPromises();

    for (const callback of intervalCallbacks) {
      callback();
    }
    await flushPromises();

    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'WhatsApp HSM auto-sync failed');
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'WhatsApp automation cycle failed');
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'WhatsApp human timeout cycle failed');
  });

  it('skips interval run while previous cycle is still running', async () => {
    const onHandlers: Record<string, Function> = {};
    const hsmDeferred = deferred<{ branches: number; synced: number; created: number; updated: number }>();
    const noShowDeferred = deferred<{ sent: number }>();
    const humanTimeoutDeferred = deferred<{ closed: number }>();

    const syncAllBranchesHsmTemplates = vi.fn().mockReturnValue(hsmDeferred.promise);
    const processNoShows = vi.fn().mockReturnValue(noShowDeferred.promise);
    const processConfirmations = vi.fn().mockResolvedValue({ sent: 2 });
    const processHumanConversationTimeouts = vi.fn().mockReturnValue(humanTimeoutDeferred.promise);

    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(global, 'setInterval').mockImplementation(((cb: () => void) => {
      intervalCallbacks.push(cb);
      return 1 as any;
    }) as any);

    vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined as any);
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      onHandlers[event] = handler;
      return process;
    }) as any);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('../../src/app', () => ({
      default: {
        log: { info: vi.fn(), error: vi.fn() },
        listen: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      default: {
        $connect: vi.fn().mockResolvedValue(undefined),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({
      syncAllBranchesHsmTemplates,
    }));

    vi.doMock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({
      default: {
        processNoShows,
        processConfirmations,
        processHumanConversationTimeouts,
      },
    }));

    await import('../../src/server');
    await flushPromises();

    for (const callback of intervalCallbacks) {
      callback();
    }

    expect(syncAllBranchesHsmTemplates).toHaveBeenCalledTimes(1);
    expect(processNoShows).toHaveBeenCalledTimes(1);
    expect(processHumanConversationTimeouts).toHaveBeenCalledTimes(1);

    hsmDeferred.resolve({ branches: 1, synced: 1, created: 0, updated: 0 });
    noShowDeferred.resolve({ sent: 1 });
    humanTimeoutDeferred.resolve({ closed: 1 });
    await flushPromises();

    expect(processConfirmations).toHaveBeenCalledTimes(1);
    expect(onHandlers.SIGINT).toBeTypeOf('function');
  });
});

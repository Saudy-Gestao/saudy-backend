import { beforeEach, describe, expect, it, vi } from 'vitest';

type FastifyAppMock = {
  register: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
};

async function loadAppWithEnv(env: {
  JWT_SECRET?: string;
  CORS_ORIGIN?: string;
  PORT?: string;
}) {
  if (env.JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = env.JWT_SECRET;
  }

  if (env.CORS_ORIGIN === undefined) {
    delete process.env.CORS_ORIGIN;
  } else {
    process.env.CORS_ORIGIN = env.CORS_ORIGIN;
  }

  if (env.PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = env.PORT;
  }

  const appMock: FastifyAppMock = {
    register: vi.fn(),
    get: vi.fn(),
  };

  const corsPlugin = vi.fn();
  const jwtPlugin = vi.fn();
  const swaggerPlugin = vi.fn();
  const swaggerUiPlugin = vi.fn();
  const startSpy = vi.fn();

  vi.doMock('dotenv/config', () => ({}));
  vi.doMock('fastify', () => ({
    default: vi.fn(() => appMock),
  }));
  vi.doMock('@fastify/cors', () => ({ default: corsPlugin }));
  vi.doMock('@fastify/jwt', () => ({ default: jwtPlugin }));
  vi.doMock('@fastify/swagger', () => ({ default: swaggerPlugin }));
  vi.doMock('@fastify/swagger-ui', () => ({ default: swaggerUiPlugin }));

  vi.doMock('../../src/modules/auth', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/accounts', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/admin', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/care', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/care/routes/whatsapp-webhook', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/procedures', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/dicom', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/dicom-web-proxy', () => ({ default: vi.fn() }));
  vi.doMock('../../src/modules/dicom/orthanc', () => ({
    startOrthancPoller: vi.fn(),
  }));
  vi.doMock('../../src/modules/dicom/mwl', () => ({
    MwlScp: class {
      start = startSpy;
    },
  }));

  const mod = await import('../../src/app');

  return {
    mod,
    appMock,
    corsPlugin,
    jwtPlugin,
    swaggerPlugin,
    swaggerUiPlugin,
    startSpy,
  };
}

describe('app bootstrap config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('throws when JWT_SECRET is missing', async () => {
    process.env.JWT_SECRET = '';

    vi.doMock('dotenv/config', () => ({}));

    vi.doMock('fastify', () => ({
      default: vi.fn(() => ({
        register: vi.fn(),
        get: vi.fn(),
      })),
    }));

    await expect(import('../../src/app')).rejects.toThrow(
      'JWT_SECRET is not set in environment variables',
    );
  });

  it('registers plugins with explicit origin list and default port', async () => {
    const { mod, appMock, corsPlugin, jwtPlugin, swaggerPlugin, swaggerUiPlugin, startSpy } =
      await loadAppWithEnv({ JWT_SECRET: 'secret', CORS_ORIGIN: 'http://localhost:5173' });

    expect(mod.default).toBeDefined();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(appMock.get).toHaveBeenCalledWith('/health', expect.any(Function));
    expect(appMock.get).toHaveBeenCalledWith('/', expect.any(Function));

    expect(appMock.register).toHaveBeenCalledWith(
      corsPlugin,
      expect.objectContaining({ origin: ['http://localhost:5173'] }),
    );
    expect(appMock.register).toHaveBeenCalledWith(
      jwtPlugin,
      expect.objectContaining({ secret: 'secret' }),
    );
    expect(appMock.register).toHaveBeenCalledWith(
      swaggerPlugin,
      expect.objectContaining({
        openapi: expect.objectContaining({
          servers: [{ url: 'http://localhost:3000' }],
        }),
      }),
    );
    expect(appMock.register).toHaveBeenCalledWith(swaggerUiPlugin, expect.any(Object));
  });

  it('registers multiple CORS origins from comma-separated list and custom port', async () => {
    const { appMock, corsPlugin, swaggerPlugin } = await loadAppWithEnv({
      JWT_SECRET: 'secret',
      CORS_ORIGIN: 'https://saudy.example,https://app.saudy.example',
      PORT: '9876',
    });

    expect(appMock.register).toHaveBeenCalledWith(
      corsPlugin,
      expect.objectContaining({ origin: ['https://saudy.example', 'https://app.saudy.example'] }),
    );
    expect(appMock.register).toHaveBeenCalledWith(
      swaggerPlugin,
      expect.objectContaining({
        openapi: expect.objectContaining({
          servers: [{ url: 'http://localhost:9876' }],
        }),
      }),
    );
  });

  it('disables CORS when CORS_ORIGIN is unset', async () => {
    const { appMock, corsPlugin } = await loadAppWithEnv({ JWT_SECRET: 'secret' });

    expect(appMock.register).toHaveBeenCalledWith(
      corsPlugin,
      expect.objectContaining({ origin: false }),
    );
  });
});

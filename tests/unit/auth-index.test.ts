import { describe, expect, it, vi } from 'vitest';

const registerSchemas = vi.fn();
const companyRoutes = vi.fn();
const branchRoutes = vi.fn();
const branchSettingsRoutes = vi.fn();
const sectorRoutes = vi.fn();
const accessRoutes = vi.fn();
const moduleRoutes = vi.fn();
const userRoutes = vi.fn();
const authRoutes = vi.fn();
const patientPortalRoutes = vi.fn();

vi.mock('../../src/modules/auth/lib/openapi', () => ({
  registerSchemas,
}));
vi.mock('../../src/modules/auth/routes/companies', () => ({ default: companyRoutes }));
vi.mock('../../src/modules/auth/routes/branches', () => ({ default: branchRoutes }));
vi.mock('../../src/modules/auth/routes/branch-settings', () => ({ default: branchSettingsRoutes }));
vi.mock('../../src/modules/auth/routes/sectors', () => ({ default: sectorRoutes }));
vi.mock('../../src/modules/auth/routes/accesses', () => ({ default: accessRoutes }));
vi.mock('../../src/modules/auth/routes/modules', () => ({ default: moduleRoutes }));
vi.mock('../../src/modules/auth/routes/users', () => ({ default: userRoutes }));
vi.mock('../../src/modules/auth/routes/auth', () => ({ default: authRoutes }));
vi.mock('../../src/modules/auth/routes/patient-portal', () => ({ default: patientPortalRoutes }));

describe('auth module index', () => {
  it('registers schemas and all route plugins', async () => {
    const registered: any[] = [];
    const app = {
      register: vi.fn((plugin: any) => {
        registered.push(plugin);
      }),
    } as any;

    const { default: authModule } = await import('../../src/modules/auth');
    await authModule(app);

    expect(registerSchemas).toHaveBeenCalledWith(app);
    expect(app.register).toHaveBeenCalledTimes(9);
    expect(registered).toEqual([
      companyRoutes,
      branchRoutes,
      branchSettingsRoutes,
      sectorRoutes,
      accessRoutes,
      userRoutes,
      authRoutes,
      patientPortalRoutes,
      moduleRoutes,
    ]);
  });
});

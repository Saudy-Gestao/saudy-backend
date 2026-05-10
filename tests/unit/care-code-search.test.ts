import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCodebase, reindexCodebaseFromGitHub } from '../../src/modules/care/lib/code-search';

vi.mock('../../src/lib/prisma', () => ({
  default: {
    $executeRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    codeChunk: { create: vi.fn() },
  },
}));

import prismaModule from '../../src/lib/prisma';
const prisma = prismaModule as any;

describe('code-search lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_REPOS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_BRANCH;
  });

  // ── searchCodebase ────────────────────────────────────────────────────────

  it('returns empty string when question has no usable keywords', async () => {
    const result = await searchCodebase('o a e de um');
    expect(result).toBe('');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns empty string when database returns no rows', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const result = await searchCodebase('como criar agendamento clinica');
    expect(result).toBe('');
  });

  it('formats found rows into context string', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([
      { repo: 'org/repo', file_path: 'src/app.ts', chunk_index: 0, content: 'const x = 1;' },
      { repo: 'org/repo', file_path: 'src/app.ts', chunk_index: 1, content: 'const y = 2;' },
    ]);

    const result = await searchCodebase('como criar agendamento clinica');
    expect(result).toContain('org/repo/src/app.ts#chunk-0');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('---');
  });

  it('truncates content longer than 1800 chars', async () => {
    const longContent = 'a'.repeat(2000);
    prisma.$queryRawUnsafe.mockResolvedValue([
      { repo: 'org/repo', file_path: 'big.ts', chunk_index: 0, content: longContent },
    ]);

    const result = await searchCodebase('agendamento paciente consulta medico');
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longContent.length + 100);
  });

  // ── reindexCodebaseFromGitHub ─────────────────────────────────────────────

  it('throws when no repo is configured', async () => {
    await expect(reindexCodebaseFromGitHub()).rejects.toThrow('GITHUB_REPO ou GITHUB_REPOS não configurado');
  });

  it('indexes files from a single repo', async () => {
    process.env.GITHUB_REPO = 'org/repo';

    vi.stubGlobal('fetch', vi.fn()
      // resolveGitHubBranch: branch exists
      .mockResolvedValueOnce({ ok: true })
      // fetchGitHubRepoTree: branch info
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: 'abc123' } }) })
      // git tree
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        tree: [
          { path: 'src/app.ts', type: 'blob', sha: 's1' },
          { path: 'node_modules/lib.ts', type: 'blob', sha: 's2' },
        ],
        truncated: false,
      }) })
      // file content for src/app.ts
      .mockResolvedValueOnce({ ok: true, text: async () => 'const hello = "world";' }),
    );

    prisma.$executeRaw.mockResolvedValue(undefined);
    prisma.codeChunk.create.mockResolvedValue({});

    const result = await reindexCodebaseFromGitHub();

    expect(result.repos).toBe(1);
    expect(result.files).toBe(1); // node_modules skipped
    expect(result.chunks).toBe(1);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.codeChunk.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ repo: 'org/repo', filePath: 'src/app.ts' }),
    }));
  });

  it('falls back to default branch when preferred branch is not found', async () => {
    process.env.GITHUB_REPO = 'org/repo';
    process.env.GITHUB_BRANCH = 'develop';

    vi.stubGlobal('fetch', vi.fn()
      // resolveGitHubBranch: preferred branch fails
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // fetch repo default branch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ default_branch: 'main' }) })
      // branch info with resolved branch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: 'def456' } }) })
      // tree
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tree: [], truncated: false }) }),
    );

    prisma.$executeRaw.mockResolvedValue(undefined);

    const result = await reindexCodebaseFromGitHub();
    expect(result.files).toBe(0);
  });

  it('skips files that fail to fetch content', async () => {
    process.env.GITHUB_REPO = 'org/repo';

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: 'abc' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        tree: [{ path: 'src/broken.ts', type: 'blob', sha: 's1' }],
        truncated: false,
      }) })
      // file content fails
      .mockResolvedValueOnce({ ok: false, status: 500 }),
    );

    prisma.$executeRaw.mockResolvedValue(undefined);

    const result = await reindexCodebaseFromGitHub();
    expect(result.files).toBe(0);
    expect(prisma.codeChunk.create).not.toHaveBeenCalled();
  });

  it('indexes multiple repos from GITHUB_REPOS env', async () => {
    process.env.GITHUB_REPOS = 'org/repo-a@main,org/repo-b@develop';

    vi.stubGlobal('fetch', vi.fn()
      // repo-a: branch ok, tree, file
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: 'sha-a' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tree: [{ path: 'a.ts', type: 'blob', sha: 's1' }], truncated: false }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'export const a = 1;' })
      // repo-b: branch ok, tree, file
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: 'sha-b' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tree: [{ path: 'b.ts', type: 'blob', sha: 's2' }], truncated: false }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'export const b = 2;' }),
    );

    prisma.$executeRaw.mockResolvedValue(undefined);
    prisma.codeChunk.create.mockResolvedValue({});

    const result = await reindexCodebaseFromGitHub();
    expect(result.repos).toBe(2);
    expect(result.files).toBe(2);
    expect(result.chunks).toBe(2);
  });
});

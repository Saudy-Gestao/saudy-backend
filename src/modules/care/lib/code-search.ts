import prismaModule from '../../../lib/prisma';

const prisma: any = (prismaModule as any)?.default ?? prismaModule;

const STOP_WORDS = new Set([
  'como', 'fazer', 'para', 'que', 'qual', 'quando', 'onde',
  'quem', 'por', 'uma', 'um', 'os', 'as', 'de', 'do', 'da',
  'no', 'na', 'em', 'com', 'se', 'o', 'a', 'e', 'é', 'eu',
  'posso', 'pode', 'tem', 'ter', 'ser', 'esta', 'está',
]);

type RepoConfig = { repo: string; branch?: string };
type GitTreeItem = { path: string; type: 'blob' | 'tree'; sha: string };
type GitTreeResponse = { tree: GitTreeItem[]; truncated: boolean };

function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

function isAllowedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.includes('node_modules/') || lower.includes('/dist/') || lower.includes('/build/') || lower.includes('.git/')) return false;
  return (
    lower.endsWith('.ts') || lower.endsWith('.tsx') ||
    lower.endsWith('.js') || lower.endsWith('.jsx') ||
    lower.endsWith('.prisma') || lower.endsWith('.sql') || lower.endsWith('.md')
  );
}

function chunkText(text: string, chunkSize = 1600, overlap = 200): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length <= chunkSize) return [normalized];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + chunkSize);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function buildGitHubHeaders(token?: string, accept = 'application/vnd.github+json'): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'saudy-indexer' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function resolveGitHubBranch(repo: string, preferredBranch: string, token?: string): Promise<string> {
  const headers = buildGitHubHeaders(token);
  const branchRes = await fetch(`https://api.github.com/repos/${repo}/branches/${preferredBranch}`, { headers });
  if (branchRes.ok) return preferredBranch;
  const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`Falha ao acessar repo ${repo}: ${repoRes.status}`);
  const repoJson = await repoRes.json() as { default_branch?: string };
  return repoJson.default_branch ?? preferredBranch;
}

async function fetchGitHubRepoTree(repo: string, branch: string, token?: string): Promise<{ branch: string; tree: GitTreeItem[] }> {
  const headers = buildGitHubHeaders(token);
  const resolvedBranch = await resolveGitHubBranch(repo, branch, token);
  const branchRes = await fetch(`https://api.github.com/repos/${repo}/branches/${resolvedBranch}`, { headers });
  if (!branchRes.ok) throw new Error(`Falha ao buscar branch ${resolvedBranch} em ${repo}: ${branchRes.status}`);
  const branchJson = await branchRes.json() as { commit?: { sha?: string } };
  const sha = branchJson?.commit?.sha;
  if (!sha) throw new Error(`SHA da branch ${resolvedBranch} não encontrado em ${repo}`);
  const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`Falha ao buscar árvore do repo ${repo}: ${treeRes.status}`);
  const treeJson = await treeRes.json() as GitTreeResponse;
  return {
    branch: resolvedBranch,
    tree: treeJson.tree.filter((item) => item.type === 'blob' && isAllowedFile(item.path)),
  };
}

async function fetchGitHubFileContent(repo: string, path: string, branch: string, token?: string): Promise<string> {
  const headers = buildGitHubHeaders(token, 'application/vnd.github.raw');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Falha ao buscar arquivo ${path} em ${repo}: ${res.status}`);
  return res.text();
}

function parseRepoConfig(value: string, fallbackBranch?: string): RepoConfig {
  const trimmed = value.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex > 0) return { repo: trimmed.slice(0, atIndex).trim(), branch: trimmed.slice(atIndex + 1).trim() || fallbackBranch };
  return { repo: trimmed, branch: fallbackBranch };
}

function resolveReposFromEnv(): RepoConfig[] {
  const fallbackBranch = process.env.GITHUB_BRANCH || 'main';
  const multi = (process.env.GITHUB_REPOS || '')
    .split(',')
    .map((s) => parseRepoConfig(s, fallbackBranch))
    .filter((config) => Boolean(config.repo));
  if (multi.length > 0) return multi;
  const single = (process.env.GITHUB_REPO || '').trim();
  return single ? [parseRepoConfig(single, fallbackBranch)] : [];
}

export async function reindexCodebaseFromGitHub(): Promise<{ repos: number; files: number; chunks: number }> {
  const repos = resolveReposFromEnv();
  const token = process.env.GITHUB_TOKEN;
  if (repos.length === 0) throw new Error('GITHUB_REPO ou GITHUB_REPOS não configurado');

  let chunksInserted = 0;
  let filesIndexed = 0;

  await prisma.$executeRaw`TRUNCATE TABLE code_chunks`;

  for (const { repo, branch = 'main' } of repos) {
    const { branch: resolvedBranch, tree } = await fetchGitHubRepoTree(repo, branch, token);
    for (const item of tree) {
      let content = '';
      try { content = await fetchGitHubFileContent(repo, item.path, resolvedBranch, token); } catch { continue; }
      const chunks = chunkText(content);
      if (chunks.length === 0) continue;
      filesIndexed += 1;
      for (let i = 0; i < chunks.length; i++) {
        await prisma.codeChunk.create({
          data: { repo, branch: resolvedBranch, filePath: item.path, chunkIndex: i, content: chunks[i] },
        });
        chunksInserted++;
      }
    }
  }

  return { repos: repos.length, files: filesIndexed, chunks: chunksInserted };
}

export async function searchCodebase(question: string): Promise<string> {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return '';

  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT repo, "filePath" AS file_path, "chunkIndex" AS chunk_index, content,
      (${keywords.map((_: any, i: number) => `CASE WHEN content ILIKE $${i + 1} THEN 1 ELSE 0 END`).join(' + ')}) AS score
     FROM code_chunks
     WHERE ${keywords.map((_: any, i: number) => `content ILIKE $${i + 1}`).join(' OR ')}
     ORDER BY score DESC, "filePath" ASC, "chunkIndex" ASC
     LIMIT 8`,
    ...keywords.map((kw: string) => `%${kw}%`),
  );

  if (rows.length === 0) return '';

  return rows
    .map((row: any) => {
      const trimmed = row.content.length > 1800 ? `${row.content.slice(0, 1800)}\n...` : row.content;
      return `// ${row.repo}/${row.file_path}#chunk-${row.chunk_index}\n${trimmed}`;
    })
    .join('\n\n---\n\n');
}

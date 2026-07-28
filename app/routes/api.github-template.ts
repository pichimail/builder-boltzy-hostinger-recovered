import { json } from '@remix-run/cloudflare';
import JSZip from 'jszip';

interface TemplateFile {
  name: string;
  path: string;
  content: string;
}

const GITHUB_API_BASE = 'https://api.github.com';
const MAX_TEMPLATE_FILES = 300;
const MAX_TEMPLATE_FILE_BYTES = 500_000;
const MAX_TEMPLATE_TOTAL_BYTES = 8_000_000;

function githubHeaders(githubToken?: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Chinna-DIY',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };
}

function validateRepositoryName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function normalizeArchivePath(filename: string, rootFolderName: string): string {
  if (rootFolderName && filename.startsWith(`${rootFolderName}/`)) {
    return filename.slice(rootFolderName.length + 1);
  }

  return filename;
}

function shouldSkipFile(path: string, size: number): boolean {
  if (!path || path.startsWith('.git/') || path.includes('/.git/')) {
    return true;
  }

  if (size > MAX_TEMPLATE_FILE_BYTES) {
    return true;
  }

  return false;
}

/**
 * Download the repository's default branch archive.
 *
 * The previous implementation requested /releases/latest. Most starter-template
 * repositories do not publish GitHub releases, so valid templates failed with a
 * 404 and the client silently continued with a blank project. A branch archive
 * exists for normal repositories and also avoids one GitHub API call per file.
 */
async function fetchRepoContents(repo: string, githubToken?: string): Promise<TemplateFile[]> {
  const headers = githubHeaders(githubToken);
  const repoResponse = await fetch(`${GITHUB_API_BASE}/repos/${repo}`, { headers });

  if (!repoResponse.ok) {
    throw new Error(`Repository lookup failed (${repoResponse.status}): ${repo}`);
  }

  const repoData = (await repoResponse.json()) as { default_branch?: string };
  const defaultBranch = repoData.default_branch;

  if (!defaultBranch) {
    throw new Error(`Repository has no default branch: ${repo}`);
  }

  const archiveResponse = await fetch(
    `${GITHUB_API_BASE}/repos/${repo}/zipball/${encodeURIComponent(defaultBranch)}`,
    {
      headers,
      redirect: 'follow',
    },
  );

  if (!archiveResponse.ok) {
    throw new Error(`Repository archive download failed (${archiveResponse.status}): ${repo}@${defaultBranch}`);
  }

  const zip = await JSZip.loadAsync(await archiveResponse.arrayBuffer());
  const entries = Object.values(zip.files);
  const firstNestedEntry = entries.find((entry) => entry.name.includes('/'));
  const rootFolderName = firstNestedEntry?.name.split('/')[0] || '';
  const files: TemplateFile[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.dir) {
      continue;
    }

    const path = normalizeArchivePath(entry.name, rootFolderName);
    const rawSize = (entry as any)._data?.uncompressedSize ?? 0;

    if (shouldSkipFile(path, rawSize)) {
      continue;
    }

    if (files.length >= MAX_TEMPLATE_FILES) {
      throw new Error(`Template contains more than ${MAX_TEMPLATE_FILES} files`);
    }

    const content = await entry.async('string');
    const contentBytes = new TextEncoder().encode(content).byteLength;

    if (contentBytes > MAX_TEMPLATE_FILE_BYTES) {
      continue;
    }

    totalBytes += contentBytes;

    if (totalBytes > MAX_TEMPLATE_TOTAL_BYTES) {
      throw new Error(`Template exceeds ${MAX_TEMPLATE_TOTAL_BYTES} bytes after extraction`);
    }

    files.push({
      name: path.split('/').pop() || '',
      path,
      content,
    });
  }

  if (files.length === 0) {
    throw new Error(`Template archive contained no importable files: ${repo}`);
  }

  return files;
}

export async function loader({ request, context }: { request: Request; context: any }) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo')?.trim();

  if (!repo) {
    return json({ error: 'Repository name is required' }, { status: 400 });
  }

  if (!validateRepositoryName(repo)) {
    return json({ error: 'Repository must use the owner/name format' }, { status: 400 });
  }

  try {
    const githubToken =
      context?.cloudflare?.env?.GITHUB_TOKEN ||
      context?.cloudflare?.env?.GITHUB_API_KEY ||
      process.env.GITHUB_TOKEN ||
      process.env.GITHUB_API_KEY ||
      process.env.VITE_GITHUB_ACCESS_TOKEN;

    const files = await fetchRepoContents(repo, githubToken);

    return json(files, {
      headers: {
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    console.error('Error processing GitHub template:', {
      repo,
      details,
    });

    return json(
      {
        error: 'Failed to fetch template files',
        details,
      },
      { status: 502 },
    );
  }
}

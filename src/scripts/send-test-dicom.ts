import fs from 'fs';
import path from 'path';

// Simple helper script to POST one or more DICOM files to the /dicom endpoint.
// Usage (with one file):
//   tsx src/scripts/send-test-dicom.ts <path-to-file> [token]
// Usage (multiple files):
//   tsx src/scripts/send-test-dicom.ts <file1> <file2> ... [token]
// If the last argument looks like a JWT (three dot‑separated segments) it
// will be used as auth token. You can also set DICOM_TOKEN in the env.

export async function runSendTestDicom(options: {
  argv?: string[];
  fsMod?: Pick<typeof fs, 'existsSync' | 'readFileSync'>;
  pathMod?: Pick<typeof path, 'resolve'>;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  logger?: Console;
  exit?: (code: number) => never | void;
} = {}) {
  const argv = options.argv || process.argv;
  const fsMod = options.fsMod || fs;
  const pathMod = options.pathMod || path;
  const fetchFn = options.fetchFn || fetch;
  const env = options.env || process.env;
  const logger = options.logger || console;
  const exit = options.exit || ((code: number) => process.exit(code));
  const args = argv.slice(2);
  if (args.length === 0) {
    logger.error('Usage: tsx src/scripts/send-test-dicom.ts <path-to-file> [<path2>..] [token]');
    exit(1);
    return;
  }

  // determine token if last arg looks like JWT
  let token = env.DICOM_TOKEN || '';
  if (args.length > 1 && args[args.length - 1].split('.').length === 3) {
    token = args.pop()!;
  }

  const filePaths = args.map((p) => pathMod.resolve(p));
  for (const fp of filePaths) {
    if (!fsMod.existsSync(fp)) {
      logger.error('File does not exist:', fp);
      exit(1);
      return;
    }
  }

  const base64List = filePaths.map((fp) => {
    const buffer = fsMod.readFileSync(fp);
    return buffer.toString('base64');
  });

  const url = env.API_URL || 'http://localhost:3000/dicom/';
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  logger.log(`uploading ${filePaths.join(', ')} to ${url}`);
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base64: base64List }),
  });

  const text = await res.text();
  try {
    logger.log('response', JSON.parse(text));
  } catch {
    logger.log('response', text);
  }
}

/* c8 ignore next 5 */
if (require.main === module) {
  runSendTestDicom().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

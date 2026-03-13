import fs from 'fs';
import path from 'path';

// Simple helper script to POST one or more DICOM files to the /dicom endpoint.
// Usage (with one file):
//   tsx src/scripts/send-test-dicom.ts <path-to-file> [token]
// Usage (multiple files):
//   tsx src/scripts/send-test-dicom.ts <file1> <file2> ... [token]
// If the last argument looks like a JWT (three dot‑separated segments) it
// will be used as auth token. You can also set DICOM_TOKEN in the env.

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: tsx src/scripts/send-test-dicom.ts <path-to-file> [<path2>..] [token]');
    process.exit(1);
  }

  // determine token if last arg looks like JWT
  let token = process.env.DICOM_TOKEN || '';
  if (args.length > 1 && args[args.length - 1].split('.').length === 3) {
    token = args.pop()!;
  }

  const filePaths = args.map((p) => path.resolve(p));
  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) {
      console.error('File does not exist:', fp);
      process.exit(1);
    }
  }

  const base64List = filePaths.map((fp) => {
    const buffer = fs.readFileSync(fp);
    return buffer.toString('base64');
  });

  const url = process.env.API_URL || 'http://localhost:3000/dicom/';
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  console.log(`uploading ${filePaths.join(', ')} to ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base64: base64List }),
  });

  const text = await res.text();
  try {
    console.log('response', JSON.parse(text));
  } catch {
    console.log('response', text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
import selfsigned from 'selfsigned';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'certs');
const KEY_PATH = join(CERT_DIR, 'key.pem');
const CERT_PATH = join(CERT_DIR, 'cert.pem');

export async function ensureCerts() {
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) {
    return {
      key: readFileSync(KEY_PATH),
      cert: readFileSync(CERT_PATH),
    };
  }

  mkdirSync(CERT_DIR, { recursive: true });
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: '127.0.0.1' }],
    {
      days: 365,
      keySize: 2048,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [{ type: 7, ip: '127.0.0.1' }],
        },
      ],
    }
  );

  writeFileSync(KEY_PATH, pems.private);
  writeFileSync(CERT_PATH, pems.cert);

  return { key: pems.private, cert: pems.cert };
}

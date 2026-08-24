import { existsSync, readFileSync } from 'node:fs';
import { Agent as HttpsAgent } from 'node:https';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { Agent as UndiciAgent } from 'undici';
import { createSsrfSafeLookup } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';

const RUSSIAN_TRUSTED_ROOT_CA_RELATIVE_PATH = path.join(
  'var',
  'docker',
  'russian_trusted_root_ca.pem'
);

type MaxTlsTransports = {
  dispatcher: UndiciAgent;
  httpsAgent: HttpsAgent;
};

let cachedTransports: MaxTlsTransports | undefined;

export function getMaxDispatcher(): UndiciAgent {
  return getMaxTlsTransports().dispatcher;
}

export function getMaxHttpsAgent(): HttpsAgent {
  return getMaxTlsTransports().httpsAgent;
}

function getMaxTlsTransports(): MaxTlsTransports {
  if (cachedTransports) {
    return cachedTransports;
  }

  const cwdCandidate = path.resolve(
    process.cwd(),
    RUSSIAN_TRUSTED_ROOT_CA_RELATIVE_PATH
  );
  const pemPath = existsSync(cwdCandidate)
    ? cwdCandidate
    : path.resolve(
        findWorkspaceRoot(__dirname),
        RUSSIAN_TRUSTED_ROOT_CA_RELATIVE_PATH
      );
  const ca = [...tls.rootCertificates, readFileSync(pemPath, 'utf8')];

  cachedTransports = {
    dispatcher: new UndiciAgent({
      connect: {
        ca,
        lookup: createSsrfSafeLookup(),
      },
    }),
    httpsAgent: new HttpsAgent({
      ca,
      lookup: createSsrfSafeLookup(),
    }),
  };

  return cachedTransports;
}

function findWorkspaceRoot(start: string): string {
  let cursor = start;
  while (true) {
    if (existsSync(path.join(cursor, 'pnpm-workspace.yaml'))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error('Postiz workspace root not found for MAX TLS trust');
    }
    cursor = parent;
  }
}


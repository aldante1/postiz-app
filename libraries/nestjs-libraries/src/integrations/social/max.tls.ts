import { readFileSync, existsSync } from 'node:fs';
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

  const russianRootPem = readRussianTrustedRootPem();
  const ca = [...tls.rootCertificates, russianRootPem];

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

function readRussianTrustedRootPem(): string {
  const candidates = russianTrustedRootCandidates();
  const pemPath = candidates.find((candidate) => existsSync(candidate));
  if (!pemPath) {
    throw new Error(
      `Russian trusted root CA PEM not found at ${RUSSIAN_TRUSTED_ROOT_CA_RELATIVE_PATH}`
    );
  }

  return readFileSync(pemPath, 'utf8');
}

function russianTrustedRootCandidates(): string[] {
  const candidates = [
    path.resolve(process.cwd(), RUSSIAN_TRUSTED_ROOT_CA_RELATIVE_PATH),
  ];

  let cursor = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    candidates.push(path.resolve(cursor, RUSSIAN_TRUSTED_ROOT_CA_RELATIVE_PATH));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return [...new Set(candidates)];
}

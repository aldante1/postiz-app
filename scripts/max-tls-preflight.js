#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const MAX_TLS_HELPER_PATH =
  '/app/apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/max.tls.js';
const RUSSIAN_TRUSTED_ROOT_CA_PATH =
  '/app/var/docker/russian_trusted_root_ca.pem';
const RUSSIAN_TRUSTED_ROOT_CA_SHA256 =
  '936a43fea6e8e525bcc0f81acd9c3d21b4fc4b9b68acea7906d698005afc6504';
const MAX_ME_URL = 'https://platform-api2.max.ru/me';
const INTENTIONALLY_INVALID_TOKEN = 'postiz-max-tls-preflight-invalid-token';

function fail(message) {
  console.error(`MAX TLS preflight failed: ${message}`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_EXTRA_CA_CERTS) {
    fail('NODE_EXTRA_CA_CERTS must be unset');
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    fail('NODE_TLS_REJECT_UNAUTHORIZED must not be 0');
  }

  let tlsHelper;
  try {
    tlsHelper = require(MAX_TLS_HELPER_PATH);
  } catch (err) {
    fail(`could not require built MAX TLS helper at ${MAX_TLS_HELPER_PATH}`);
  }

  if (!tlsHelper || typeof tlsHelper.getMaxDispatcher !== 'function') {
    fail('built MAX TLS helper does not export getMaxDispatcher()');
  }

  let pem;
  try {
    pem = fs.readFileSync(RUSSIAN_TRUSTED_ROOT_CA_PATH);
  } catch (err) {
    fail(`could not read ${RUSSIAN_TRUSTED_ROOT_CA_PATH}`);
  }

  const pemSha256 = crypto.createHash('sha256').update(pem).digest('hex');
  if (pemSha256 !== RUSSIAN_TRUSTED_ROOT_CA_SHA256) {
    fail(
      `unexpected Russian trusted root CA SHA-256 ${pemSha256}; expected ${RUSSIAN_TRUSTED_ROOT_CA_SHA256}`
    );
  }

  const dispatcher = tlsHelper.getMaxDispatcher();
  let response;
  try {
    response = await fetch(MAX_ME_URL, {
      method: 'GET',
      headers: {
        Authorization: INTENTIONALLY_INVALID_TOKEN,
      },
      dispatcher,
    });
    await response.body?.cancel();
  } finally {
    await dispatcher.close();
  }

  if (response.status !== 401) {
    fail(`expected MAX /me to reject the invalid token with HTTP 401, got ${response.status}`);
  }

  console.log('MAX TLS preflight OK: pinned CA accepted and MAX returned HTTP 401');
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});

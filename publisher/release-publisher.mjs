#!/usr/bin/env node
import duckdb from 'duckdb';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(APP_ROOT, 'releases.duckdb');
const MANIFEST_PATH = path.join(APP_ROOT, 'fixtures', 'build_manifest.csv');
const CERT_PATH = path.join(APP_ROOT, 'keys', 'current', 'current.cert.pem');
const KEY_PATH = path.join(APP_ROOT, 'keys', 'current', 'current.key.pem');
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:7070';

function canonicalEncode(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalEncode).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalEncode(value[k]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value);
}

function runQuery(conn, sql, ...params) {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err) => (err ? reject(err) : resolve()));
  });
}

function queryAll(conn, sql, ...params) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function withConnection(fn) {
  const db = new duckdb.Database(DB_PATH);
  const conn = db.connect();
  return fn(conn).finally(
    () =>
      new Promise((resolve) => {
        conn.close(() => {
          db.close(resolve);
        });
      })
  );
}

async function initDatabase(conn) {
  await runQuery(conn, `
    CREATE TABLE IF NOT EXISTS publications (
      bundle_id VARCHAR PRIMARY KEY,
      request_token VARCHAR NOT NULL,
      publication_id VARCHAR NOT NULL,
      descriptor VARCHAR NOT NULL
    )
  `);
}

async function loadManifest(conn) {
  await runQuery(conn, 'DROP TABLE IF EXISTS manifest');
  await runQuery(
    conn,
    `CREATE TABLE manifest AS
     SELECT * FROM read_csv(?, header = true, auto_detect = true)`,
    MANIFEST_PATH
  );
}

async function getPublishableBundles(conn) {
  return queryAll(
    conn,
    `
    WITH deduped AS (
      SELECT DISTINCT *
      FROM manifest
    ),
    withdrawn AS (
      SELECT supersedes_id AS entry_id
      FROM deduped
      WHERE record_type = 'WITHDRAWAL'
    ),
    active_builds AS (
      SELECT *
      FROM deduped
      WHERE record_type = 'BUILD'
        AND entry_id NOT IN (SELECT entry_id FROM withdrawn)
    )
    SELECT
      bundle_id,
      CAST(COUNT(*) AS INTEGER) AS artifact_count,
      CAST(SUM(size_bytes) AS BIGINT) AS total_bytes
    FROM active_builds
    GROUP BY bundle_id
    ORDER BY bundle_id
    `
  );
}

async function lookupStoredReceipt(conn, bundleId) {
  const rows = await queryAll(
    conn,
    `SELECT request_token, publication_id, descriptor
     FROM publications
     WHERE bundle_id = ?`,
    bundleId
  );
  return rows[0] ?? null;
}

async function storeReceipt(conn, bundleId, requestToken, publicationId, descriptor) {
  await runQuery(
    conn,
    `INSERT INTO publications (bundle_id, request_token, publication_id, descriptor)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (bundle_id) DO UPDATE SET
       request_token = excluded.request_token,
       publication_id = excluded.publication_id,
       descriptor = excluded.descriptor`,
    bundleId,
    requestToken,
    publicationId,
    descriptor
  );
}

function signDescriptor(descriptor) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-sign-'));
  const contentFile = path.join(scratch, 'descriptor.bin');
  try {
    fs.writeFileSync(contentFile, descriptor, 'utf8');
    const signature = execFileSync(
      'openssl',
      [
        'cms',
        '-sign',
        '-in',
        contentFile,
        '-signer',
        CERT_PATH,
        '-inkey',
        KEY_PATH,
        '-outform',
        'PEM',
        '-binary',
      ],
      { encoding: 'utf8' }
    );
    return signature;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function fetchCurrentKey() {
  const res = await fetch(`${GATEWAY_URL}/v1/signing-key/current`);
  if (!res.ok) {
    throw new Error(`Failed to fetch signing key metadata: HTTP ${res.status}`);
  }
  return res.json();
}

async function submitPublication(descriptor, signature, requestToken) {
  const res = await fetch(`${GATEWAY_URL}/v1/publications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      descriptor,
      signature,
      request_token: requestToken,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      body.error
        ? `Publication rejected: ${body.error}`
        : `Publication failed: HTTP ${res.status}`
    );
  }
  return body;
}

async function publishBundle(conn, bundle, keyId) {
  const requestToken = `token-${bundle.bundle_id}`;
  const stored = await lookupStoredReceipt(conn, bundle.bundle_id);

  const descriptor = canonicalEncode({
    artifact_count: bundle.artifact_count,
    bundle_id: bundle.bundle_id,
    total_bytes: Number(bundle.total_bytes),
  });

  console.log(`BUNDLE ${bundle.bundle_id} SIGNED KEY=${keyId}`);

  let receipt;
  if (stored) {
    receipt = {
      publication_id: stored.publication_id,
      request_token: stored.request_token,
      status: 'PUBLISHED',
    };
  } else {
    const signature = signDescriptor(descriptor);
    receipt = await submitPublication(descriptor, signature, requestToken);
    await storeReceipt(
      conn,
      bundle.bundle_id,
      receipt.request_token,
      receipt.publication_id,
      descriptor
    );
  }

  console.log(
    `BUNDLE ${bundle.bundle_id} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${receipt.request_token} STATUS=${receipt.status}`
  );
}

async function runReport() {
  await withConnection(async (conn) => {
    await initDatabase(conn);
    await loadManifest(conn);

    const bundles = await getPublishableBundles(conn);
    const keyMeta = await fetchCurrentKey();

    for (const bundle of bundles) {
      await publishBundle(conn, bundle, keyMeta.key_id);
    }
  });
}

const isReport = process.argv.includes('--report');
if (isReport) {
  runReport().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else {
  console.error('Usage: node publisher/release-publisher.mjs --report');
  process.exit(1);
}

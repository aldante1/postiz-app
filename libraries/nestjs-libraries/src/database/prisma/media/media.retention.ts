import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const UPLOAD_URL_PREFIX = '/uploads/';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);

  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

export function normalizeMediaReference(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return value;
    }

    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return value;
  }
}

function visitStrings(value: JsonValue, visit: (value: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitStrings(item, visit);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      visitStrings(item, visit);
    }
  }
}

function replaceMatchingObjects(
  value: JsonValue,
  mediaId: string,
  previewUrl: string
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      replaceMatchingObjects(item, mediaId, previewUrl);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (value.id === mediaId) {
    value.path = previewUrl;
    value.url = previewUrl;
  }

  for (const item of Object.values(value)) {
    replaceMatchingObjects(item, mediaId, previewUrl);
  }
}

function referencesFromParsedJson(parsed: JsonValue): Set<string> {
  const references = new Set<string>();
  visitStrings(parsed, (value) => references.add(normalizeMediaReference(value)));
  return references;
}

export function toLocalUploadPath(
  publicUrl: string,
  frontendUrl: string,
  uploadDirectory: string
): string | null {
  try {
    const publicLocation = new URL(publicUrl);
    const frontendLocation = new URL(frontendUrl);

    if (publicLocation.origin !== frontendLocation.origin) {
      return null;
    }

    const decodedPath = decodeURIComponent(publicLocation.pathname);
    if (
      !decodedPath.startsWith(UPLOAD_URL_PREFIX) ||
      decodedPath.includes('\0') ||
      decodedPath.includes('\\')
    ) {
      return null;
    }

    const uploadRoot = realpathSync(uploadDirectory);
    const candidate = resolve(
      uploadRoot,
      decodedPath.slice(UPLOAD_URL_PREFIX.length)
    );
    if (!isInside(uploadRoot, candidate)) {
      return null;
    }

    const candidateStat = lstatSync(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      return null;
    }

    const canonicalCandidate = realpathSync(candidate);
    return isInside(uploadRoot, canonicalCandidate) ? canonicalCandidate : null;
  } catch {
    return null;
  }
}

export function parseMediaReferences(json: string): {
  references: Set<string>;
  valid: boolean;
} {
  try {
    return {
      references: referencesFromParsedJson(JSON.parse(json) as JsonValue),
      valid: true,
    };
  } catch {
    return { references: new Set<string>(), valid: false };
  }
}

export function collectMediaReferences(json: string): Set<string> {
  return parseMediaReferences(json).references;
}

export function collectScalarMediaReferences(
  value: string | null | undefined
): Set<string> {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return new Set<string>();
  }

  return new Set([normalizeMediaReference(trimmed)]);
}

export function replaceMediaReference(
  json: string,
  mediaId: string,
  previewUrl: string
): string {
  const parsed = JSON.parse(json) as JsonValue;
  replaceMatchingObjects(parsed, mediaId, previewUrl);
  return JSON.stringify(parsed);
}

export function recoveryAction({
  previewExists,
  originalExists,
}: {
  previewExists: boolean;
  originalExists: boolean;
}): 'purge' | 'finalize' | 'regenerate' | 'error' {
  if (previewExists) {
    return originalExists ? 'purge' : 'finalize';
  }

  return originalExists ? 'regenerate' : 'error';
}

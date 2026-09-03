import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import sharp from 'sharp';
import { toLocalUploadPath } from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';

sharp.concurrency(1);

const VIDEO_EXTENSION: Record<string, true> = {
  '.avi': true,
  '.m4v': true,
  '.mkv': true,
  '.mov': true,
  '.mp4': true,
  '.webm': true,
};

export interface PreviewMedia {
  id: string;
  type: string;
  thumbnail: string | null;
}

export interface PreviewResult {
  publicUrl: string;
  filePath: string;
  kind: 'webp' | 'jpg';
}

export interface FileIdentity {
  path: string;
  size: number;
  device: number;
  inode: number;
  mtimeMs: number;
}

export interface PreparedPreview {
  tempPath: string;
  result: PreviewResult;
  identity: FileIdentity;
}

export type FfmpegRunner = (args: string[]) => Promise<void>;

export interface PreviewWriterOptions {
  uploadDirectory: string;
  frontendUrl: string;
  runFfmpeg?: FfmpegRunner;
  ffmpegTimeoutMs?: number;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function missingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function ensureDirectoryComponent(
  root: string,
  current: string
): Promise<void> {
  try {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe retention directory: ${current}`);
    }
  } catch (error: unknown) {
    if (!missingFile(error)) throw error;
    await mkdir(current, { mode: 0o700 });
    const created = await lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`unsafe retention directory: ${current}`);
    }
  }
  const canonical = await realpath(current);
  if (!isInside(root, canonical) || canonical !== current) {
    throw new Error(`unsafe retention directory: ${current}`);
  }
}

export async function ensureRetentionDirectories(
  uploadDirectory: string,
  includeQuarantine = false
): Promise<{ root: string; retention: string; quarantine?: string }> {
  const root = await realpath(uploadDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`unsafe uploads directory: ${uploadDirectory}`);
  }
  const retention = join(root, '.retention');
  await ensureDirectoryComponent(root, retention);
  if (!includeQuarantine) return { root, retention };
  const quarantine = join(retention, 'quarantine');
  await ensureDirectoryComponent(root, quarantine);
  return { root, retention, quarantine };
}

export async function inspectContainedFile(
  rootDirectory: string,
  filePath: string
): Promise<FileIdentity> {
  const logicalRoot = resolve(rootDirectory);
  const root = await realpath(logicalRoot);
  const expected = resolve(filePath);
  let fromRoot: string;
  if (isInside(logicalRoot, expected)) {
    fromRoot = relative(logicalRoot, expected);
  } else if (isInside(root, expected)) {
    fromRoot = relative(root, expected);
  } else {
    throw new Error(`unsafe file outside uploads: ${filePath}`);
  }
  const segments = fromRoot.split(sep).filter(Boolean);
  let current = root;
  let stat = await lstat(root);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    stat = await lstat(current);
    const isLast = index === segments.length - 1;
    if (
      stat.isSymbolicLink() ||
      (isLast ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new Error(`unsafe upload path component: ${filePath}`);
    }
  }
  if (segments.length === 0 || !stat.isFile()) {
    throw new Error(`unsafe non-file upload entry: ${filePath}`);
  }
  const canonical = await realpath(current);
  if (canonical !== current || !isInside(root, canonical)) {
    throw new Error(`unsafe file outside uploads: ${filePath}`);
  }
  return {
    path: canonical,
    size: stat.size,
    device: stat.dev,
    inode: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity
): boolean {
  return (
    left.path === right.path &&
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mtimeMs === right.mtimeMs
  );
}

async function detectVideo(sourcePath: string): Promise<boolean> {
  if (VIDEO_EXTENSION[extname(sourcePath).toLowerCase()]) return true;
  let handle;
  try {
    handle = await open(sourcePath, 'r');
  } catch (error: unknown) {
    if (missingFile(error)) return false;
    throw error;
  }
  try {
    const bytes = Buffer.allocUnsafe(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead >= 8 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
      return true;
    }
    if (
      bytesRead >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    ) {
      return true;
    }
    return (
      bytesRead >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'AVI '
    );
  } finally {
    await handle.close();
  }
}

export async function previewLocation(
  media: PreviewMedia,
  sourcePath: string,
  options: Pick<PreviewWriterOptions, 'uploadDirectory' | 'frontendUrl'>
): Promise<PreviewResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(media.id)) {
    throw new Error(`unsafe media id: ${media.id}`);
  }
  const kind = (await detectVideo(sourcePath)) ? 'jpg' : 'webp';
  const relativePath = `.retention/${media.id}.${kind}`;
  return {
    publicUrl: new URL(`/uploads/${relativePath}`, options.frontendUrl).toString(),
    filePath: join(await realpath(options.uploadDirectory), relativePath),
    kind,
  };
}

export async function quarantineAndUnlink(
  uploadDirectory: string,
  source: FileIdentity
): Promise<number> {
  const directories = await ensureRetentionDirectories(uploadDirectory, true);
  const quarantine = directories.quarantine!;
  const current = await inspectContainedFile(directories.root, source.path);
  if (!sameFileIdentity(current, source)) {
    throw new Error(`unsafe file changed before quarantine: ${source.path}`);
  }
  const quarantinePath = join(quarantine, `${randomUUID()}.pending`);
  await rename(source.path, quarantinePath);
  try {
    const moved = await inspectContainedFile(directories.root, quarantinePath);
    const expectedMoved = { ...source, path: quarantinePath };
    if (!sameFileIdentity(moved, expectedMoved)) {
      throw new Error(`unsafe file changed during quarantine: ${source.path}`);
    }
    await unlink(quarantinePath);
    return source.size;
  } catch (error: unknown) {
    try {
      await lstat(source.path);
    } catch (sourceError: unknown) {
      if (missingFile(sourceError)) {
        const parent = await realpath(dirname(source.path));
        if (isInside(directories.root, parent) && parent === dirname(source.path)) {
          await rename(quarantinePath, source.path);
        }
      }
    }
    throw error;
  }
}

function defaultFfmpegRunner(
  args: string[],
  timeoutMs: number
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(
    'ffmpeg',
    args,
    { shell: false, timeout: timeoutMs, killSignal: 'SIGKILL' },
    (error) => {
      if (error) reject(error);
      else resolve();
    }
  );
  return promise;
}

export class PreviewWriter {
  private readonly runFfmpeg: FfmpegRunner;

  constructor(private readonly options: PreviewWriterOptions) {
    const timeoutMs = options.ffmpegTimeoutMs ?? 30_000;
    this.runFfmpeg =
      options.runFfmpeg ??
      ((args) => defaultFfmpegRunner(args, timeoutMs));
  }

  location(media: PreviewMedia, sourcePath: string): Promise<PreviewResult> {
    return previewLocation(media, sourcePath, this.options);
  }

  async prepare(
    media: PreviewMedia,
    sourcePath: string
  ): Promise<PreparedPreview> {
    const source = await inspectContainedFile(
      this.options.uploadDirectory,
      sourcePath
    );
    const result = await this.location(media, source.path);
    const { root, retention } = await ensureRetentionDirectories(
      this.options.uploadDirectory
    );
    if (dirname(result.filePath) !== retention) {
      throw new Error(`unsafe preview location: ${result.filePath}`);
    }
    const tempPath = join(
      retention,
      `.${media.id}.${randomUUID()}.tmp.${result.kind}`
    );

    try {
      if (result.kind === 'webp') {
        await sharp(source.path)
          .rotate()
          .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(tempPath);
      } else {
        const localThumbnail = media.thumbnail
          ? toLocalUploadPath(
              media.thumbnail,
              this.options.frontendUrl,
              this.options.uploadDirectory
            )
          : null;
        if (localThumbnail) {
          await sharp(localThumbnail)
            .rotate()
            .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(tempPath);
        } else {
          await this.runFfmpeg([
            '-threads',
            '1',
            '-ss',
            '0',
            '-i',
            source.path,
            '-frames:v',
            '1',
            '-vf',
            'scale=720:-2',
            tempPath,
          ]);
        }
      }

      const handle = await open(tempPath, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0) {
          throw new Error('preview output is empty');
        }
        await sharp(tempPath).metadata();
      } finally {
        await handle.close();
      }
      const identity = await inspectContainedFile(root, tempPath);
      return { tempPath, result, identity };
    } catch (error: unknown) {
      try {
        const partial = await inspectContainedFile(root, tempPath);
        if (dirname(partial.path) === retention) await unlink(partial.path);
      } catch {
        // Never follow a changed directory during failed-preview cleanup.
      }
      throw error;
    }
  }

  async publish(prepared: PreparedPreview): Promise<PreviewResult> {
    const { root, retention } = await ensureRetentionDirectories(
      this.options.uploadDirectory
    );
    if (
      dirname(prepared.tempPath) !== retention ||
      dirname(prepared.result.filePath) !== retention
    ) {
      throw new Error('unsafe prepared preview location');
    }
    const current = await inspectContainedFile(root, prepared.tempPath);
    if (!sameFileIdentity(current, prepared.identity)) {
      throw new Error('prepared preview changed before publish');
    }
    await rename(prepared.tempPath, prepared.result.filePath);
    const published = await inspectContainedFile(root, prepared.result.filePath);
    const expectedPublished = {
      ...prepared.identity,
      path: prepared.result.filePath,
    };
    if (!sameFileIdentity(published, expectedPublished)) {
      throw new Error('published preview identity mismatch');
    }
    return prepared.result;
  }

  async discard(prepared: PreparedPreview): Promise<void> {
    try {
      const { root, retention } = await ensureRetentionDirectories(
        this.options.uploadDirectory
      );
      if (dirname(prepared.tempPath) !== retention) return;
      const current = await inspectContainedFile(root, prepared.tempPath);
      if (sameFileIdentity(current, prepared.identity)) {
        await unlink(prepared.tempPath);
      }
    } catch (error: unknown) {
      if (!missingFile(error)) throw error;
    }
  }

  async write(media: PreviewMedia, sourcePath: string): Promise<PreviewResult> {
    const prepared = await this.prepare(media, sourcePath);
    try {
      return await this.publish(prepared);
    } catch (error: unknown) {
      await this.discard(prepared);
      throw error;
    }
  }
}

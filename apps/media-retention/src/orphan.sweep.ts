import { opendir, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  collectScalarMediaReferences,
  normalizeMediaReference,
  parseMediaReferences,
} from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';

export type DatabaseQuery = Record<string, unknown>;

export interface MediaRow {
  id: string;
  name: string;
  path: string;
  thumbnail: string | null;
  archivePreviewPath: string | null;
  fileSize: number;
  type: string;
  organizationId: string;
  createdAt: Date;
  deletedAt: Date | null;
  retentionState: 'ACTIVE' | 'STAGED' | 'PURGED';
  originalPurgedAt: Date | null;
}

interface PostRow {
  id: string;
  state: string;
  deletedAt: Date | null;
  image: string | null;
  settings: string | null;
}

interface JsonHolderRow {
  id: string;
  content: string;
}

interface PictureRow {
  id: string;
  picture: string | null;
  deletedAt: Date | null;
}

interface IdHolderRow {
  id: string;
  pictureId?: string | null;
  logoId?: string | null;
  deletedAt?: Date | null;
}

interface FindManyDelegate<T> {
  findMany(args: DatabaseQuery): Promise<T[]>;
}

interface MediaDelegate extends FindManyDelegate<MediaRow> {
  findFirst(args: DatabaseQuery): Promise<MediaRow | null>;
  update(args: DatabaseQuery): Promise<MediaRow>;
}

interface PostDelegate extends FindManyDelegate<PostRow> {
  update(args: DatabaseQuery): Promise<PostRow>;
}

export interface RetentionTransactionDatabase {
  media: MediaDelegate;
  post: PostDelegate;
  sets: FindManyDelegate<JsonHolderRow>;
  integration: FindManyDelegate<PictureRow>;
  user: FindManyDelegate<IdHolderRow>;
  socialMediaAgency: FindManyDelegate<IdHolderRow>;
  oAuthApp: FindManyDelegate<IdHolderRow>;
  $queryRaw<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

export interface RetentionDatabase extends RetentionTransactionDatabase {
  $transaction<T>(
    callback: (transaction: RetentionTransactionDatabase) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T>;
}

export interface MalformedHolder {
  holder: 'Post.image' | 'Post.settings' | 'Sets.content';
  rowId: string;
  raw: string;
}

export interface PublishedPostReference {
  id: string;
  image: string | null;
  settings: string | null;
  references: Set<string>;
}
export interface MediaFieldReference {
  mediaId: string;
  references: Set<string>;
}


export interface HolderSnapshot {
  blockingReferences: Set<string>;
  liveReferences: Set<string>;
  mediaById: Map<string, MediaRow>;
  mediaFieldReferences: MediaFieldReference[];
  malformed: MalformedHolder[];
  publishedPosts: PublishedPostReference[];
}

function addReferences(target: Set<string>, references: Iterable<string>): void {
  for (const reference of references) target.add(reference);
}

function readJsonHolder(
  raw: string | null,
  holder: MalformedHolder['holder'],
  rowId: string,
  malformed: MalformedHolder[]
): Set<string> {
  if (!raw) return new Set<string>();
  const parsed = parseMediaReferences(raw);
  if (!parsed.valid) malformed.push({ holder, rowId, raw });
  return parsed.references;
}

export async function discoverHolders(
  prisma: RetentionTransactionDatabase
): Promise<HolderSnapshot> {
  const [posts, sets, integrations, mediaRows, users, agencies, oauthApps] =
    await Promise.all([
      prisma.post.findMany({
        select: { id: true, state: true, deletedAt: true, image: true, settings: true },
      }),
      prisma.sets.findMany({ select: { id: true, content: true } }),
      prisma.integration.findMany({
        where: { deletedAt: null },
        select: { id: true, picture: true, deletedAt: true },
      }),
      prisma.media.findMany({
        select: {
          id: true,
          name: true,
          path: true,
          thumbnail: true,
          archivePreviewPath: true,
          fileSize: true,
          type: true,
          organizationId: true,
          createdAt: true,
          deletedAt: true,
          retentionState: true,
          originalPurgedAt: true,
        },
      }),
      prisma.user.findMany({
        where: { pictureId: { not: null } },
        select: { id: true, pictureId: true },
      }),
      prisma.socialMediaAgency.findMany({
        where: { deletedAt: null, logoId: { not: null } },
        select: { id: true, logoId: true, deletedAt: true },
      }),
      prisma.oAuthApp.findMany({
        where: { deletedAt: null, pictureId: { not: null } },
        select: { id: true, pictureId: true, deletedAt: true },
      }),
    ]);

  const blockingReferences = new Set<string>();
  const liveReferences = new Set<string>();
  const malformed: MalformedHolder[] = [];
  const publishedPosts: PublishedPostReference[] = [];
  const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
  const mediaFieldReferences: MediaFieldReference[] = [];

  for (const post of posts) {
    if (post.deletedAt) continue;
    const references = new Set<string>();
    addReferences(
      references,
      readJsonHolder(post.image, 'Post.image', post.id, malformed)
    );
    addReferences(
      references,
      readJsonHolder(post.settings, 'Post.settings', post.id, malformed)
    );
    addReferences(liveReferences, references);
    if (post.state === 'PUBLISHED') {
      publishedPosts.push({
        id: post.id,
        image: post.image,
        settings: post.settings,
        references,
      });
    } else {
      addReferences(blockingReferences, references);
    }
  }

  for (const set of sets) {
    const references = readJsonHolder(
      set.content,
      'Sets.content',
      set.id,
      malformed
    );
    addReferences(blockingReferences, references);
    addReferences(liveReferences, references);
  }

  for (const integration of integrations) {
    const references = collectScalarMediaReferences(integration.picture);
    addReferences(blockingReferences, references);
    addReferences(liveReferences, references);
  }

  for (const row of mediaRows) {
    if (row.deletedAt) continue;
    const references = new Set<string>();
    if (row.retentionState !== 'PURGED') {
      references.add(normalizeMediaReference(row.path));
    }
    for (const value of [row.thumbnail, row.archivePreviewPath]) {
      addReferences(references, collectScalarMediaReferences(value));
    }
    addReferences(liveReferences, references);
    mediaFieldReferences.push({ mediaId: row.id, references });
  }

  for (const holder of [...users, ...agencies, ...oauthApps]) {
    if (holder.deletedAt) continue;
    const mediaId = holder.pictureId ?? holder.logoId;
    if (!mediaId) continue;
    blockingReferences.add(mediaId);
    liveReferences.add(mediaId);
  }

  return {
    blockingReferences,
    liveReferences,
    mediaById,
    mediaFieldReferences,
    malformed,
    publishedPosts,
  };
}

export function holderMatchesMedia(
  references: Set<string>,
  media: Pick<MediaRow, 'id' | 'path'>
): boolean {
  return (
    references.has(media.id) ||
    references.has(normalizeMediaReference(media.path))
  );
}

export function malformedHolderMatches(
  holder: MalformedHolder,
  media: Pick<MediaRow, 'id' | 'path'>
): boolean {
  const normalizedPath = normalizeMediaReference(media.path);
  let pathname = normalizedPath;
  try {
    pathname = new URL(normalizedPath).pathname;
  } catch {
    // A non-URL media path is still checked verbatim below.
  }
  return (
    holder.raw.includes(media.id) ||
    holder.raw.includes(normalizedPath) ||
    holder.raw.includes(pathname)
  );
}

export function expectedLocalUploadPath(
  publicUrl: string,
  frontendUrl: string,
  uploadDirectory: string
): string | null {
  try {
    const location = new URL(publicUrl);
    const frontend = new URL(frontendUrl);
    if (location.origin !== frontend.origin) return null;
    const pathname = decodeURIComponent(location.pathname);
    if (
      !pathname.startsWith('/uploads/') ||
      pathname.includes('\0') ||
      pathname.includes('\\')
    ) {
      return null;
    }
    const root = resolve(uploadDirectory);
    const candidate = resolve(root, pathname.slice('/uploads/'.length));
    const fromRoot = relative(root, candidate);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function holderLivePaths(
  snapshot: HolderSnapshot,
  frontendUrl: string,
  uploadDirectory: string
): Set<string> {
  const paths = new Set<string>();
  for (const reference of snapshot.liveReferences) {
    const mediaPath = snapshot.mediaById.get(reference)?.path ?? reference;
    const localPath = expectedLocalUploadPath(
      mediaPath,
      frontendUrl,
      uploadDirectory
    );
    if (localPath) paths.add(localPath);
  }
  return paths;
}

export interface OrphanFileReport {
  path: string;
  bytes: number;
  deleted: boolean;
}

export interface OrphanSweepResult {
  files: OrphanFileReport[];
  bytesFreed: number;
  errors: string[];
}

export interface OrphanSweepOptions {
  mode: 'report' | 'apply';
  olderThanDays: number;
}

interface OrphanSweepDependencies {
  prisma: RetentionDatabase;
  uploadDirectory: string;
  frontendUrl: string;
  now?: () => Date;
}

export class OrphanSweep {
  private readonly now: () => Date;

  constructor(private readonly dependencies: OrphanSweepDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(options: OrphanSweepOptions): Promise<OrphanSweepResult> {
    const root = await realpath(this.dependencies.uploadDirectory);
    const cutoff = this.now().getTime() - options.olderThanDays * 86_400_000;
    const initialSnapshot = await discoverHolders(this.dependencies.prisma);
    const livePaths = holderLivePaths(
      initialSnapshot,
      this.dependencies.frontendUrl,
      root
    );
    const candidates: Array<{
      path: string;
      size: number;
      mtimeMs: number;
      dev: number;
      ino: number;
    }> = [];

    const walk = async (directory: string, isRoot: boolean): Promise<void> => {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (isRoot && entry.name === '.retention') continue;
        const filePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(filePath, false);
          continue;
        }
        if (!entry.isFile() || livePaths.has(filePath)) continue;
        const stat = await lstat(filePath);
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          stat.mtimeMs > cutoff
        ) {
          continue;
        }
        candidates.push({
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
        });
      }
    };
    await walk(root, true);
    candidates.sort((left, right) => left.path.localeCompare(right.path));

    const files: OrphanFileReport[] = [];
    const errors: string[] = [];
    let bytesFreed = 0;
    for (const candidate of candidates) {
      let deleted = false;
      if (options.mode === 'apply') {
        const snapshot = await discoverHolders(this.dependencies.prisma);
        const refreshedLivePaths = holderLivePaths(
          snapshot,
          this.dependencies.frontendUrl,
          root
        );
        const affectedMalformed = snapshot.malformed.find((holder) => {
          const publicPath = `/uploads/${relative(root, candidate.path)
            .split(sep)
            .join('/')}`;
          if (
            holder.raw.includes(publicPath) ||
            holder.raw.includes(basename(candidate.path))
          ) {
            return true;
          }
          for (const [mediaId, media] of snapshot.mediaById) {
            const mediaPath = expectedLocalUploadPath(
              media.path,
              this.dependencies.frontendUrl,
              root
            );
            if (mediaPath === candidate.path && holder.raw.includes(mediaId)) {
              return true;
            }
          }
          return false;
        });
        if (affectedMalformed) {
          errors.push(
            `${affectedMalformed.holder} ${affectedMalformed.rowId} is malformed; kept orphan candidate ${candidate.path}`
          );
        } else if (refreshedLivePaths.has(candidate.path)) {
          errors.push(`orphan candidate became live before deletion: ${candidate.path}`);
        } else {
          const current = await lstat(candidate.path);
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== candidate.dev ||
            current.ino !== candidate.ino ||
            current.size !== candidate.size ||
            current.mtimeMs !== candidate.mtimeMs
          ) {
            errors.push(`orphan candidate changed before deletion: ${candidate.path}`);
          } else {
            await unlink(candidate.path);
            deleted = true;
            bytesFreed += candidate.size;
          }
        }
      }
      files.push({ path: candidate.path, bytes: candidate.size, deleted });
    }

    return { files, bytesFreed, errors };
  }
}

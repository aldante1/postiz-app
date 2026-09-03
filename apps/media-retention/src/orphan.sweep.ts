import { MediaRetentionState } from '@prisma/client';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  collectScalarMediaReferences,
  normalizeMediaReference,
  parseMediaReferences,
} from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';
import {
  FileIdentity,
  inspectContainedFile,
  quarantineAndUnlink,
} from './preview.writer';

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
  retentionState: MediaRetentionState;
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
  if (!parsed.valid) malformed.push({ holder, rowId });
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
    if (row.retentionState !== MediaRetentionState.PURGED) {
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
    const candidates: FileIdentity[] = [];

    const walk = async (directory: string, isRoot: boolean): Promise<void> => {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (isRoot && entry.name === '.retention') continue;
        const filePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          const stat = await lstat(filePath);
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          const canonical = await realpath(filePath);
          const fromRoot = relative(root, canonical);
          if (
            canonical !== filePath ||
            fromRoot === '..' ||
            fromRoot.startsWith(`..${sep}`) ||
            isAbsolute(fromRoot)
          ) {
            continue;
          }
          await walk(canonical, false);
          continue;
        }
        if (!entry.isFile() || livePaths.has(filePath)) continue;
        try {
          const candidate = await inspectContainedFile(root, filePath);
          if (candidate.mtimeMs <= cutoff) candidates.push(candidate);
        } catch {
          // Symlinks and entries changed while traversing are never candidates.
        }
      }
    };
    await walk(root, true);
    candidates.sort((left, right) => left.path.localeCompare(right.path));

    const files: OrphanFileReport[] = [];
    const errorSet = new Set<string>();
    const reportMalformed = (snapshot: HolderSnapshot): void => {
      for (const malformed of snapshot.malformed) {
        errorSet.add(
          `${malformed.holder} ${malformed.rowId} is malformed; orphan mutation disabled`
        );
      }
    };
    reportMalformed(initialSnapshot);
    let bytesFreed = 0;
    for (const candidate of candidates) {
      let deleted = false;
      if (options.mode === 'apply') {
        const snapshot = await discoverHolders(this.dependencies.prisma);
        reportMalformed(snapshot);
        const refreshedLivePaths = holderLivePaths(
          snapshot,
          this.dependencies.frontendUrl,
          root
        );
        if (snapshot.malformed.length > 0) {
          // Any unparseable holder may hide any Media reference.
        } else if (refreshedLivePaths.has(candidate.path)) {
          errorSet.add(
            `orphan candidate became live before deletion: ${candidate.path}`
          );
        } else {
          try {
            const freed = await quarantineAndUnlink(root, candidate);
            deleted = true;
            bytesFreed += freed;
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : 'unknown filesystem error';
            errorSet.add(
              `unsafe orphan candidate kept before deletion: ${candidate.path}: ${message}`
            );
          }
        }
      }
      files.push({ path: candidate.path, bytes: candidate.size, deleted });
    }

    return { files, bytesFreed, errors: [...errorSet] };
  }
}

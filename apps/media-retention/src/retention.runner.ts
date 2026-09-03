import { MediaRetentionState } from '@prisma/client';
import { lstat } from 'node:fs/promises';
import {
  normalizeMediaReference,
  parseMediaReferences,
  recoveryAction,
  replaceMediaReference,
  toLocalUploadPath,
} from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';
import {
  discoverHolders,
  expectedLocalUploadPath,
  holderMatchesMedia,
  MediaRow,
  OrphanSweep,
  OrphanSweepResult,
  PublishedPostReference,
  RetentionDatabase,
  RetentionTransactionDatabase,
} from './orphan.sweep';
import {
  FileIdentity,
  PreparedPreview,
  PreviewResult,
  quarantineAndUnlink,
  sameFileIdentity,
} from './preview.writer';

export interface RetentionOptions {
  mode: 'dry-run' | 'apply';
  orphanMode: 'off' | 'report' | 'apply';
  olderThanDays: number;
  organizationId?: string;
}

export interface RetentionResult {
  candidates: number;
  skipped: number;
  staged: number;
  purged: number;
  bytesFreed: number;
  errors: string[];
}

interface PreviewWriterLike {
  location(media: MediaRow, sourcePath: string): Promise<PreviewResult>;
  prepare(media: MediaRow, sourcePath: string): Promise<PreparedPreview>;
  publish(prepared: PreparedPreview): Promise<PreviewResult>;
  discard(prepared: PreparedPreview): Promise<void>;
}

interface RetentionRunnerDependencies {
  prisma: RetentionDatabase;
  previewWriter: PreviewWriterLike;
  uploadDirectory: string;
  frontendUrl: string;
  now?: () => Date;
  orphanSweep?: OrphanSweep;
}

interface FileState extends FileIdentity {
  exists: boolean;
}

interface CandidatePreflight {
  source: FileState;
  expectedPreview: PreviewResult;
  preview: FileState;
  prepared: PreparedPreview | null;
}

interface PostUpdate {
  id: string;
  data: Record<string, string>;
}

function missingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function inspectLocalFile(
  publicUrl: string,
  frontendUrl: string,
  uploadDirectory: string
): Promise<FileState | null> {
  const expectedPath = expectedLocalUploadPath(
    publicUrl,
    frontendUrl,
    uploadDirectory
  );
  if (!expectedPath) return null;
  try {
    const stat = await lstat(expectedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const canonical = toLocalUploadPath(publicUrl, frontendUrl, uploadDirectory);
    if (!canonical) return null;
    return {
      exists: true,
      path: canonical,
      size: stat.size,
      device: stat.dev,
      inode: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error: unknown) {
    if (missingFile(error)) {
      return {
        exists: false,
        path: expectedPath,
        size: 0,
        device: 0,
        inode: 0,
        mtimeMs: 0,
      };
    }
    throw error;
  }
}

function preparePublishedUpdates(
  posts: PublishedPostReference[],
  candidate: MediaRow,
  previewUrl: string
): PostUpdate[] {
  const originalReference = normalizeMediaReference(candidate.path);
  const updates: PostUpdate[] = [];
  for (const post of posts) {
    const data: Record<string, string> = {};
    for (const field of ['image', 'settings'] as const) {
      const raw = post[field];
      if (!raw) continue;
      const parsed = parseMediaReferences(raw);
      if (!parsed.valid) {
        throw new Error(`${field} became malformed`);
      }
      const hasOriginal = parsed.references.has(originalReference);
      const hasMediaId = parsed.references.has(candidate.id);
      if (hasOriginal && !hasMediaId) {
        throw new Error('original path is not attached to a matching Media id');
      }
      if (!hasMediaId) continue;
      const rewritten = replaceMediaReference(raw, candidate.id, previewUrl);
      const verified = parseMediaReferences(rewritten);
      if (!verified.valid || verified.references.has(originalReference)) {
        throw new Error('unrewritten original path remains after candidate rewrite');
      }
      if (rewritten !== raw) data[field] = rewritten;
    }
    if (Object.keys(data).length > 0) updates.push({ id: post.id, data });
  }
  return updates;
}

export class RetentionRunner {
  private readonly now: () => Date;
  private readonly orphanSweep: OrphanSweep;
  orphanReport: OrphanSweepResult | null = null;

  constructor(private readonly dependencies: RetentionRunnerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.orphanSweep =
      dependencies.orphanSweep ??
      new OrphanSweep({
        prisma: dependencies.prisma,
        uploadDirectory: dependencies.uploadDirectory,
        frontendUrl: dependencies.frontendUrl,
        now: this.now,
      });
  }

  private previewLocation(
    candidate: MediaRow,
    sourcePath: string
  ): Promise<PreviewResult> {
    if (
      candidate.retentionState === MediaRetentionState.STAGED &&
      candidate.archivePreviewPath
    ) {
      const stored = candidate.archivePreviewPath;
      const location = new URL(stored);
      const jpgPath = `/uploads/.retention/${candidate.id}.jpg`;
      const webpPath = `/uploads/.retention/${candidate.id}.webp`;
      const kind =
        location.pathname === jpgPath
          ? 'jpg'
          : location.pathname === webpPath
          ? 'webp'
          : null;
      const filePath = expectedLocalUploadPath(
        stored,
        this.dependencies.frontendUrl,
        this.dependencies.uploadDirectory
      );
      if (!kind || !filePath) {
        return Promise.reject(
          new Error(`media ${candidate.id} has an unsafe stored preview`)
        );
      }
      return Promise.resolve({ publicUrl: stored, filePath, kind });
    }
    return this.dependencies.previewWriter.location(candidate, sourcePath);
  }

  private async preflight(
    candidate: MediaRow,
    preparePreview: boolean
  ): Promise<CandidatePreflight | null> {
    const source = await inspectLocalFile(
      candidate.path,
      this.dependencies.frontendUrl,
      this.dependencies.uploadDirectory
    );
    if (!source) return null;
    const expectedPreview = await this.previewLocation(candidate, source.path);
    const preview = await inspectLocalFile(
      expectedPreview.publicUrl,
      this.dependencies.frontendUrl,
      this.dependencies.uploadDirectory
    );
    if (!preview) return null;
    const action = recoveryAction({
      previewExists: preview.exists,
      originalExists: source.exists,
    });
    let prepared: PreparedPreview | null = null;
    if (preparePreview && action === 'regenerate') {
      prepared = await this.dependencies.previewWriter.prepare(
        candidate,
        source.path
      );
    }
    return { source, expectedPreview, preview, prepared };
  }

  private async processCandidate(
    candidate: MediaRow,
    apply: boolean,
    result: RetentionResult,
    prisma: RetentionTransactionDatabase,
    preflight: CandidatePreflight
  ): Promise<void> {
    const source = await inspectLocalFile(
      candidate.path,
      this.dependencies.frontendUrl,
      this.dependencies.uploadDirectory
    );
    if (!source) {
      result.skipped += 1;
      return;
    }
    if (
      apply &&
      (source.exists !== preflight.source.exists ||
        (source.exists && !sameFileIdentity(source, preflight.source)))
    ) {
      result.errors.push(`media ${candidate.id} original changed before lock`);
      result.skipped += 1;
      return;
    }

    const expectedPreview = await this.previewLocation(candidate, source.path);
    if (
      expectedPreview.filePath !== preflight.expectedPreview.filePath ||
      expectedPreview.publicUrl !== preflight.expectedPreview.publicUrl
    ) {
      result.errors.push(`media ${candidate.id} preview location changed before lock`);
      result.skipped += 1;
      return;
    }
    const preview = await inspectLocalFile(
      expectedPreview.publicUrl,
      this.dependencies.frontendUrl,
      this.dependencies.uploadDirectory
    );
    if (!preview) {
      result.errors.push(`media ${candidate.id} has an unsafe preview location`);
      result.skipped += 1;
      return;
    }

    const holders = await discoverHolders(prisma);
    if (holders.malformed.length > 0) {
      const malformed = holders.malformed[0];
      result.errors.push(
        `${malformed.holder} ${malformed.rowId} is malformed; media ${candidate.id} was not mutated`
      );
      result.skipped += 1;
      return;
    }
    if (
      holderMatchesMedia(holders.blockingReferences, candidate) ||
      holders.mediaFieldReferences.some(
        (holder) =>
          holder.mediaId !== candidate.id &&
          holderMatchesMedia(holder.references, candidate)
      )
    ) {
      result.skipped += 1;
      return;
    }

    let postUpdates: PostUpdate[];
    try {
      postUpdates = preparePublishedUpdates(
        holders.publishedPosts,
        candidate,
        expectedPreview.publicUrl
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'invalid published holder';
      result.errors.push(`media ${candidate.id}: ${message}`);
      result.skipped += 1;
      return;
    }

    const action = recoveryAction({
      previewExists: preview.exists,
      originalExists: source.exists,
    });
    if (action === 'error') {
      const message = `media ${candidate.id}: preview missing and original missing`;
      if (apply) throw new Error(message);
      result.errors.push(message);
      result.skipped += 1;
      return;
    }
    if (!apply) return;

    let previewResult = expectedPreview;
    if (action === 'regenerate') {
      if (!preflight.prepared) {
        result.errors.push(
          `media ${candidate.id}: preview disappeared before lock; retry required`
        );
        result.skipped += 1;
        return;
      }
      previewResult = await this.dependencies.previewWriter.publish(
        preflight.prepared
      );
      preflight.prepared = null;
    }

    for (const update of postUpdates) {
      await prisma.post.update({
        where: { id: update.id },
        data: update.data,
      });
    }
    if (candidate.retentionState === MediaRetentionState.ACTIVE) {
      await prisma.media.update({
        where: { id: candidate.id, retentionState: MediaRetentionState.ACTIVE },
        data: {
          retentionState: MediaRetentionState.STAGED,
          archivePreviewPath: previewResult.publicUrl,
        },
      });
      result.staged += 1;
    } else if (candidate.archivePreviewPath !== previewResult.publicUrl) {
      await prisma.media.update({
        where: { id: candidate.id, retentionState: MediaRetentionState.STAGED },
        data: { archivePreviewPath: previewResult.publicUrl },
      });
    }

    const refreshed = await discoverHolders(prisma);
    const originalReference = normalizeMediaReference(candidate.path);
    const pathStillLive = refreshed.publishedPosts.some((post) =>
      post.references.has(originalReference)
    );
    const blockingReference =
      holderMatchesMedia(refreshed.blockingReferences, candidate) ||
      refreshed.mediaFieldReferences.some(
        (holder) =>
          holder.mediaId !== candidate.id &&
          holderMatchesMedia(holder.references, candidate)
      );
    if (
      refreshed.malformed.length > 0 ||
      pathStillLive ||
      blockingReference
    ) {
      if (refreshed.malformed.length > 0) {
        const malformed = refreshed.malformed[0];
        result.errors.push(
          `${malformed.holder} ${malformed.rowId} became malformed before purge of media ${candidate.id}`
        );
      }
      result.skipped += 1;
      return;
    }

    if (source.exists) {
      try {
        const freed = await quarantineAndUnlink(
          this.dependencies.uploadDirectory,
          source
        );
        result.bytesFreed += freed;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'unknown filesystem error';
        result.errors.push(
          `media ${candidate.id} original changed before unlink: ${message}`
        );
        result.skipped += 1;
        return;
      }
    }
    await prisma.media.update({
      where: { id: candidate.id, retentionState: MediaRetentionState.STAGED },
      data: {
        retentionState: MediaRetentionState.PURGED,
        originalPurgedAt: this.now(),
      },
    });
    result.purged += 1;
  }

  async run(options: RetentionOptions): Promise<RetentionResult> {
    if (options.mode !== 'apply' && options.orphanMode === 'apply') {
      throw new Error('orphan apply requires retention apply');
    }
    const result: RetentionResult = {
      candidates: 0,
      skipped: 0,
      staged: 0,
      purged: 0,
      bytesFreed: 0,
      errors: [],
    };
    const cutoff = new Date(
      this.now().getTime() - options.olderThanDays * 86_400_000
    );
    let cursor: Pick<MediaRow, 'createdAt' | 'id'> | null = null;

    while (true) {
      const cursorFilter = cursor
        ? {
            OR: [
              { createdAt: { gt: cursor.createdAt } },
              {
                createdAt: { equals: cursor.createdAt },
                id: { gt: cursor.id },
              },
            ],
          }
        : {};
      const candidate = await this.dependencies.prisma.media.findFirst({
        where: {
          retentionState: {
            in: [MediaRetentionState.ACTIVE, MediaRetentionState.STAGED],
          },
          createdAt: { lte: cutoff },
          ...(options.organizationId
            ? { organizationId: options.organizationId }
            : {}),
          ...cursorFilter,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
      });
      if (!candidate) break;
      cursor = { createdAt: candidate.createdAt, id: candidate.id };
      result.candidates += 1;

      const preflight = await this.preflight(candidate, false);
      if (!preflight) {
        result.skipped += 1;
        continue;
      }
      const preliminaryHolders = await discoverHolders(
        this.dependencies.prisma
      );
      if (preliminaryHolders.malformed.length > 0) {
        const malformed = preliminaryHolders.malformed[0];
        result.errors.push(
          `${malformed.holder} ${malformed.rowId} is malformed; media ${candidate.id} was not mutated`
        );
        result.skipped += 1;
        continue;
      }
      if (
        holderMatchesMedia(preliminaryHolders.blockingReferences, candidate) ||
        preliminaryHolders.mediaFieldReferences.some(
          (holder) =>
            holder.mediaId !== candidate.id &&
            holderMatchesMedia(holder.references, candidate)
        )
      ) {
        result.skipped += 1;
        continue;
      }
      try {
        preparePublishedUpdates(
          preliminaryHolders.publishedPosts,
          candidate,
          preflight.expectedPreview.publicUrl
        );
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'invalid published holder';
        result.errors.push(`media ${candidate.id}: ${message}`);
        result.skipped += 1;
        continue;
      }
      if (
        options.mode === 'apply' &&
        recoveryAction({
          previewExists: preflight.preview.exists,
          originalExists: preflight.source.exists,
        }) === 'regenerate'
      ) {
        preflight.prepared = await this.dependencies.previewWriter.prepare(
          candidate,
          preflight.source.path
        );
      }

      if (options.mode === 'dry-run') {
        await this.processCandidate(
          candidate,
          false,
          result,
          this.dependencies.prisma,
          preflight
        );
        continue;
      }

      try {
        await this.dependencies.prisma.$transaction(
          async (transaction) => {
            await transaction.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "Media"
              WHERE "id" = ${candidate.id}
              FOR UPDATE
            `;
            const locked = await transaction.media.findFirst({
              where: { id: candidate.id },
            });
            if (
              !locked ||
              (locked.retentionState !== MediaRetentionState.ACTIVE &&
                locked.retentionState !== MediaRetentionState.STAGED) ||
              locked.createdAt > cutoff ||
              (options.organizationId &&
                locked.organizationId !== options.organizationId)
            ) {
              result.skipped += 1;
              return;
            }
            await this.processCandidate(
              locked,
              true,
              result,
              transaction,
              preflight
            );
          },
          { maxWait: 5_000, timeout: 15_000 }
        );
      } finally {
        if (preflight.prepared) {
          await this.dependencies.previewWriter.discard(preflight.prepared);
        }
      }
    }

    if (options.orphanMode !== 'off') {
      this.orphanReport = await this.orphanSweep.run({
        mode: options.orphanMode,
        olderThanDays: options.olderThanDays,
      });
      result.candidates += this.orphanReport.files.length;
      result.purged += this.orphanReport.files.filter((file) => file.deleted).length;
      result.bytesFreed += this.orphanReport.bytesFreed;
      result.errors.push(...this.orphanReport.errors);
    }

    return result;
  }
}

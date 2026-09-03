import { lstat, unlink } from 'node:fs/promises';
import {
  normalizeMediaReference,
  recoveryAction,
  replaceMediaReference,
  toLocalUploadPath,
} from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';
import {
  discoverHolders,
  expectedLocalUploadPath,
  holderMatchesMedia,
  malformedHolderMatches,
  MediaRow,
  OrphanSweep,
  OrphanSweepResult,
  RetentionDatabase,
  RetentionTransactionDatabase,
} from './orphan.sweep';
import { PreviewResult, previewLocation } from './preview.writer';

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
  write(media: MediaRow, sourcePath: string): Promise<PreviewResult>;
}

interface RetentionRunnerDependencies {
  prisma: RetentionDatabase;
  previewWriter: PreviewWriterLike;
  uploadDirectory: string;
  frontendUrl: string;
  now?: () => Date;
  orphanSweep?: OrphanSweep;
}

interface FileState {
  exists: boolean;
  path: string;
  size: number;
  device: number;
  inode: number;
  mtimeMs: number;
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
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
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

  private async processCandidate(
    candidate: MediaRow,
    apply: boolean,
    result: RetentionResult,
    prisma: RetentionTransactionDatabase
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
    const expectedPreview = previewLocation(candidate, this.dependencies);
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
    const malformed = holders.malformed.find((holder) =>
      malformedHolderMatches(holder, candidate)
    );
    if (malformed) {
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

    const originalReference = normalizeMediaReference(candidate.path);
    const unrewritablePublishedReference = holders.publishedPosts.some(
      (post) =>
        post.references.has(originalReference) &&
        !post.references.has(candidate.id)
    );
    if (unrewritablePublishedReference) {
      result.errors.push(
        `published holder references media ${candidate.id} by path without its id`
      );
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
      previewResult = await this.dependencies.previewWriter.write(
        candidate,
        source.path
      );
    }

    if (candidate.retentionState === 'ACTIVE') {
      for (const post of holders.publishedPosts) {
        if (!post.references.has(candidate.id)) continue;
        const data: Record<string, string> = {};
        if (post.image) {
          data.image = replaceMediaReference(
            post.image,
            candidate.id,
            previewResult.publicUrl
          );
        }
        if (post.settings) {
          data.settings = replaceMediaReference(
            post.settings,
            candidate.id,
            previewResult.publicUrl
          );
        }
        if (Object.keys(data).length > 0) {
          await prisma.post.update({
            where: { id: post.id },
            data,
          });
        }
      }
      await prisma.media.update({
        where: { id: candidate.id, retentionState: 'ACTIVE' },
        data: {
          retentionState: 'STAGED',
          archivePreviewPath: previewResult.publicUrl,
        },
      });
      result.staged += 1;
    } else if (candidate.archivePreviewPath !== previewResult.publicUrl) {
      await prisma.media.update({
        where: { id: candidate.id, retentionState: 'STAGED' },
        data: { archivePreviewPath: previewResult.publicUrl },
      });
    }

    const refreshed = await discoverHolders(prisma);
    const refreshedMalformed = refreshed.malformed.find((holder) =>
      malformedHolderMatches(holder, candidate)
    );
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
    if (refreshedMalformed || pathStillLive || blockingReference) {
      if (refreshedMalformed) {
        result.errors.push(
          `${refreshedMalformed.holder} ${refreshedMalformed.rowId} became malformed before purge of media ${candidate.id}`
        );
      }
      result.skipped += 1;
      return;
    }

    if (source.exists) {
      const finalSource = await inspectLocalFile(
        candidate.path,
        this.dependencies.frontendUrl,
        this.dependencies.uploadDirectory
      );
      if (
        !finalSource?.exists ||
        finalSource.path !== source.path ||
        finalSource.device !== source.device ||
        finalSource.inode !== source.inode ||
        finalSource.size !== source.size ||
        finalSource.mtimeMs !== source.mtimeMs
      ) {
        result.errors.push(`media ${candidate.id} original changed before unlink`);
        result.skipped += 1;
        return;
      }
      await unlink(source.path);
      result.bytesFreed += source.size;
    }
    await prisma.media.update({
      where: { id: candidate.id, retentionState: 'STAGED' },
      data: { retentionState: 'PURGED', originalPurgedAt: this.now() },
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
          retentionState: { in: ['ACTIVE', 'STAGED'] },
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

      if (options.mode === 'dry-run') {
        await this.processCandidate(
          candidate,
          false,
          result,
          this.dependencies.prisma
        );
        continue;
      }

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
            (locked.retentionState !== 'ACTIVE' &&
              locked.retentionState !== 'STAGED')
          ) {
            result.skipped += 1;
            return;
          }
          await this.processCandidate(locked, true, result, transaction);
        },
        { maxWait: 5_000, timeout: 30_000 }
      );
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


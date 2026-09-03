import { MediaRetentionState } from '@prisma/client';
import { lstat, realpath } from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
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
  HolderSnapshot,
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

export type RetentionCandidateDecision =
  | 'pending'
  | 'skip'
  | 'error'
  | 'would-purge'
  | 'would-finalize'
  | 'would-regenerate-and-purge'
  | 'staged'
  | 'restored-active'
  | 'purged';

export interface RetentionCandidateEvidence {
  mediaId: string;
  originalBytes: number;
  projectedBytesFreed: number;
  preview: PreviewResult | null;
  decision: RetentionCandidateDecision;
  skipReason?: string;
  errors: string[];
}

export interface RetentionResult {
  candidates: number;
  skipped: number;
  staged: number;
  purged: number;
  bytesFreed: number;
  projectedBytesFreed: number;
  errors: string[];
  candidateEvidence: RetentionCandidateEvidence[];
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

interface HolderValidation {
  snapshot: HolderSnapshot;
  postUpdates: PostUpdate[];
  blocker?: string;
  error?: string;
}

type StageOutcome =
  | { status: 'ready'; candidate: MediaRow; source: FileState; staged: boolean }
  | { status: 'skip'; reason: string }
  | { status: 'error'; error: string };

type FinalCheckOutcome =
  | { status: 'ready'; candidate: MediaRow }
  | { status: 'restored'; reason: string; error?: string }
  | { status: 'skip'; reason: string };

function missingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
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
      if (!parsed.valid) throw new Error(`${field} became malformed`);
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

function candidateIsBlocked(
  snapshot: HolderSnapshot,
  candidate: MediaRow
): boolean {
  return (
    holderMatchesMedia(snapshot.blockingReferences, candidate) ||
    snapshot.mediaFieldReferences.some(
      (holder) =>
        holder.mediaId !== candidate.id &&
        holderMatchesMedia(holder.references, candidate)
    )
  );
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

  private newEvidence(mediaId: string): RetentionCandidateEvidence {
    return {
      mediaId,
      originalBytes: 0,
      projectedBytesFreed: 0,
      preview: null,
      decision: 'pending',
      errors: [],
    };
  }

  private recordError(
    result: RetentionResult,
    evidence: RetentionCandidateEvidence,
    error: string
  ): void {
    result.errors.push(error);
    result.skipped += 1;
    evidence.errors.push(error);
    evidence.decision = 'error';
    evidence.skipReason = error;
  }

  private recordSkip(
    result: RetentionResult,
    evidence: RetentionCandidateEvidence,
    reason: string
  ): void {
    result.skipped += 1;
    evidence.decision = 'skip';
    evidence.skipReason = reason;
  }

  private async previewLocation(
    candidate: MediaRow,
    sourcePath: string
  ): Promise<PreviewResult> {
    if (
      candidate.retentionState === MediaRetentionState.STAGED &&
      candidate.archivePreviewPath
    ) {
      const stored = candidate.archivePreviewPath;
      let location: URL;
      try {
        location = new URL(stored);
      } catch {
        throw new Error(`media ${candidate.id} has an unsafe stored preview`);
      }
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
        throw new Error(`media ${candidate.id} has an unsafe stored preview`);
      }
      return { publicUrl: stored, filePath, kind };
    }
    return this.dependencies.previewWriter.location(candidate, sourcePath);
  }

  private async comparablePath(filePath: string): Promise<string> {
    const logicalRoot = resolve(this.dependencies.uploadDirectory);
    const canonicalRoot = await realpath(logicalRoot);
    const absolute = resolve(filePath);
    if (isInside(logicalRoot, absolute)) {
      return join(canonicalRoot, relative(logicalRoot, absolute));
    }
    return absolute;
  }

  private async preparedMatchesExpected(
    prepared: PreparedPreview,
    expected: PreviewResult
  ): Promise<boolean> {
    return (
      prepared.result.publicUrl === expected.publicUrl &&
      prepared.result.kind === expected.kind &&
      (await this.comparablePath(prepared.result.filePath)) ===
        (await this.comparablePath(expected.filePath))
    );
  }

  private async preflight(candidate: MediaRow): Promise<CandidatePreflight | null> {
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
    if (!preview) {
      throw new Error(`media ${candidate.id} has an unsafe stored preview`);
    }
    return { source, expectedPreview, preview, prepared: null };
  }

  private async validateHolders(
    prisma: RetentionTransactionDatabase,
    candidate: MediaRow,
    previewUrl: string
  ): Promise<HolderValidation> {
    const snapshot = await discoverHolders(prisma);
    if (snapshot.malformed.length > 0) {
      const malformed = snapshot.malformed[0];
      return {
        snapshot,
        postUpdates: [],
        error: `${malformed.holder} ${malformed.rowId} is malformed`,
      };
    }
    if (candidateIsBlocked(snapshot, candidate)) {
      return {
        snapshot,
        postUpdates: [],
        blocker: `media ${candidate.id} has a live blocking holder`,
      };
    }
    try {
      return {
        snapshot,
        postUpdates: preparePublishedUpdates(
          snapshot.publishedPosts,
          candidate,
          previewUrl
        ),
      };
    } catch (error: unknown) {
      return {
        snapshot,
        postUpdates: [],
        error: `media ${candidate.id}: ${
          error instanceof Error ? error.message : 'invalid published holder'
        }`,
      };
    }
  }

  private async lockMedia(
    prisma: RetentionTransactionDatabase,
    mediaId: string
  ): Promise<MediaRow | null> {
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Media"
      WHERE "id" = ${mediaId}
      FOR UPDATE
    `;
    return prisma.media.findFirst({ where: { id: mediaId } });
  }

  private async stageCandidate(
    transaction: RetentionTransactionDatabase,
    selected: MediaRow,
    cutoff: Date,
    organizationId: string | undefined,
    preflight: CandidatePreflight
  ): Promise<StageOutcome> {
    const candidate = await this.lockMedia(transaction, selected.id);
    if (
      !candidate ||
      (candidate.retentionState !== MediaRetentionState.ACTIVE &&
        candidate.retentionState !== MediaRetentionState.STAGED) ||
      candidate.createdAt > cutoff ||
      (organizationId && candidate.organizationId !== organizationId)
    ) {
      return { status: 'skip', reason: `media ${selected.id} is no longer eligible` };
    }

    const source = await inspectLocalFile(
      candidate.path,
      this.dependencies.frontendUrl,
      this.dependencies.uploadDirectory
    );
    if (!source) {
      return { status: 'skip', reason: `media ${candidate.id} original is unsafe` };
    }
    if (
      source.exists !== preflight.source.exists ||
      (source.exists && !sameFileIdentity(source, preflight.source))
    ) {
      return { status: 'error', error: `media ${candidate.id} original changed before lock` };
    }

    const expectedPreview = await this.previewLocation(candidate, source.path);
    if (
      expectedPreview.publicUrl !== preflight.expectedPreview.publicUrl ||
      (await this.comparablePath(expectedPreview.filePath)) !==
        (await this.comparablePath(preflight.expectedPreview.filePath))
    ) {
      return {
        status: 'error',
        error: `media ${candidate.id} preview location changed before lock`,
      };
    }
    const preview = await inspectLocalFile(
      expectedPreview.publicUrl,
      this.dependencies.frontendUrl,
      this.dependencies.uploadDirectory
    );
    if (!preview) {
      return { status: 'error', error: `media ${candidate.id} has an unsafe preview location` };
    }

    const validation = await this.validateHolders(
      transaction,
      candidate,
      expectedPreview.publicUrl
    );
    if (validation.error) return { status: 'error', error: validation.error };
    if (validation.blocker) return { status: 'skip', reason: validation.blocker };

    const action = recoveryAction({
      previewExists: preview.exists,
      originalExists: source.exists,
    });
    if (action === 'error') {
      return {
        status: 'error',
        error: `media ${candidate.id}: preview missing and original missing`,
      };
    }
    if (action === 'regenerate') {
      if (!preflight.prepared) {
        return {
          status: 'error',
          error: `media ${candidate.id}: preview disappeared before lock; retry required`,
        };
      }
      if (!(await this.preparedMatchesExpected(preflight.prepared, expectedPreview))) {
        return {
          status: 'error',
          error: `media ${candidate.id} regenerated preview does not match stored preview`,
        };
      }
      await this.dependencies.previewWriter.publish(preflight.prepared);
      preflight.prepared = null;
    }

    for (const update of validation.postUpdates) {
      await transaction.post.update({
        where: { id: update.id },
        data: update.data,
      });
    }
    const staged = candidate.retentionState === MediaRetentionState.ACTIVE;
    if (staged) {
      await transaction.media.update({
        where: { id: candidate.id, retentionState: MediaRetentionState.ACTIVE },
        data: {
          retentionState: MediaRetentionState.STAGED,
          archivePreviewPath: expectedPreview.publicUrl,
        },
      });
    } else if (candidate.archivePreviewPath !== expectedPreview.publicUrl) {
      await transaction.media.update({
        where: { id: candidate.id, retentionState: MediaRetentionState.STAGED },
        data: { archivePreviewPath: expectedPreview.publicUrl },
      });
    }
    return { status: 'ready', candidate, source, staged };
  }

  private async finalHolderCheck(
    transaction: RetentionTransactionDatabase,
    mediaId: string
  ): Promise<FinalCheckOutcome> {
    const candidate = await this.lockMedia(transaction, mediaId);
    if (!candidate || candidate.retentionState !== MediaRetentionState.STAGED) {
      return { status: 'skip', reason: `media ${mediaId} is no longer STAGED` };
    }
    const snapshot = await discoverHolders(transaction);
    const originalReference = normalizeMediaReference(candidate.path);
    const malformed = snapshot.malformed[0];
    const pathStillLive = snapshot.publishedPosts.some((post) =>
      post.references.has(originalReference)
    );
    const blocked = candidateIsBlocked(snapshot, candidate);
    if (malformed || pathStillLive || blocked) {
      await transaction.media.update({
        where: { id: candidate.id, retentionState: MediaRetentionState.STAGED },
        data: { retentionState: MediaRetentionState.ACTIVE },
      });
      const reason = malformed
        ? `${malformed.holder} ${malformed.rowId} became malformed after staging`
        : pathStillLive
        ? `media ${candidate.id} original path became live after staging`
        : `media ${candidate.id} gained a blocking holder after staging`;
      return {
        status: 'restored',
        reason,
        ...(malformed ? { error: reason } : {}),
      };
    }
    return { status: 'ready', candidate };
  }

  private async finalizePurged(
    transaction: RetentionTransactionDatabase,
    mediaId: string
  ): Promise<boolean> {
    const candidate = await this.lockMedia(transaction, mediaId);
    if (!candidate || candidate.retentionState !== MediaRetentionState.STAGED) {
      return false;
    }
    await transaction.media.update({
      where: { id: candidate.id, retentionState: MediaRetentionState.STAGED },
      data: {
        retentionState: MediaRetentionState.PURGED,
        originalPurgedAt: this.now(),
      },
    });
    return true;
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
      projectedBytesFreed: 0,
      errors: [],
      candidateEvidence: [],
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
      const selected = await this.dependencies.prisma.media.findFirst({
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
      if (!selected) break;
      cursor = { createdAt: selected.createdAt, id: selected.id };
      result.candidates += 1;
      const evidence = this.newEvidence(selected.id);
      result.candidateEvidence.push(evidence);

      let preflight: CandidatePreflight;
      try {
        const inspected = await this.preflight(selected);
        if (!inspected) {
          this.recordSkip(result, evidence, 'original is external or unsafe');
          continue;
        }
        preflight = inspected;
      } catch (error: unknown) {
        this.recordError(
          result,
          evidence,
          error instanceof Error ? error.message : `media ${selected.id} preflight failed`
        );
        continue;
      }
      evidence.originalBytes = preflight.source.size;
      evidence.preview = preflight.expectedPreview;
      const initialAction = recoveryAction({
        previewExists: preflight.preview.exists,
        originalExists: preflight.source.exists,
      });

      const preliminary = await this.validateHolders(
        this.dependencies.prisma,
        selected,
        preflight.expectedPreview.publicUrl
      );
      if (preliminary.error) {
        this.recordError(result, evidence, preliminary.error);
        continue;
      }
      if (preliminary.blocker) {
        this.recordSkip(result, evidence, preliminary.blocker);
        continue;
      }
      if (initialAction === 'error') {
        this.recordError(
          result,
          evidence,
          `media ${selected.id}: preview missing and original missing`
        );
        continue;
      }

      evidence.projectedBytesFreed = preflight.source.exists
        ? preflight.source.size
        : 0;

      if (options.mode === 'dry-run') {
        result.projectedBytesFreed += evidence.projectedBytesFreed;
        evidence.decision =
          initialAction === 'regenerate'
            ? 'would-regenerate-and-purge'
            : initialAction === 'finalize'
            ? 'would-finalize'
            : 'would-purge';
        continue;
      }

      if (initialAction === 'regenerate') {
        preflight.prepared = await this.dependencies.previewWriter.prepare(
          selected,
          preflight.source.path
        );
      }

      try {
        const stage = await this.dependencies.prisma.$transaction(
          (transaction) =>
            this.stageCandidate(
              transaction,
              selected,
              cutoff,
              options.organizationId,
              preflight
            ),
          { maxWait: 5_000, timeout: 15_000 }
        );
        if (stage.status === 'error') {
          this.recordError(result, evidence, stage.error);
          continue;
        }
        if (stage.status === 'skip') {
          this.recordSkip(result, evidence, stage.reason);
          continue;
        }
        if (stage.staged) result.staged += 1;
        evidence.decision = 'staged';

        const finalCheck = await this.dependencies.prisma.$transaction(
          (transaction) => this.finalHolderCheck(transaction, stage.candidate.id),
          { maxWait: 5_000, timeout: 15_000 }
        );
        if (finalCheck.status === 'restored') {
          result.skipped += 1;
          evidence.decision = 'restored-active';
          evidence.skipReason = finalCheck.reason;
          if (finalCheck.error) {
            result.errors.push(finalCheck.error);
            evidence.errors.push(finalCheck.error);
          }
          continue;
        }
        if (finalCheck.status === 'skip') {
          this.recordSkip(result, evidence, finalCheck.reason);
          continue;
        }

        if (stage.source.exists) {
          try {
            result.bytesFreed += await quarantineAndUnlink(
              this.dependencies.uploadDirectory,
              stage.source
            );
          } catch (error: unknown) {
            this.recordError(
              result,
              evidence,
              `media ${stage.candidate.id} original changed before unlink: ${
                error instanceof Error ? error.message : 'unknown filesystem error'
              }`
            );
            continue;
          }
        }

        const finalized = await this.dependencies.prisma.$transaction(
          (transaction) =>
            this.finalizePurged(transaction, stage.candidate.id),
          { maxWait: 5_000, timeout: 15_000 }
        );
        if (!finalized) {
          this.recordError(
            result,
            evidence,
            `media ${stage.candidate.id} could not finalize PURGED`
          );
          continue;
        }
        result.purged += 1;
        evidence.decision = 'purged';
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

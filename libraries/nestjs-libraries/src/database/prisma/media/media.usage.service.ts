import { BadRequestException, Injectable } from '@nestjs/common';
import { MediaRetentionState, Prisma, State } from '@prisma/client';
import type { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import {
  parseMediaReferences,
  replaceMediaReference,
} from './media.retention';

type PostWriteState = 'draft' | 'schedule' | 'now' | 'update';

type LockedMedia = {
  id: string;
  path: string;
  retentionState: MediaRetentionState;
  archivePreviewPath: string | null;
  deletedAt: Date | null;
};

function collectMediaIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMediaIds(entry, ids);
    }
    return ids;
  }

  if (typeof value !== 'object' || value === null) {
    return ids;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.id === 'string' &&
    (typeof record.path === 'string' || typeof record.url === 'string')
  ) {
    ids.add(record.id);
  }

  for (const entry of Object.values(record)) {
    collectMediaIds(entry, ids);
  }

  return ids;
}

function unavailable(): never {
  throw new BadRequestException('Media is unavailable');
}

@Injectable()
export class MediaUsageService {
  async lockAndCanonicalize(
    tx: Prisma.TransactionClient,
    orgId: string,
    state: PostWriteState,
    body: PostBody
  ): Promise<PostBody> {
    const imageIds = new Set(
      body.value.flatMap((value) => value.image.map((media) => media.id))
    );
    const settingsIds = collectMediaIds(body.settings);
    const mediaIds = [...new Set([...imageIds, ...settingsIds])].sort();

    if (!mediaIds.length) {
      return body;
    }

    const media = await tx.$queryRaw<LockedMedia[]>(Prisma.sql`
      SELECT
        "id",
        "path",
        "retentionState",
        "archivePreviewPath",
        "deletedAt"
      FROM "Media"
      WHERE "organizationId" = ${orgId}
        AND "id" IN (${Prisma.join(mediaIds)})
      ORDER BY "id"
      FOR SHARE
    `);
    const mediaById = new Map(media.map((item) => [item.id, item]));

    if (mediaById.size !== mediaIds.length) {
      unavailable();
    }

    const archived = media.filter(
      (item) => item.retentionState === MediaRetentionState.PURGED
    );

    for (const item of media) {
      if (
        item.deletedAt ||
        item.retentionState === MediaRetentionState.STAGED
      ) {
        unavailable();
      }
    }

    if (archived.length) {
      await this.assertArchivedReferencesAreUnchanged(
        tx,
        orgId,
        state,
        body,
        archived,
        settingsIds
      );
    }

    const canonicalPath = new Map(
      media.map((item) => [
        item.id,
        item.retentionState === MediaRetentionState.ACTIVE
          ? item.path
          : item.archivePreviewPath!,
      ])
    );

    let settings = body.settings;
    if (settingsIds.size) {
      let settingsJson = JSON.stringify(body.settings);
      for (const mediaId of settingsIds) {
        settingsJson = replaceMediaReference(
          settingsJson,
          mediaId,
          canonicalPath.get(mediaId)!
        );
      }
      // The value came from serializing the already validated settings DTO above.
      settings = JSON.parse(settingsJson) as unknown as PostBody['settings'];
    }

    return {
      ...body,
      settings,
      value: body.value.map((value) => ({
        ...value,
        image: value.image.map((item) => {
          const path = canonicalPath.get(item.id)!;
          return { ...item, path, url: path };
        }),
      })),
    };
  }

  private async assertArchivedReferencesAreUnchanged(
    tx: Prisma.TransactionClient,
    orgId: string,
    state: PostWriteState,
    body: PostBody,
    archived: LockedMedia[],
    settingsIds: Set<string>
  ): Promise<void> {
    if (state !== 'update' || body.value.some((value) => !value.id)) {
      unavailable();
    }

    const postIds = [...new Set(body.value.map((value) => value.id))].sort();
    const existingPosts = await tx.post.findMany({
      where: {
        organizationId: orgId,
        id: { in: postIds },
      },
      select: {
        id: true,
        state: true,
        image: true,
        settings: true,
        deletedAt: true,
      },
    });
    const existingById = new Map(
      existingPosts.map((post) => [post.id, post])
    );
    const incomingSettingsIds = [...settingsIds].sort();

    for (const value of body.value) {
      const existing = existingById.get(value.id);
      if (
        !existing ||
        existing.deletedAt ||
        existing.state !== State.PUBLISHED
      ) {
        unavailable();
      }

      const existingImages = parseMediaReferences(existing.image || '[]');
      const existingSettings = parseMediaReferences(existing.settings || '{}');
      if (!existingImages.valid || !existingSettings.valid) {
        unavailable();
      }

      const existingImageValue: unknown = JSON.parse(existing.image || '[]');
      const existingSettingsValue: unknown = JSON.parse(
        existing.settings || '{}'
      );
      const incomingImageIds = [
        ...new Set(value.image.map((media) => media.id)),
      ].sort();
      const existingImageIds = [...collectMediaIds(existingImageValue)].sort();
      const existingSettingsIds = [
        ...collectMediaIds(existingSettingsValue),
      ].sort();
      if (
        JSON.stringify(incomingImageIds) !== JSON.stringify(existingImageIds) ||
        JSON.stringify(incomingSettingsIds) !==
          JSON.stringify(existingSettingsIds)
      ) {
        unavailable();
      }

      for (const item of archived) {
        const imageUsesMedia = value.image.some((media) => media.id === item.id);
        if (imageUsesMedia && !existingImages.references.has(item.id)) {
          unavailable();
        }
        if (
          settingsIds.has(item.id) &&
          !existingSettings.references.has(item.id)
        ) {
          unavailable();
        }
      }
    }

    for (const item of archived) {
      if (!item.archivePreviewPath) {
        unavailable();
      }
    }
  }
}

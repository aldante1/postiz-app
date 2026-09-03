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

const MEDIA_SETTING_KEYS = ['main_image', 'thumbnail'] as const;

function collectSettingsMediaIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ids;
  }

  const settings = value as Record<string, unknown>;
  for (const key of MEDIA_SETTING_KEYS) {
    const candidate = settings[key];
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate)
    ) {
      const media = candidate as Record<string, unknown>;
      if (typeof media.id === 'string' && typeof media.path === 'string') {
        ids.add(media.id);
      }
    }
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
    const settingsIds = collectSettingsMediaIds(body.settings);
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
    if (
      settingsIds.size &&
      typeof body.settings === 'object' &&
      body.settings !== null
    ) {
      const inputSettings = body.settings as unknown as Record<string, unknown>;
      const canonicalSettings = { ...inputSettings };
      for (const key of MEDIA_SETTING_KEYS) {
        const candidate = inputSettings[key];
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          Array.isArray(candidate)
        ) {
          continue;
        }
        const mediaSetting = candidate as Record<string, unknown>;
        if (
          typeof mediaSetting.id !== 'string' ||
          !settingsIds.has(mediaSetting.id)
        ) {
          continue;
        }
        const canonicalJson = replaceMediaReference(
          JSON.stringify(mediaSetting),
          mediaSetting.id,
          canonicalPath.get(mediaSetting.id)!
        );
        canonicalSettings[key] = JSON.parse(canonicalJson) as unknown;
      }
      settings = canonicalSettings as unknown as PostBody['settings'];
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
      const existingImageIds = new Set<string>();
      if (!Array.isArray(existingImageValue)) {
        unavailable();
      }
      for (const candidate of existingImageValue) {
        if (
          typeof candidate === 'object' &&
          candidate !== null &&
          !Array.isArray(candidate)
        ) {
          const persistedMedia = candidate as Record<string, unknown>;
          if (typeof persistedMedia.id === 'string') {
            existingImageIds.add(persistedMedia.id);
          }
        }
      }
      const sortedExistingImageIds = [...existingImageIds].sort();
      const existingSettingsIds = [
        ...collectSettingsMediaIds(existingSettingsValue),
      ].sort();
      if (
        JSON.stringify(incomingImageIds) !==
          JSON.stringify(sortedExistingImageIds) ||
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

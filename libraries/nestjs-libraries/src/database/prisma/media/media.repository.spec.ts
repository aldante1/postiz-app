import { MediaRetentionState } from '@prisma/client';
import { MediaRepository } from './media.repository';

describe('MediaRepository retention visibility', () => {
  it('lists and counts only ACTIVE media', async () => {
    const count = jest.fn().mockResolvedValue(1);
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = new MediaRepository({
      model: { media: { count, findMany } },
    } as never);

    await repository.getMedia('org-1', 1);

    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        deletedAt: null,
        retentionState: MediaRetentionState.ACTIVE,
      }),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          deletedAt: null,
          retentionState: MediaRetentionState.ACTIVE,
        }),
      })
    );
  });

  it('does not return STAGED or PURGED media from direct picker lookup', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const repository = new MediaRepository({
      model: { media: { findUnique } },
    } as never);

    await repository.getMediaById('media-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        id: 'media-1',
        deletedAt: null,
        retentionState: MediaRetentionState.ACTIVE,
      },
    });
  });
});

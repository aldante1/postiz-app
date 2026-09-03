jest.mock('@sentry/nestjs', () => ({
  metrics: { count: jest.fn() },
}));
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: unknown) => value,
}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));



import { MediaUsageService } from './media.usage.service';
import { PostsRepository } from '../posts/posts.repository';
import { PostsService } from '../posts/posts.service';
import type { Prisma } from '@prisma/client';
import type { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';

const orgId = 'org-1';
const activeMedia = {
  id: 'm-active',
  path: 'https://postiz.example/uploads/active.png',
  retentionState: 'ACTIVE',
  archivePreviewPath: null,
  deletedAt: null,
};

function postBody(overrides: Record<string, unknown> = {}): PostBody {
  return {
    integration: { id: 'integration-1' },
    value: [
      {
        id: 'post-1',
        content: 'Caption',
        image: [
          {
            id: activeMedia.id,
            path: 'https://attacker.invalid/active.png',
          },
        ],
      },
    ],
    settings: { __type: 'youtube', title: 'Video', type: 'public' },
    ...overrides,
  } as unknown as PostBody;
}

type MockTransaction = Prisma.TransactionClient & {
  $queryRaw: jest.Mock;
  post: Prisma.TransactionClient['post'] & { findMany: jest.Mock };
};

function transactionWith(
  mediaRows: Record<string, unknown>[],
  existingPosts: Record<string, unknown>[] = []
): MockTransaction {
  return {
    $queryRaw: jest.fn().mockResolvedValue(mediaRows),
    post: {
      findMany: jest.fn().mockResolvedValue(existingPosts),
    },
  } as unknown as MockTransaction;
}

function renderedSql(query: { strings: readonly string[]; values: unknown[] }) {
  return {
    text: query.strings.join('?').replace(/\s+/g, ' ').trim(),
    values: query.values,
  };
}

describe('MediaUsageService', () => {
  const service = new MediaUsageService();

  it.each([
    ['missing', [], postBody()],
    [
      'manually deleted',
      [{ ...activeMedia, deletedAt: new Date('2026-09-03T00:00:00Z') }],
      postBody(),
    ],
    [
      'staged',
      [{ ...activeMedia, retentionState: 'STAGED' }],
      postBody(),
    ],
    [
      'purged on create',
      [
        {
          ...activeMedia,
          retentionState: 'PURGED',
          archivePreviewPath: 'https://postiz.example/uploads/archive.png',
        },
      ],
      postBody(),
    ],
  ])('rejects %s media as unavailable', async (_label, rows, body) => {
    await expect(
      service.lockAndCanonicalize(
        transactionWith(rows),
        orgId,
        'schedule',
        body
      )
    ).rejects.toThrow('Media is unavailable');
  });

  it('rejects a foreign organization media ID when the scoped lock returns no row', async () => {
    const tx = transactionWith([]);

    await expect(
      service.lockAndCanonicalize(tx, orgId, 'draft', postBody())
    ).rejects.toThrow('Media is unavailable');

    const query = renderedSql(tx.$queryRaw.mock.calls[0][0]);
    expect(query.text).toContain('"organizationId" = ?');
    expect(query.values[0]).toBe(orgId);
  });

  it('locks distinct IDs in deterministic order and canonicalizes post and settings media URLs', async () => {
    const second = {
      ...activeMedia,
      id: 'm-second',
      path: 'https://postiz.example/uploads/second.png',
    };
    const body = postBody({
      value: [
        {
          id: 'post-1',
          content: 'Caption',
          image: [
            { id: second.id, path: 'https://attacker.invalid/second.png' },
            { id: activeMedia.id, path: 'https://attacker.invalid/active.png' },
            { id: second.id, path: 'https://attacker.invalid/duplicate.png' },
          ],
        },
      ],
      settings: {
        __type: 'youtube',
        title: 'Video',
        type: 'public',
        thumbnail: {
          id: activeMedia.id,
          path: 'https://attacker.invalid/thumb.png',
        },
      },
    });
    const tx = transactionWith([second, activeMedia]);

    const canonical = await service.lockAndCanonicalize(
      tx,
      orgId,
      'schedule',
      body
    );

    const query = renderedSql(tx.$queryRaw.mock.calls[0][0]);
    expect(query.text).toContain('ORDER BY "id" FOR SHARE');
    expect(query.values).toEqual([orgId, activeMedia.id, second.id]);
    expect(canonical.value[0].image).toEqual([
      { id: second.id, path: second.path, url: second.path },
      { id: activeMedia.id, path: activeMedia.path, url: activeMedia.path },
      { id: second.id, path: second.path, url: second.path },
    ]);
    const youtubeSettings = canonical.settings as unknown as {
      thumbnail: { id: string; path: string; url: string };
    };
    expect(youtubeSettings.thumbnail).toEqual({
      id: activeMedia.id,
      path: activeMedia.path,
      url: activeMedia.path,
    });
  });

  it('canonicalizes the actual main_image provider setting shape', async () => {
    const body = postBody({
      value: [{ id: 'post-1', content: 'Article', image: [] }],
      settings: {
        __type: 'devto',
        title: 'Article',
        tags: [],
        main_image: {
          id: activeMedia.id,
          path: 'https://attacker.invalid/main.png',
        },
      },
    });

    const canonical = await service.lockAndCanonicalize(
      transactionWith([activeMedia]),
      orgId,
      'schedule',
      body
    );

    const articleSettings = canonical.settings as unknown as {
      main_image: { id: string; path: string; url: string };
    };
    expect(articleSettings.main_image).toEqual({
      id: activeMedia.id,
      path: activeMedia.path,
      url: activeMedia.path,
    });
  });

  it('does not treat a Lemmy community id and url as Media', async () => {
    const body = postBody({
      value: [{ id: 'post-1', content: 'Lemmy post', image: [] }],
      settings: {
        __type: 'lemmy',
        community: {
          id: 'community-1',
          url: 'https://lemmy.example/c/community',
        },
      },
    });
    const tx = transactionWith([]);

    await expect(
      service.lockAndCanonicalize(tx, orgId, 'schedule', body)
    ).resolves.toBe(body);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('preserves omitted draft settings while canonicalizing image media', async () => {
    const body = postBody({ settings: undefined });

    const canonical = await service.lockAndCanonicalize(
      transactionWith([activeMedia]),
      orgId,
      'draft',
      body
    );

    expect(canonical.settings).toBeUndefined();
    expect(canonical.value[0].image[0].path).toBe(activeMedia.path);
  });

  it('allows unchanged archived media only on the same published post update', async () => {
    const preview = 'https://postiz.example/uploads/.retention/m-purged.webp';
    const purged = {
      ...activeMedia,
      id: 'm-purged',
      retentionState: 'PURGED',
      archivePreviewPath: preview,
    };
    const body = postBody({
      value: [
        {
          id: 'published-post',
          content: 'Changed text only',
          image: [{ id: purged.id, path: preview }],
        },
      ],
    });
    const tx = transactionWith([purged], [
      {
        id: 'published-post',
        state: 'PUBLISHED',
        image: JSON.stringify([{ id: purged.id, path: preview, url: preview }]),
        settings: JSON.stringify(body.settings),
      },
    ]);

    const canonical = await service.lockAndCanonicalize(
      tx,
      orgId,
      'update',
      body
    );

    expect(canonical.value[0].image[0]).toEqual({
      id: purged.id,
      path: preview,
      url: preview,
    });
  });

  it('rejects media changes while using the published text-only archive exception', async () => {
    const preview = 'https://postiz.example/uploads/.retention/m-purged.webp';
    const purged = {
      ...activeMedia,
      id: 'm-purged',
      retentionState: 'PURGED',
      archivePreviewPath: preview,
    };
    const body = postBody({
      value: [
        {
          id: 'published-post',
          content: 'Changed text',
          image: [
            { id: purged.id, path: preview },
            { id: activeMedia.id, path: activeMedia.path },
          ],
        },
      ],
    });
    const tx = transactionWith([purged, activeMedia], [
      {
        id: 'published-post',
        state: 'PUBLISHED',
        image: JSON.stringify([{ id: purged.id, path: preview, url: preview }]),
        settings: JSON.stringify(body.settings),
      },
    ]);

    await expect(
      service.lockAndCanonicalize(tx, orgId, 'update', body)
    ).rejects.toThrow('Media is unavailable');
  });

  it.each([
    ['a new post', undefined, []],
    [
      'another published post',
      'other-post',
      [
        {
          id: 'other-post',
          state: 'PUBLISHED',
          image: '[]',
          settings: '{}',
        },
      ],
    ],
    [
      'an unpublished existing post',
      'draft-post',
      [
        {
          id: 'draft-post',
          state: 'DRAFT',
          image: JSON.stringify([{ id: 'm-purged', path: 'preview' }]),
          settings: '{}',
        },
      ],
    ],
  ])('rejects archived media reused by %s', async (_label, id, existingPosts) => {
    const preview = 'https://postiz.example/uploads/.retention/m-purged.webp';
    const purged = {
      ...activeMedia,
      id: 'm-purged',
      retentionState: 'PURGED',
      archivePreviewPath: preview,
    };
    const body = postBody({
      value: [
        {
          ...(id ? { id } : {}),
          content: 'Text',
          image: [{ id: purged.id, path: preview }],
        },
      ],
    });

    await expect(
      service.lockAndCanonicalize(
        transactionWith([purged], existingPosts),
        orgId,
        'update',
        body
      )
    ).rejects.toThrow('Media is unavailable');
  });
});

describe('transactional post persistence', () => {
  it('keeps media locking and the post upsert inside the same transaction callback', async () => {
    const events: string[] = [];
    const txValue = { marker: 'transaction-client' };
    const tx = txValue as unknown as Prisma.TransactionClient;
    const canonical = postBody();
    const prisma = {
      $transaction: jest.fn(
        async (
          callback: (client: Prisma.TransactionClient) => Promise<unknown>
        ) => {
          events.push('transaction:start');
          const result = await callback(tx);
          events.push('transaction:end');
          return result;
        }
      ),
    };
    const mediaUsage = {
      lockAndCanonicalize: jest.fn(
        async (client: Prisma.TransactionClient) => {
          expect(client).toBe(tx);
          events.push('media:locked');
          return canonical;
        }
      ),
    };
    const repository = {
      createOrUpdatePost: jest.fn(
        async (client: Prisma.TransactionClient) => {
          expect(client).toBe(tx);
          events.push('post:upserted');
          return { posts: [{ id: 'saved-post', state: 'QUEUE' }] };
        }
      ),
    };
    const serviceState = Object.assign(
      Object.create(PostsService.prototype) as object,
      {
        _postRepository: repository,
        _integrationManager: {
          getSocialIntegration: jest
            .fn()
            .mockReturnValue({ stripLinks: () => false }),
        },
        _shortLinkService: { convertTextToShortLinks: jest.fn() },
        _prismaService: prisma,
        _mediaUsageService: mediaUsage,
        startWorkflow: jest.fn().mockResolvedValue(undefined),
      }
    );
    const service = serviceState as unknown as PostsService;

    const result = await service.createPost(
      orgId,
      {
        type: 'schedule',
        date: '2026-09-04T10:00:00.000Z',
        shortLink: false,
        tags: [],
        posts: [postBody()],
      },
      'API'
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 30_000,
    });

    expect(events).toEqual([
      'transaction:start',
      'media:locked',
      'post:upserted',
      'transaction:end',
    ]);
    expect(result).toEqual([
      { postId: 'saved-post', integration: 'integration-1' },
    ]);
  });

  it('does not upsert until the share-lock guard resolves on the same transaction client', async () => {
    const events: string[] = [];
    let releaseLock: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const tx = { marker: 'transaction-client' } as unknown as Prisma.TransactionClient;
    const repository = {
      createOrUpdatePost: jest.fn(
        async (client: Prisma.TransactionClient) => {
          expect(client).toBe(tx);
          events.push('post:upsert');
          return { posts: [{ id: 'saved-post', state: 'QUEUE' }] };
        }
      ),
    };
    const serviceState = Object.assign(
      Object.create(PostsService.prototype) as object,
      {
        _postRepository: repository,
        _integrationManager: {
          getSocialIntegration: jest
            .fn()
            .mockReturnValue({ stripLinks: () => false }),
        },
        _shortLinkService: { convertTextToShortLinks: jest.fn() },
        _prismaService: {
          $transaction: jest.fn(
            async (
              callback: (client: Prisma.TransactionClient) => Promise<unknown>
            ) => {
              const result = await callback(tx);
              events.push('transaction:complete');
              return result;
            }
          ),
        },
        _mediaUsageService: {
          lockAndCanonicalize: jest.fn(
            async (client: Prisma.TransactionClient) => {
              expect(client).toBe(tx);
              events.push('lock:waiting');
              await lockGate;
              events.push('lock:acquired');
              return postBody();
            }
          ),
        },
        startWorkflow: jest.fn().mockResolvedValue(undefined),
      }
    );
    const service = serviceState as unknown as PostsService;

    const pending = service.createPost(
      orgId,
      {
        type: 'schedule',
        date: '2026-09-04T10:00:00.000Z',
        shortLink: false,
        tags: [],
        posts: [postBody()],
      },
      'API'
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['lock:waiting']);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();

    releaseLock?.();
    await pending;

    expect(events).toEqual([
      'lock:waiting',
      'lock:acquired',
      'post:upsert',
      'transaction:complete',
    ]);
  });

  it('uses the passed transaction client for every post and tag mutation', async () => {
    const outsidePost = {
      post: {
        upsert: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const outsideTags = { tags: { findMany: jest.fn() } };
    const outsideTagsPosts = { tagsPosts: { deleteMany: jest.fn() } };
    const repositoryDependencies = [
      { model: outsidePost },
      { model: {} },
      { model: {} },
      { model: outsideTags },
      { model: outsideTagsPosts },
      { model: {} },
    ] as unknown as ConstructorParameters<typeof PostsRepository>;
    const repository = new PostsRepository(...repositoryDependencies);
    const tx = {
      post: {
        upsert: jest.fn().mockResolvedValue({ id: 'saved-post' }),
        update: jest.fn().mockResolvedValue({ id: 'saved-post' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'previous-post' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tags: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tag-1' }]),
      },
      tagsPosts: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const transactionClient = tx as unknown as Prisma.TransactionClient;

    const result = await repository.createOrUpdatePost(
      transactionClient,
      'update',
      orgId,
      '2026-09-04T10:00:00.000Z',
      postBody({ group: 'old-group' }),
      [{ value: 'tag-1', label: 'Tag' }],
      'API'
    );

    expect(result.previousPost).toBe('previous-post');
    expect(tx.post.upsert).toHaveBeenCalledTimes(1);
    expect(tx.tagsPosts.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.tags.findMany).toHaveBeenCalledTimes(1);
    expect(tx.post.update).toHaveBeenCalledTimes(1);
    expect(tx.post.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.post.updateMany).toHaveBeenCalledTimes(1);
    expect(outsidePost.post.upsert).not.toHaveBeenCalled();
    expect(outsidePost.post.update).not.toHaveBeenCalled();
    expect(outsidePost.post.findFirst).not.toHaveBeenCalled();
    expect(outsidePost.post.updateMany).not.toHaveBeenCalled();
    expect(outsideTags.tags.findMany).not.toHaveBeenCalled();
    expect(outsideTagsPosts.tagsPosts.deleteMany).not.toHaveBeenCalled();
  });
});

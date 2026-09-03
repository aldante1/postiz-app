jest.mock('@langchain/openai', () => ({
  ChatOpenAI: class ChatOpenAI {},
  DallEAPIWrapper: class DallEAPIWrapper {},
}));
jest.mock('@langchain/langgraph', () => ({
  END: 'END',
  START: 'START',
  StateGraph: class StateGraph {},
}));
jest.mock('@langchain/core/messages', () => ({}));
jest.mock('@langchain/core/prompts', () => ({ ChatPromptTemplate: {} }));
jest.mock('jsdom', () => ({ JSDOM: class JSDOM {} }));
jest.mock('rss-parser', () => ({
  __esModule: true,
  default: class Parser {},
}));
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: unknown) => value,
}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { AutopostService } from './autopost.service';
import type { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import type { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

describe('AutopostService media persistence', () => {
  it('persists the generated image once and reuses its real Media ID for each integration', async () => {
    const createPost = jest.fn().mockResolvedValue([]);
    const postsService = {
      findFreeDateTime: jest.fn().mockResolvedValue('2026-09-04T10:00:00'),
      createPost,
    } as unknown as PostsService;
    const saveFile = jest.fn().mockResolvedValue({
      id: 'persisted-media',
      name: 'generated.png',
      originalName: null,
      path: 'https://postiz.example/uploads/generated-canonical.png',
      thumbnail: null,
      alt: null,
    });
    const mediaService = { saveFile } as unknown as MediaService;
    const serviceState = Object.assign(
      Object.create(AutopostService.prototype) as object,
      {
        _postsService: postsService,
        _mediaService: mediaService,
      }
    );
    const service = serviceState as unknown as AutopostService;
    const state = {
      integrations: [
        {
          id: 'integration-1',
          organizationId: 'org-1',
          providerIdentifier: 'linkedin',
        },
        {
          id: 'integration-2',
          organizationId: 'org-1',
          providerIdentifier: 'facebook',
        },
      ],
      description: 'Generated post',
      image: 'https://generator.example/generated.png',
      load: {
        date: '2026-09-03T00:00:00.000Z',
        url: 'https://source.example/article',
        description: 'Article',
      },
    } as unknown as Parameters<AutopostService['schedulePost']>[0];

    await service.schedulePost(state);

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith(
      'org-1',
      expect.any(String),
      'https://generator.example/generated.png'
    );
    const createBody = createPost.mock.calls[0][1];
    expect(createBody.posts).toHaveLength(2);
    expect(createBody.posts[0].value[0].image).toEqual([
      expect.objectContaining({
        id: 'persisted-media',
        path: 'https://postiz.example/uploads/generated-canonical.png',
      }),
    ]);
    expect(createBody.posts[1].value[0].image).toEqual(
      createBody.posts[0].value[0].image
    );
  });
});

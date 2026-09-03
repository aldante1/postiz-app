jest.mock('@mastra/core/tools', () => ({
  createTool: (configuration: unknown) => configuration,
}));
jest.mock('@gitroom/nestjs-libraries/chat/auth.context', () => ({
  checkAuth: jest.fn(),
}));
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: unknown) => value,
}));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { IntegrationSchedulePostTool } from './integration.schedule.post';
import type { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import type { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import type { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';

type ExecutableScheduleTool = {
  execute: (
    input: {
      socialPost: Array<{
        integrationId: string;
        isPremium: boolean;
        date: string;
        shortLink: boolean;
        type: 'draft' | 'schedule' | 'now';
        postsAndComments: Array<{
          content: string;
          attachments: string[];
        }>;
        settings: Array<{ key: string; value: unknown }>;
      }>;
    },
    context: { requestContext: Map<string, string> }
  ) => Promise<unknown>;
};

describe('IntegrationSchedulePostTool media persistence', () => {
  it('persists attachment URLs as organization Media before creating the Post', async () => {
    const createPost = jest.fn().mockResolvedValue([
      { postId: 'post-1', integration: 'integration-1' },
    ]);
    const postsService = {
      validatePosts: jest.fn().mockResolvedValue([
        {
          name: 'Test integration',
          emptyContent: false,
          valid: true,
          errors: true,
          tooLong: false,
        },
      ]),
      createPost,
    } as unknown as PostsService;
    const integrationService = {
      getIntegrationById: jest.fn().mockResolvedValue({
        id: 'integration-1',
        providerIdentifier: 'linkedin',
      }),
    } as unknown as IntegrationService;
    const saveFile = jest
      .fn()
      .mockImplementation(
        async (_organizationId: string, fileName: string, path: string) => ({
          id: `media-${fileName}`,
          path: `${path}?canonical=1`,
        })
      );
    const mediaService = { saveFile } as unknown as MediaService;
    const tool = new IntegrationSchedulePostTool(
      postsService,
      integrationService,
      mediaService
    );
    const executable = tool.run() as unknown as ExecutableScheduleTool;

    await executable.execute(
      {
        socialPost: [
          {
            integrationId: 'integration-1',
            isPremium: false,
            date: '2026-09-04T10:00:00.000Z',
            shortLink: false,
            type: 'schedule',
            postsAndComments: [
              {
                content: 'Post',
                attachments: [
                  'https://postiz.example/uploads/one.png',
                  'https://postiz.example/uploads/two.png',
                ],
              },
            ],
            settings: [],
          },
        ],
      },
      {
        requestContext: new Map([
          ['organization', JSON.stringify({ id: 'org-1' })],
        ]),
      }
    );

    expect(saveFile).toHaveBeenCalledTimes(2);
    expect(saveFile.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      'org-1',
      'org-1',
    ]);
    const createBody = createPost.mock.calls[0][1];
    expect(createBody.posts[0].value[0].image).toEqual([
      {
        id: expect.stringMatching(/^media-/),
        path: 'https://postiz.example/uploads/one.png?canonical=1',
      },
      {
        id: expect.stringMatching(/^media-/),
        path: 'https://postiz.example/uploads/two.png?canonical=1',
      },
    ]);
  });
});

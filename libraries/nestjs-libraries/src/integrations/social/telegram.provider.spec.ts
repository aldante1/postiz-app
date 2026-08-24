/** @jest-environment node */

import type { PostDetails } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import type { Integration } from '@prisma/client';

const mockToken = '123456:synthetic_telegram_bot_token_for_tests';
const mockProxy = 'socks5://proxy-user:proxy-pass@127.0.0.1:19090';

type TelegramBotConstructorOptions = {
  request?: {
    agent?: unknown;
  };
};

type TelegramChatId = string | number;

type TelegramMessageResponse = {
  message_id: number;
};

type TelegramSendMessageOptions = {
  parse_mode?: 'HTML';
  reply_to_message_id?: number;
};

type TelegramCaptionOptions = TelegramSendMessageOptions & {
  caption?: string;
};

type TelegramFileOptions = {
  filename?: string;
  contentType?: string;
};

type TelegramMediaGroupItem = {
  type: string;
  media: string;
  caption?: string;
  parse_mode?: 'HTML';
};

type TelegramMediaGroupOptions = {
  reply_to_message_id?: number;
};

type BotMethod =
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendVideo'
  | 'sendDocument'
  | 'sendMediaGroup'
  | 'getChat'
  | 'getChatMember'
  | 'getFileLink'
  | 'getUpdates'
  | 'getMe'
  | 'deleteMessage';

type BotHandler = (args: readonly unknown[]) => unknown;

type MockTelegramBotInstance = {
  sendMessage: jest.Mock<
    Promise<TelegramMessageResponse>,
    [TelegramChatId, string, TelegramSendMessageOptions?]
  >;
  sendPhoto: jest.Mock<
    Promise<TelegramMessageResponse>,
    [TelegramChatId, string, TelegramCaptionOptions?, TelegramFileOptions?]
  >;
  sendVideo: jest.Mock<
    Promise<TelegramMessageResponse>,
    [TelegramChatId, string, TelegramCaptionOptions?, TelegramFileOptions?]
  >;
  sendDocument: jest.Mock<
    Promise<TelegramMessageResponse>,
    [TelegramChatId, string, TelegramCaptionOptions?, TelegramFileOptions?]
  >;
  sendMediaGroup: jest.Mock<
    Promise<TelegramMessageResponse[]>,
    [TelegramChatId, readonly TelegramMediaGroupItem[], TelegramMediaGroupOptions?]
  >;
  getChat: jest.Mock<Promise<unknown>, [TelegramChatId]>;
  getChatMember: jest.Mock<Promise<unknown>, [TelegramChatId, number]>;
};

const mockTelegramBotState: {
  constructorArgs: Array<{ token: string; options?: TelegramBotConstructorOptions }>;
  handlers: Partial<Record<BotMethod, BotHandler>>;
  instances: MockTelegramBotInstance[];
} = {
  constructorArgs: [],
  handlers: {},
  instances: [],
};

function mockRunBotHandler<TResult>(
  method: BotMethod,
  args: readonly unknown[]
): TResult {
  const handler = mockTelegramBotState.handlers[method];
  if (!handler) {
    throw new Error(`Unexpected TelegramBot.${method} call`);
  }
  return handler(args) as TResult;
}

jest.mock('node-telegram-bot-api', () => {
  class MockTelegramBot {
    sendMessage: MockTelegramBotInstance['sendMessage'] = jest.fn(
      async (...args) =>
        mockRunBotHandler<Promise<TelegramMessageResponse>>('sendMessage', args)
    );

    sendPhoto: MockTelegramBotInstance['sendPhoto'] = jest.fn(
      async (...args) =>
        mockRunBotHandler<Promise<TelegramMessageResponse>>('sendPhoto', args)
    );

    sendVideo: MockTelegramBotInstance['sendVideo'] = jest.fn(
      async (...args) =>
        mockRunBotHandler<Promise<TelegramMessageResponse>>('sendVideo', args)
    );

    sendDocument: MockTelegramBotInstance['sendDocument'] = jest.fn(
      async (...args) =>
        mockRunBotHandler<Promise<TelegramMessageResponse>>('sendDocument', args)
    );

    sendMediaGroup: MockTelegramBotInstance['sendMediaGroup'] = jest.fn(
      async (...args) =>
        mockRunBotHandler<Promise<TelegramMessageResponse[]>>(
          'sendMediaGroup',
          args
        )
    );

    getChat: MockTelegramBotInstance['getChat'] = jest.fn(async (...args) =>
      mockRunBotHandler<Promise<unknown>>('getChat', args)
    );

    getChatMember: MockTelegramBotInstance['getChatMember'] = jest.fn(
      async (...args) => mockRunBotHandler<Promise<unknown>>('getChatMember', args)
    );

    getFileLink = jest.fn(async (...args: readonly unknown[]) =>
      mockRunBotHandler<Promise<unknown>>('getFileLink', args)
    );

    getUpdates = jest.fn(async (...args: readonly unknown[]) =>
      mockRunBotHandler<Promise<unknown>>('getUpdates', args)
    );

    getMe = jest.fn(async (...args: readonly unknown[]) =>
      mockRunBotHandler<Promise<unknown>>('getMe', args)
    );

    deleteMessage = jest.fn(async (...args: readonly unknown[]) =>
      mockRunBotHandler<Promise<unknown>>('deleteMessage', args)
    );

    constructor(token: string, options?: TelegramBotConstructorOptions) {
      mockTelegramBotState.constructorArgs.push({ token, options });
      mockTelegramBotState.instances.push(this);
    }
  }

  return {
    __esModule: true,
    default: MockTelegramBot,
  };
});

jest.mock('socks-proxy-agent', () => ({
  SocksProxyAgent: class MockSocksProxyAgent {
    constructor(public readonly proxy: string) {}
  },
}));

import {
  getTelegramBot,
  resetTelegramBot,
  TelegramProvider,
} from './telegram.provider';

const formattedEditorHtml =
  '<strong>bold</strong> <em>italic</em> <tg-spoiler>hidden</tg-spoiler>';
const canonicalTelegramHtml =
  '<b>bold</b> <i>italic</i> <tg-spoiler>hidden</tg-spoiler>';
const chatId = '-1001234567890';

function createProvider() {
  return new TelegramProvider();
}

function postDetails(
  message: string,
  media: PostDetails<Record<string, never>>['media'] = []
): PostDetails<Record<string, never>> {
  return {
    id: 'post-1',
    message,
    settings: {},
    media,
  };
}

function image(path: string) {
  return {
    type: 'image' as const,
    path,
  };
}

function allowBotMethod(method: BotMethod, handler: BotHandler) {
  mockTelegramBotState.handlers[method] = handler;
}

function latestBot() {
  const bot = mockTelegramBotState.instances.at(-1);
  if (!bot) {
    throw new Error('TelegramBot was not constructed');
  }
  return bot;
}

function resetMockTelegramBot() {
  mockTelegramBotState.constructorArgs = [];
  mockTelegramBotState.handlers = {};
  mockTelegramBotState.instances = [];
}

async function captureError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function expectErrorNotToLeakSecrets(error: unknown) {
  const message = errorMessage(error);
  expect(message).not.toContain(mockToken);
  expect(message).not.toContain(mockProxy);
}

beforeEach(() => {
  process.env.TELEGRAM_TOKEN = mockToken;
  delete process.env.TELEGRAM_PROXY;
  resetTelegramBot();
  resetMockTelegramBot();
});

afterEach(() => {
  resetTelegramBot();
  delete process.env.TELEGRAM_PROXY;
  delete process.env.TELEGRAM_TOKEN;
});

describe('TelegramProvider formatting contracts', () => {
  it('requests raw editor content and exposes Telegram text and caption limits', () => {
    const provider = createProvider();

    expect(provider.rawEditorContent).toBe(true);
    expect(provider.maxLength(undefined, false)).toBe(4096);
    expect(provider.maxLength(undefined, true)).toBe(1024);
  });

  it('sends a text post as canonical Telegram HTML', async () => {
    allowBotMethod('sendMessage', () => Promise.resolve({ message_id: 1001 }));

    await createProvider().post('channel', chatId, [postDetails(formattedEditorHtml)]);

    expect(latestBot().sendMessage).toHaveBeenCalledWith(
      chatId,
      canonicalTelegramHtml,
      { parse_mode: 'HTML' }
    );
  });

  it('sends one image with the same canonical HTML caption', async () => {
    allowBotMethod('sendPhoto', () => Promise.resolve({ message_id: 1002 }));

    await createProvider().post('channel', chatId, [
      postDetails(formattedEditorHtml, [image('https://cdn.example.test/one.jpg')]),
    ]);

    expect(latestBot().sendPhoto).toHaveBeenCalledWith(
      chatId,
      'https://cdn.example.test/one.jpg',
      { caption: canonicalTelegramHtml, parse_mode: 'HTML' },
      { filename: 'one.jpg', contentType: 'image/jpeg' }
    );
  });

  it('sends two images as a media group with caption only on the first item', async () => {
    allowBotMethod('sendMediaGroup', () =>
      Promise.resolve([{ message_id: 1003 }, { message_id: 1004 }])
    );

    await createProvider().post('channel', chatId, [
      postDetails(formattedEditorHtml, [
        image('https://cdn.example.test/one.jpg'),
        image('https://cdn.example.test/two.jpg'),
      ]),
    ]);

    expect(latestBot().sendMediaGroup).toHaveBeenCalledWith(
      chatId,
      [
        {
          type: 'photo',
          media: 'https://cdn.example.test/one.jpg',
          caption: canonicalTelegramHtml,
          parse_mode: 'HTML',
        },
        {
          type: 'photo',
          media: 'https://cdn.example.test/two.jpg',
          caption: undefined,
          parse_mode: 'HTML',
        },
      ],
      {}
    );
  });

  it('sends comments as canonical Telegram HTML replies', async () => {
    allowBotMethod('sendMessage', () => Promise.resolve({ message_id: 1005 }));

    await createProvider().comment(
      'channel',
      '41',
      '42',
      chatId,
      [postDetails(formattedEditorHtml)],
      {} as Integration
    );

    expect(latestBot().sendMessage).toHaveBeenCalledWith(
      chatId,
      canonicalTelegramHtml,
      { parse_mode: 'HTML', reply_to_message_id: 42 }
    );
  });

  it('rejects text posts over 4096 visible characters before Bot API calls', async () => {
    const body = 'x'.repeat(4097);

    const error = await captureError(() =>
      createProvider().post('channel', chatId, [postDetails(body)])
    );

    expect(errorMessage(error)).toContain('4096');
    expect(errorMessage(error)).toContain('4097');
    expect(errorMessage(error)).not.toContain(body);
    expectErrorNotToLeakSecrets(error);
    expect(mockTelegramBotState.instances).toHaveLength(0);
  });

  it('rejects media captions over 1024 visible characters before Bot API calls', async () => {
    const body = 'x'.repeat(1025);

    const error = await captureError(() =>
      createProvider().post('channel', chatId, [
        postDetails(body, [image('https://cdn.example.test/one.jpg')]),
      ])
    );

    expect(errorMessage(error)).toContain('1024');
    expect(errorMessage(error)).toContain('1025');
    expect(errorMessage(error)).not.toContain(body);
    expectErrorNotToLeakSecrets(error);
    expect(mockTelegramBotState.instances).toHaveLength(0);
  });

  it('accepts text posts at the 4096 visible-character boundary', async () => {
    allowBotMethod('sendMessage', () => Promise.resolve({ message_id: 1006 }));

    await createProvider().post('channel', chatId, [postDetails('x'.repeat(4096))]);

    expect(latestBot().sendMessage).toHaveBeenCalledWith(
      chatId,
      'x'.repeat(4096),
      { parse_mode: 'HTML' }
    );
  });

  it('accepts media captions at the 1024 visible-character boundary', async () => {
    allowBotMethod('sendPhoto', () => Promise.resolve({ message_id: 1007 }));

    await createProvider().post('channel', chatId, [
      postDetails('x'.repeat(1024), [image('https://cdn.example.test/one.jpg')]),
    ]);

    expect(latestBot().sendPhoto).toHaveBeenCalledWith(
      chatId,
      'https://cdn.example.test/one.jpg',
      { caption: 'x'.repeat(1024), parse_mode: 'HTML' },
      { filename: 'one.jpg', contentType: 'image/jpeg' }
    );
  });

  it('rejects javascript links before Bot API calls', async () => {
    const unsafeContent = '<a href="javascript:alert(1)">open me</a>';

    const error = await captureError(() =>
      createProvider().post('channel', chatId, [postDetails(unsafeContent)])
    );

    expect(errorMessage(error)).toMatch(/javascript|url|link|protocol/i);
    expect(errorMessage(error)).not.toContain(unsafeContent);
    expectErrorNotToLeakSecrets(error);
    expect(mockTelegramBotState.instances).toHaveLength(0);
  });
});

describe('Telegram bot transport', () => {
  it('constructs TelegramBot without transport options when TELEGRAM_PROXY is absent', () => {
    delete process.env.TELEGRAM_PROXY;

    getTelegramBot();

    expect(mockTelegramBotState.constructorArgs).toEqual([
      { token: mockToken, options: undefined },
    ]);
  });

  it('constructs TelegramBot with a request agent when TELEGRAM_PROXY is present', () => {
    process.env.TELEGRAM_PROXY = mockProxy;

    getTelegramBot();

    expect(mockTelegramBotState.constructorArgs).toHaveLength(1);
    expect(mockTelegramBotState.constructorArgs[0].token).toBe(mockToken);
    expect(mockTelegramBotState.constructorArgs[0].options?.request?.agent).toBeDefined();
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import axios from 'axios';
import FormDataUpload from 'form-data';
import type { Integration } from '@prisma/client';
import type {
  PostDetails,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  createSsrfSafeLookup,
  getSsrfSafeDispatcher,
} from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';

jest.mock('@gitroom/helpers/utils/timer', () => ({
  timer: jest.fn(async () => undefined),
}));
jest.mock('axios');

import { MaxProvider } from './max.provider';
import { getMaxDispatcher, getMaxHttpsAgent } from './max.tls';

const MAX_API_BASE = 'https://platform-api2.max.ru';
const SYNTHETIC_TOKEN = 'max_synthetic_token_for_tests_0000000000000000000000';
const SYNTHETIC_CHAT_ID = '-1001234567890';
const CHANNEL_ICON_URL = 'https://cdn.example.test/max/channel-icon.png';
const BOT_AVATAR_URL = 'https://cdn.example.test/max/bot-avatar-small.png';
const BOT_FULL_AVATAR_URL = 'https://cdn.example.test/max/bot-avatar-full.png';
const SYNTHETIC_POST_ID = 'postiz-max-post-0001';
const SYNTHETIC_TEXT = '<p>MAX publication fixture text.</p>';
const SYNTHETIC_FORMATTED_TEXT = 'MAX publication fixture text.';
const ERROR_RECONNECT_REQUIRED =
  'MAX authentication has expired, please reconnect the MAX channel.';
const MiB = 1024 * 1024;
const UPLOAD_RETRY_ERROR = 'MAX transient upload failure';

type FetchMock = jest.MockedFunction<
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
>;
type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family: number
) => void;

type DnsLookup = (
  hostname: string,
  options: { all?: boolean },
  callback: DnsLookupCallback
) => void;


type CustomField = {
  key: string;
  label: string;
  defaultValue?: string;
  validation: string;
  type: 'text' | 'password';
  hint?: string;
};

type AuthParams = {
  code: string;
  codeVerifier: string;
  refresh?: string;
};

type AuthSuccess = {
  id: string;
  name: string;
  accessToken: string;
  username: string;
  picture?: string;
  refreshToken?: string;
  expiresIn?: number;
};

type MaxProviderContract = {
  customFields(): Promise<CustomField[]>;
  authenticate(params: AuthParams): Promise<AuthSuccess | string>;
  post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]>;
  handleErrors(
    body: string,
    status: number
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined;
};

type ImageDimensionProbe = {
  getImageDimensions(path: string): Promise<{ width: number; height: number }>;
};

type MediaStreamProbe = {
  mediaSize(path: string, identifier?: string): Promise<number>;
  mediaStream(path: string, identifier?: string): Promise<NodeJS.ReadableStream>;
};

type MaxPublicationFixture = {
  provenance: {
    synthetic: boolean;
    redactions: string[];
    sources: string[];
    liveShapeConfirmation: string;
  };
  uploads: {
    imageOne: { url: string; photoKey: string; token: string };
    imageTwo: { url: string; photoKey: string; token: string };
    video: { url: string; token: string; retval: string };
    tokenlessVideo: { url: string; retval: string };
  };
  sendMessage: {
    message: {
      url: string;
      body: {
        mid: string;
      };
    };
  };
};

type RecordedFetchCall = {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
  url: string;
  method: string;
  headers: HeadersInit | undefined;
  body: unknown;
};

type FetchHandler = (
  request: RecordedFetchCall,
  index: number
) => Response | Promise<Response>;

type AxiosPostMock = jest.MockedFunction<typeof axios.post>;

const publicationFixture =
  require('./max.publication.fixture.json') as MaxPublicationFixture;

type MaxBotFixture = {
  user_id: number;
  first_name: string;
  username: string;
  is_bot: boolean;
  last_activity_time: number;
  name: string | null;
  description: string | null;
  avatar_url: string;
  full_avatar_url: string;
  commands: unknown[];
};

type MaxChannelFixture = {
  chat_id: number;
  type: 'chat' | 'channel' | 'dialog';
  status: 'active' | 'removed' | 'left' | 'closed';
  title: string | null;
  icon: { url: string } | null;
  last_event_time: number;
  participants_count: number;
  owner_id: number | null;
  participants: Record<string, number> | null;
  is_public: boolean;
  link: string | null;
  description: string | null;
  messages_count: number | null;
  pinned_message: unknown;
};

type MaxMembershipFixture = {
  user_id: number;
  first_name: string;
  username: string | null;
  is_bot: boolean;
  last_activity_time: number;
  name: string | null;
  description: string | null;
  avatar_url: string;
  full_avatar_url: string;
  last_access_time: number;
  is_owner: boolean;
  is_admin: boolean;
  join_time: number;
  permissions?: string[] | null;
  alias: string;
};

const CONSOLE_METHODS = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const;

const ERROR_INVALID_BASE64 = 'MAX connection payload must be valid base64.';
const ERROR_INVALID_JSON = 'MAX connection payload must be valid JSON.';
const ERROR_INVALID_CHAT_ID = 'MAX channel chat_id must be a signed int64.';
const ERROR_INVALID_TOKEN = 'MAX bot token was rejected by MAX.';
const ERROR_NOT_CHANNEL = 'MAX chat_id must point to a channel.';
const ERROR_INACTIVE_CHANNEL = 'MAX channel must be active.';
const ERROR_NOT_ADMIN = 'MAX bot must be an administrator of the channel.';
const ERROR_MISSING_WRITE_PERMISSION =
  'MAX bot administrator must have the write permission.';

function createProvider(): MaxProviderContract {
  return new MaxProvider() as MaxProviderContract;
}

class NonMaxFetchProbe extends SocialAbstract {
  identifier = 'non-max-fetch-probe';

  fetchThroughBaseClass(url: string) {
    return this.fetch(url, {}, this.identifier);
  }
}


const botFixture: MaxBotFixture = {
  user_id: 700000000001,
  first_name: 'Postiz MAX Bot',
  username: 'postiz_max_test_bot',
  is_bot: true,
  last_activity_time: 1_760_000_000_000,
  name: null,
  description: 'Synthetic bot fixture',
  avatar_url: BOT_AVATAR_URL,
  full_avatar_url: BOT_FULL_AVATAR_URL,
  commands: [],
};

const activeChannelFixture: MaxChannelFixture = {
  chat_id: Number(SYNTHETIC_CHAT_ID),
  type: 'channel',
  status: 'active',
  title: 'Postiz MAX Test Channel',
  icon: {
    url: CHANNEL_ICON_URL,
  },
  last_event_time: 1_760_000_010_000,
  participants_count: 42,
  owner_id: 700000000002,
  participants: null,
  is_public: false,
  link: null,
  description: 'Synthetic channel fixture',
  messages_count: 7,
  pinned_message: null,
};

const adminMembershipFixture: MaxMembershipFixture = {
  user_id: botFixture.user_id,
  first_name: botFixture.first_name,
  username: botFixture.username,
  is_bot: true,
  last_activity_time: botFixture.last_activity_time,
  name: null,
  description: botFixture.description,
  avatar_url: BOT_AVATAR_URL,
  full_avatar_url: BOT_FULL_AVATAR_URL,
  last_access_time: 1_760_000_020_000,
  is_owner: false,
  is_admin: true,
  join_time: 1_760_000_000_000,
  permissions: ['read_all_messages', 'write'],
  alias: 'publisher',
};

let consoleSpies: jest.SpyInstance[] = [];
let tempMediaDirs: string[] = [];

beforeEach(() => {
  mockedAxiosPost().mockReset();
  consoleSpies = CONSOLE_METHODS.map((method) =>
    jest.spyOn(console, method).mockImplementation()
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  tempMediaDirs.forEach((dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  tempMediaDirs = [];
});

describe('MaxProvider authentication contract', () => {

  it('opts in to secure custom-field transport', () => {
    expect(new MaxProvider().secureCustomFields).toBe(true);
  });

  it('exposes a required bot token and signed int64 channel chat id as custom fields', async () => {
    const fields: CustomField[] = await createProvider().customFields();

    expect(fields).toHaveLength(2);
    expect(fields).toEqual([
      expect.objectContaining({
        key: 'token',
        label: 'MAX bot token',
        type: 'password',
      }),
      expect.objectContaining({
        key: 'chatId',
        label: 'MAX channel chat_id',
        type: 'text',
      }),
    ]);

    const tokenField = fields.find((field) => field.key === 'token');
    const chatIdField = fields.find((field) => field.key === 'chatId');

    expect(tokenField).toBeDefined();
    expect(validationRegex(tokenField!.validation).test('x')).toBe(true);
    expect(validationRegex(tokenField!.validation).test('')).toBe(false);

    expect(chatIdField).toBeDefined();
    const chatIdValidation = validationRegex(chatIdField!.validation);
    expect(chatIdValidation.test('0')).toBe(true);
    expect(chatIdValidation.test('-1')).toBe(true);
    expect(chatIdValidation.test('9223372036854775807')).toBe(true);
    expect(chatIdValidation.test('-9223372036854775808')).toBe(true);
    expect(chatIdValidation.test('')).toBe(false);
    expect(chatIdValidation.test('1.5')).toBe(false);
    expect(chatIdValidation.test('+1')).toBe(false);
    expect(chatIdValidation.test('abc')).toBe(false);
    expect(chatIdValidation.test('9223372036854775808')).toBe(false);
    expect(chatIdValidation.test('-9223372036854775809')).toBe(false);
  });

  it('trims decoded credentials, checks MAX endpoints in order, and returns channel auth details without refresh metadata', async () => {
    const { provider, fetchMock } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse(activeChannelFixture),
      jsonResponse(adminMembershipFixture)
    );
    const encoded = encodeCredentials({
      token: `  ${SYNTHETIC_TOKEN}  `,
      chatId: `  ${SYNTHETIC_CHAT_ID}  `,
    });

    const result = await provider.authenticate({
      code: encoded,
      codeVerifier: 'unused-for-custom-fields',
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: String(activeChannelFixture.chat_id),
        name: activeChannelFixture.title,
        accessToken: SYNTHETIC_TOKEN,
        username: botFixture.username,
        picture: CHANNEL_ICON_URL,
      })
    );
    expect(result).not.toHaveProperty('refreshToken');
    expect(result).not.toHaveProperty('expiresIn');
    expectGetCalls(fetchMock, [
      `${MAX_API_BASE}/me`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}/members/me`,
    ]);
    expectNoConsoleLeak([encoded]);
  });

  it('carries the cached MAX dispatcher on each authentication API probe', async () => {
    const maxDispatcher = getMaxDispatcher();
    expect(getMaxDispatcher()).toBe(maxDispatcher);
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (request.url === `${MAX_API_BASE}/me`) {
        return jsonResponse(botFixture);
      }

      if (request.url === `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}`) {
        return jsonResponse(activeChannelFixture);
      }

      if (
        request.url === `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}/members/me`
      ) {
        return jsonResponse(adminMembershipFixture);
      }

      throwUnexpectedRequest(request);
    });

    const result = await provider.authenticate({
      code: encodeCredentials(),
      codeVerifier: '',
    });

    expect(result).toEqual(
      expect.objectContaining({
        accessToken: SYNTHETIC_TOKEN,
        id: SYNTHETIC_CHAT_ID,
      })
    );
    expect(calls).toHaveLength(3);
    [
      '/me',
      `/chats/${SYNTHETIC_CHAT_ID}`,
      `/chats/${SYNTHETIC_CHAT_ID}/members/me`,
    ].forEach((pathWithQuery, index) => {
      expectMaxApiCall(calls[index], pathWithQuery, 'GET');
    });
  });

  it('preserves the normalized input chat_id as integration id when MAX returns an unsafe rounded number', async () => {
    const unsafeChatId = '9007199254740993';
    const roundedChannelChatId = Number(unsafeChatId);
    const { provider, fetchMock } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse({
        ...activeChannelFixture,
        chat_id: roundedChannelChatId,
      }),
      jsonResponse(adminMembershipFixture)
    );
    const encoded = encodeCredentials({
      chatId: `  ${unsafeChatId}  `,
    });

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expect(result).toEqual(expect.objectContaining({ id: unsafeChatId }));
    expectGetCalls(fetchMock, [
      `${MAX_API_BASE}/me`,
      `${MAX_API_BASE}/chats/${unsafeChatId}`,
      `${MAX_API_BASE}/chats/${unsafeChatId}/members/me`,
    ]);
    expectNoConsoleLeak([encoded]);
  });

  it('falls back to the bot avatar when the channel does not have an icon', async () => {
    const { provider } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse({ ...activeChannelFixture, icon: null }),
      jsonResponse(adminMembershipFixture)
    );
    const encoded = encodeCredentials();

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expect(result).toEqual(expect.objectContaining({ picture: BOT_AVATAR_URL }));
    expectNoConsoleLeak([encoded]);
  });

  it.each([
    ['invalid base64', 'not-valid-base64%%', ERROR_INVALID_BASE64],
    [
      'invalid JSON',
      Buffer.from(
        `{"token":"${SYNTHETIC_TOKEN}","chatId":"${SYNTHETIC_CHAT_ID}"`
      ).toString('base64'),
      ERROR_INVALID_JSON,
    ],
  ])('rejects %s credentials without calling MAX or leaking secrets', async (_case: string, code: string, message: string) => {
    const { provider, fetchMock } = providerWithFetch();

    const result = await provider.authenticate({ code, codeVerifier: '' });

    expectAuthError(result, message, [code]);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoConsoleLeak([code]);
  });

  it.each(['', ' ', 'abc', '1.5', '+1', '9223372036854775808', '-9223372036854775809'])(
    'rejects non-int64 chat_id %p before calling MAX',
    async (chatId: string) => {
      const { provider, fetchMock } = providerWithFetch();
      const encoded = encodeCredentials({ chatId });

      const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

      expectAuthError(result, ERROR_INVALID_CHAT_ID, [encoded]);
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoConsoleLeak([encoded]);
    }
  );

  it('rejects a token that does not pass /me without looking up the channel or leaking the token', async () => {
    const { provider, fetchMock } = providerWithFetch();
    fetchMock.mockRejectedValueOnce(
      new Error(`401 from MAX for ${SYNTHETIC_TOKEN}`)
    );
    const encoded = encodeCredentials();

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expectAuthError(result, ERROR_INVALID_TOKEN, [encoded]);
    expectGetCalls(fetchMock, [`${MAX_API_BASE}/me`]);
    expectNoConsoleLeak([encoded]);
  });

  it('cancels a rejected MAX authentication response body before returning', async () => {
    const rejectedResponse = jsonResponse({ error: 'unauthorized' }, 401);
    const cancelSpy = jest.spyOn(rejectedResponse.body!, 'cancel');
    const { provider } = providerWithFetch(rejectedResponse);

    const result = await provider.authenticate({
      code: encodeCredentials(),
      codeVerifier: '',
    });

    expectAuthError(result, ERROR_INVALID_TOKEN);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a chat that is not a channel', async () => {
    const { provider, fetchMock } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse({ ...activeChannelFixture, type: 'chat' })
    );
    const encoded = encodeCredentials();

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expectAuthError(result, ERROR_NOT_CHANNEL, [encoded]);
    expectGetCalls(fetchMock, [
      `${MAX_API_BASE}/me`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}`,
    ]);
    expectNoConsoleLeak([encoded]);
  });

  it('rejects a channel that is not active', async () => {
    const { provider, fetchMock } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse({ ...activeChannelFixture, status: 'left' })
    );
    const encoded = encodeCredentials();

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expectAuthError(result, ERROR_INACTIVE_CHANNEL, [encoded]);
    expectGetCalls(fetchMock, [
      `${MAX_API_BASE}/me`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}`,
    ]);
    expectNoConsoleLeak([encoded]);
  });

  it('rejects bot membership that is not an administrator', async () => {
    const { provider, fetchMock } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse(activeChannelFixture),
      jsonResponse({
        ...adminMembershipFixture,
        is_admin: false,
        permissions: undefined,
      })
    );
    const encoded = encodeCredentials();

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expectAuthError(result, ERROR_NOT_ADMIN, [encoded]);
    expectGetCalls(fetchMock, [
      `${MAX_API_BASE}/me`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}/members/me`,
    ]);
    expectNoConsoleLeak([encoded]);
  });

  it('rejects administrator membership without write permission', async () => {
    const { provider, fetchMock } = providerWithFetch(
      jsonResponse(botFixture),
      jsonResponse(activeChannelFixture),
      jsonResponse({
        ...adminMembershipFixture,
        permissions: ['read_all_messages', 'pin_message'],
      })
    );
    const encoded = encodeCredentials();

    const result = await provider.authenticate({ code: encoded, codeVerifier: '' });

    expectAuthError(result, ERROR_MISSING_WRITE_PERMISSION, [encoded]);
    expectGetCalls(fetchMock, [
      `${MAX_API_BASE}/me`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}`,
      `${MAX_API_BASE}/chats/${SYNTHETIC_CHAT_ID}/members/me`,
    ]);
    expectNoConsoleLeak([encoded]);
  });
});

describe('MAX TLS/SSRF dispatcher contract', () => {
  it('loads the pinned PEM when the backend process cwd is its workspace package', async () => {
    const repositoryRoot = process.cwd();
    jest.spyOn(process, 'cwd').mockReturnValue(path.join(repositoryRoot, 'apps/backend'));
    let isolatedDispatcher: ReturnType<typeof getMaxDispatcher> | undefined;
    let isolatedHttpsAgent: ReturnType<typeof getMaxHttpsAgent> | undefined;

    jest.isolateModules(() => {
      const isolatedTls = require('./max.tls') as typeof import('./max.tls');
      isolatedDispatcher = isolatedTls.getMaxDispatcher();
      isolatedHttpsAgent = isolatedTls.getMaxHttpsAgent();
    });

    expect(isolatedDispatcher).toBeDefined();
    expect(isolatedHttpsAgent).toBeDefined();
    await isolatedDispatcher!.close();
    isolatedHttpsAgent!.destroy();
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:a9fe:a9fe',
  ])(
    'rejects unsafe literal destination %s without DNS resolution',
    async (hostname) => {
      await expect(resolveWithLookup(createSsrfSafeLookup(), hostname)).rejects.toThrow(
        /blocked/i
      );
    }
  );

  it('accepts a public literal destination without DNS resolution', async () => {
    await expect(resolveWithLookup(createSsrfSafeLookup(), '8.8.8.8')).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
  });

  it('keeps non-MAX SocialAbstract.fetch on the generic SSRF dispatcher', async () => {
    const ssrfDispatcher = getSsrfSafeDispatcher();
    const maxDispatcher = getMaxDispatcher();
    const probe = new NonMaxFetchProbe();
    const fetchMock = jest.spyOn(globalThis, 'fetch') as FetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await probe.fetchThroughBaseClass('https://public.example.test/non-max-probe');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://public.example.test/non-max-probe');
    expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBe(
      ssrfDispatcher
    );
    expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).not.toBe(
      maxDispatcher
    );
  });
});

describe('MaxProvider publication contract', () => {
  it('publishes a single text post to the channel chat_id and maps message.body.mid plus message.url', async () => {
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      expectMaxApiCall(request, `/messages?chat_id=${SYNTHETIC_CHAT_ID}`, 'POST');
      expect(headerValue(request.headers, 'Content-Type')).toBe('application/json');
      expect(await requestJson(request)).toEqual({
        text: SYNTHETIC_FORMATTED_TEXT,
        format: 'html',
        notify: true,
      });
      return jsonResponse(publicationFixture.sendMessage);
    });

    const result = await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost()],
      syntheticIntegration()
    );

    expect(result).toEqual([
      {
        id: SYNTHETIC_POST_ID,
        postId: publicationFixture.sendMessage.message.body.mid,
        releaseURL: publicationFixture.sendMessage.message.url,
        status: 'completed',
      },
    ]);
    expect(calls).toHaveLength(1);
    expectNoTokenInUrls(calls);
    expectNoConsoleLeak();
  });

  it('sends formatted MAX HTML and keeps the request format as html', async () => {
    const { provider } = providerWithFetchRecorder(async (request) => {
      expectMaxApiCall(request, `/messages?chat_id=${SYNTHETIC_CHAT_ID}`, 'POST');
      expect(await requestJson(request)).toEqual({
        text: '<b>bold</b> <a href=\"https://x.ru/?a=1&amp;b=2\">link</a>',
        format: 'html',
        notify: true,
      });
      return jsonResponse(publicationFixture.sendMessage);
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [
        maxPost({
          message:
            '<p><strong>bold</strong> <a target=\"_blank\" rel=\"noopener\" href=\"https://x.ru/?a=1&amp;b=2\">link</a></p>',
        }),
      ],
      syntheticIntegration()
    );
  });

  it('rejects 4001 visible characters before any outbound request', async () => {
    const longText = 'x'.repeat(4001);
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost({ message: `<p>${longText}</p>` })],
        syntheticIntegration()
      ),
      'MAX message exceeds the text limit. Limit: 4000, actual: 4001.',
      [longText]
    );
    expect(calls).toHaveLength(0);
    expect(mockedAxiosPost()).not.toHaveBeenCalled();
  });

  it('allows exactly 4000 visible characters', async () => {
    const textAtLimit = 'x'.repeat(4000);
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: textAtLimit,
          format: 'html',
          notify: true,
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ message: `<p>${textAtLimit}</p>` })],
      syntheticIntegration()
    );

    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
  });

  it('rejects javascript links before allocating or uploading media and does not leak secrets', async () => {
    const secretPostText = 'secret MAX post body';
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [
          maxPost({
            message: `<p><a href=\"javascript:alert(1)\">${secretPostText}</a></p>`,
            media: [{ type: 'image', path: 'max-image-that-must-not-upload.png' }],
          }),
        ],
        syntheticIntegration()
      ),
      'Unsupported MAX link protocol: javascript',
      [secretPostText, 'javascript:alert(1)']
    );
    expect(calls).toHaveLength(0);
    expect(mockedAxiosPost()).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'omits URL', messageUrl: undefined },
    { name: 'returns null URL', messageUrl: null },
  ])(
    'returns an empty releaseURL when MAX accepts a message but $name',
    async ({ messageUrl }) => {
      const { provider } = providerWithFetchRecorder(async (request) => {
        if (isMaxMessageRequest(request)) {
          const message: { body: { mid: string }; url?: null } = {
            body: { mid: publicationFixture.sendMessage.message.body.mid },
          };
          if (messageUrl === null) {
            message.url = null;
          }

          return jsonResponse({ message });
        }

        throwUnexpectedRequest(request);
      });

      const result = await provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost()],
        syntheticIntegration()
      );

      expect(result).toEqual([
        {
          id: SYNTHETIC_POST_ID,
          postId: publicationFixture.sendMessage.message.body.mid,
          releaseURL: '',
          status: 'completed',
        },
      ]);
    }
  );

  it('allocates two images separately, uploads them sequentially via axios FormData, and preserves attachment order', async () => {
    const imageOneContent = Buffer.concat([tinyPng(), Buffer.from('image-one')]);
    const imageTwoContent = Buffer.concat([tinyPng(), Buffer.from('image-two')]);
    const imageOne = createTempMediaFile('max-image-one.png', imageOneContent);
    const imageTwo = createTempMediaFile('max-image-two.png', imageTwoContent);
    const uploadedUrls: string[] = [];
    const allocations = [
      publicationFixture.uploads.imageOne,
      publicationFixture.uploads.imageTwo,
    ];
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'image')) {
        const allocation = allocations.shift();
        if (!allocation) {
          throw new Error('Unexpected extra image allocation');
        }
        return jsonResponse({ url: allocation.url });
      }

      if (isMaxMessageRequest(request)) {
        expect(uploadedUrls).toEqual([
          publicationFixture.uploads.imageOne.url,
          publicationFixture.uploads.imageTwo.url,
        ]);
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'image',
              payload: {
                photos: {
                  [publicationFixture.uploads.imageOne.photoKey]: {
                    token: publicationFixture.uploads.imageOne.token,
                  },
                },
              },
            },
            {
              type: 'image',
              payload: {
                photos: {
                  [publicationFixture.uploads.imageTwo.photoKey]: {
                    token: publicationFixture.uploads.imageTwo.token,
                  },
                },
              },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockImageDimensions(provider);
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const uploadExpectations = [
        {
          ...publicationFixture.uploads.imageOne,
          content: imageOneContent,
        },
        {
          ...publicationFixture.uploads.imageTwo,
          content: imageTwoContent,
        },
      ];
      const matchedUpload = uploadExpectations.find((upload) => upload.url === url);
      if (!matchedUpload) {
        throw new Error(`Unexpected axios upload URL: ${String(url)}`);
      }

      uploadedUrls.push(String(url));
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(matchedUpload.content);
      return axiosResponse({
        photos: {
          [matchedUpload.photoKey]: { token: matchedUpload.token },
        },
      });
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [
        maxPost({
          media: [
            { type: 'image', path: imageOne },
            { type: 'image', path: imageTwo },
          ],
        }),
      ],
      syntheticIntegration()
    );

    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=image`,
      `${MAX_API_BASE}/uploads?type=image`,
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
    expect(mockedAxiosPost().mock.calls.map(([url]) => String(url))).toEqual([
      publicationFixture.uploads.imageOne.url,
      publicationFixture.uploads.imageTwo.url,
    ]);
    expectNoTokenInUrls(calls);
  });

  it.each([
    { name: 'without photos', uploadBody: {} },
    { name: 'with empty photos', uploadBody: { photos: {} } },
    { name: 'with a photo key but no token', uploadBody: { photos: { key: {} } } },
  ])(
    'rejects image upload response $name before creating the message',
    async ({ uploadBody }) => {
      const imageContent = Buffer.concat([tinyPng(), Buffer.from('missing-photo-token')]);
      const imagePath = createTempMediaFile('max-missing-photo-token.png', imageContent);
      const { provider, calls } = providerWithFetchRecorder(async (request) => {
        if (isMaxUploadAllocation(request, 'image')) {
          return jsonResponse({ url: publicationFixture.uploads.imageOne.url });
        }

        if (isMaxMessageRequest(request)) {
          throw new Error('Message must not be created without image photo tokens');
        }

        throwUnexpectedRequest(request);
      });
      mockImageDimensions(provider);
      mockedAxiosPost().mockImplementation(async (url, form, config) => {
        const stream = expectAxiosUpload(url, form, config);
        expect(await readNodeReadable(stream)).toEqual(imageContent);
        return axiosResponse(uploadBody);
      });

      await expectPublicationRejectsWithoutLeaks(
        provider.post(
          SYNTHETIC_CHAT_ID,
          SYNTHETIC_TOKEN,
          [maxPost({ media: [{ type: 'image', path: imagePath }] })],
          syntheticIntegration()
        ),
        'MAX media upload did not return an attachment token.'
      );
      expect(calls.map((call) => call.url)).toEqual([
        `${MAX_API_BASE}/uploads?type=image`,
      ]);
      expect(mockedAxiosPost()).toHaveBeenCalledTimes(1);
    }
  );

  it('passes every returned MAX photo token key through to the image attachment payload', async () => {
    const imageContent = Buffer.concat([tinyPng(), Buffer.from('two-photo-keys')]);
    const imagePath = createTempMediaFile('max-two-photo-keys.png', imageContent);
    const photos = {
      [publicationFixture.uploads.imageOne.photoKey]: {
        token: publicationFixture.uploads.imageOne.token,
      },
      'synthetic-photo-key-extra==': {
        token: 'synthetic-image-photo-token-extra',
      },
    };
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'image')) {
        return jsonResponse({ url: publicationFixture.uploads.imageOne.url });
      }

      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'image',
              payload: { photos },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockImageDimensions(provider);
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(imageContent);
      return axiosResponse({ photos });
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'image', path: imagePath }] })],
      syntheticIntegration()
    );

    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=image`,
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
  });

  it.each([
    [
      'HTTP loopback',
      'http://127.0.0.1/max-upload?secret=max-private-upload-url-secret',
    ],
    [
      'canonical IPv4-mapped IPv6 loopback',
      'https://[::ffff:7f00:1]/max-upload?secret=max-private-upload-url-secret',
    ],
  ])(
    'rejects %s MAX upload allocation URLs before axios upload or message send',
    async (_case, privateUploadUrl) => {
      const imageContent = Buffer.concat([tinyPng(), Buffer.from('private-upload')]);
      const imagePath = createTempMediaFile(
        'max-private-upload-url.png',
        imageContent
      );
      const { provider, calls } = providerWithFetchRecorder(async (request) => {
        if (isMaxUploadAllocation(request, 'image')) {
          return jsonResponse({ url: privateUploadUrl });
        }

        if (isMaxMessageRequest(request)) {
          throw new Error('MAX message send must not run after a private upload URL');
        }

        throwUnexpectedRequest(request);
      });
      mockImageDimensions(provider);
      mockedAxiosPost().mockImplementation(async () => {
        throw new Error('axios upload must not run for a private MAX upload URL');
      });

      await expectPublicationRejectsWithoutLeaks(
        provider.post(
          SYNTHETIC_CHAT_ID,
          SYNTHETIC_TOKEN,
          [maxPost({ media: [{ type: 'image', path: imagePath }] })],
          syntheticIntegration()
        ),
        'MAX media upload URL must be public HTTPS.',
        [privateUploadUrl, 'max-private-upload-url-secret']
      );

      expect(mockedAxiosPost()).not.toHaveBeenCalled();
      expect(calls.map((call) => call.url)).toEqual([
        `${MAX_API_BASE}/uploads?type=image`,
      ]);
      expectNoTokenInUrls(calls);
    }
  );

  it('streams video through axios FormData, uses the allocation token, and ignores the XML upload response body', async () => {
    const videoContent = Buffer.from('synthetic max video bytes\n');
    const videoPath = createTempMediaFile('max-video.mp4', videoContent);
    forbidEagerFileReads(videoPath);
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(videoContent);
      return axiosResponse(publicationFixture.uploads.video.retval);
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'video', path: videoPath }] })],
      syntheticIntegration()
    );

    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=video`,
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
    expect(mockedAxiosPost()).toHaveBeenCalledTimes(1);
    expectNoTokenInUrls(calls);
  });

  it('treats an mp4 path marked as image by updateMedia as video without probing image dimensions', async () => {
    const videoPath = createSparseMediaFile(
      'max-update-media-synthetic-image.mp4',
      50 * MiB + 1
    );
    forbidEagerFileReads(videoPath);
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    const dimensionSpy = jest
      .spyOn(provider as unknown as ImageDimensionProbe, 'getImageDimensions')
      .mockRejectedValue(new Error('MAX mp4 media must not run image dimensions'));
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      destroyNodeStream(stream);
      return axiosResponse(publicationFixture.uploads.video.retval);
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'image', path: videoPath }] })],
      syntheticIntegration()
    );

    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=video`,
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
    expect(dimensionSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['mov', 'max-update-media-synthetic-image.mov'],
    ['webm', 'max-update-media-synthetic-image.webm'],
  ])('treats a %s path marked as image by updateMedia as video', async (_ext, name) => {
    const videoPath = createSparseMediaFile(name, 1024);
    forbidEagerFileReads(videoPath);
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      destroyNodeStream(stream);
      return axiosResponse(publicationFixture.uploads.video.retval);
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'image', path: videoPath }] })],
      syntheticIntegration()
    );

    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=video`,
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
  });

  it('rejects a media path whose extension maps to neither image nor video', async () => {
    const documentPath = createTempMediaFile(
      'max-unsupported-document.pdf',
      Buffer.from('synthetic max unsupported document bytes\n')
    );
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      throwUnexpectedRequest(request);
    });

    await expect(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost({ media: [{ type: 'image', path: documentPath }] })],
        syntheticIntegration()
      )
    ).rejects.toThrow('MAX supports image and video attachments only.');

    expect(calls).toHaveLength(0);
  });

  it('uses the allocation token for video even when the upload response body contains another token', async () => {
    const videoPath = createTempMediaFile(
      'max-video-upload-token.mp4',
      Buffer.from('synthetic max video upload token bytes\n')
    );
    const uploadBodyToken = 'synthetic-video-upload-body-token-ignored';
    const { provider } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      destroyNodeStream(stream);
      return axiosResponse({
        token: uploadBodyToken,
        retval: publicationFixture.uploads.video.retval,
      });
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'video', path: videoPath }] })],
      syntheticIntegration()
    );
  });

  it('rebuilds a fresh FormData body and a fresh file stream when a streamed upload is retried', async () => {
    const videoPath = createTempMediaFile(
      'max-video-retry.mp4',
      Buffer.from('synthetic retry video bytes\n')
    );
    const forms: unknown[] = [];
    const streams: NodeJS.ReadableStream[] = [];
    const { provider } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost()
      .mockImplementationOnce(async (url, form, config) => {
        forms.push(form);
        const stream = expectAxiosUpload(url, form, config);
        streams.push(stream);
        destroyNodeStream(stream);
        throw axiosResponseError(500, { code: 'temporarily.unavailable' });
      })
      .mockImplementationOnce(async (url, form, config) => {
        forms.push(form);
        const stream = expectAxiosUpload(url, form, config);
        streams.push(stream);
        expect(await readNodeReadable(stream)).toEqual(
          Buffer.from('synthetic retry video bytes\n')
        );
        return axiosResponse(publicationFixture.uploads.video.retval);
      });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'video', path: videoPath }] })],
      syntheticIntegration()
    );

    expect(mockedAxiosPost()).toHaveBeenCalledTimes(2);
    expect(forms[0]).not.toBe(forms[1]);
    expect(streams[0]).not.toBe(streams[1]);
  });

  it('streams remote media with a basename filename and known multipart length', async () => {
    const remotePath =
      'https://media.example.test/postiz/max/remote-video.mp4?signature=synthetic';
    const remoteContent = Buffer.from('synthetic remote max video bytes\n');
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        return jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    const mediaProbe = provider as unknown as MediaStreamProbe;
    const mediaSizeSpy = jest
      .spyOn(mediaProbe, 'mediaSize')
      .mockResolvedValue(remoteContent.length);
    const mediaStreamSpy = jest
      .spyOn(mediaProbe, 'mediaStream')
      .mockImplementation(async () => Readable.from(remoteContent));
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      expect(String(url)).toBe(publicationFixture.uploads.video.url);
      expect(form).toBeInstanceOf(FormDataUpload);
      const uploadForm = form as FormDataUpload;
      expect(uploadForm.hasKnownLength()).toBe(true);
      expect(uploadForm.getLengthSync()).toBeGreaterThan(remoteContent.length);
      expect(multipartHeaderForField(form, 'data')).toContain(
        'filename=\"remote-video.mp4\"'
      );
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(remoteContent);
      return axiosResponse(publicationFixture.uploads.video.retval);
    });

    await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'image', path: remotePath }] })],
      syntheticIntegration()
    );

    expect(mediaSizeSpy).toHaveBeenCalledWith(remotePath, 'max');
    expect(mediaStreamSpy).toHaveBeenCalledWith(remotePath, 'max');
    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=video`,
      `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`,
    ]);
  });

  it.each(['audio', 'file'] as const)(
    'rejects unsupported %s media before allocating an upload URL',
    async (type) => {
      const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);
      const unsupportedMedia = [
        { type, path: 'synthetic-media.bin' },
      ] as unknown as NonNullable<PostDetails['media']>;

      await expectPublicationRejectsWithoutLeaks(
        provider.post(
          SYNTHETIC_CHAT_ID,
          SYNTHETIC_TOKEN,
          [maxPost({ media: unsupportedMedia })],
          syntheticIntegration()
        ),
        'MAX supports image and video attachments only.'
      );
      expect(calls).toHaveLength(0);
    }
  );

  it('rejects an image larger than 50 MiB before allocation without reading the file body', async () => {
    const imagePath = createSparseMediaFile('max-too-large-image.png', 50 * MiB + 1);
    forbidEagerFileReads(imagePath);
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost({ media: [{ type: 'image', path: imagePath }] })],
        syntheticIntegration()
      ),
      'MAX image attachments must be 50 MiB or smaller.'
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects image dimensions above 7680x7680 before allocation', async () => {
    const imagePath = createTempMediaFile('max-oversized-dimensions.png', tinyPng());
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);
    mockImageDimensions(provider, { width: 7681, height: 7680 });

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost({ media: [{ type: 'image', path: imagePath }] })],
        syntheticIntegration()
      ),
      'MAX image attachments must be 7680x7680 px or smaller.'
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a video larger than 250 MiB before allocation without reading the file body', async () => {
    const videoPath = createSparseMediaFile('max-too-large-video.mp4', 250 * MiB + 1);
    forbidEagerFileReads(videoPath);
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost({ media: [{ type: 'video', path: videoPath }] })],
        syntheticIntegration()
      ),
      'MAX video attachments must be 250 MiB or smaller.'
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects publication without a bot token before any outbound request', async () => {
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);

    await expectPublicationRejectsWithoutLeaks(
      provider.post(SYNTHETIC_CHAT_ID, '', [maxPost()], syntheticIntegration()),
      'MAX requires a bot token before publication.'
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects multi-post publication before any outbound request', async () => {
    const { provider, calls } = providerWithFetchRecorder(throwUnexpectedRequest);

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost(), maxPost({ id: 'postiz-max-post-0002' })],
        syntheticIntegration()
      ),
      'MAX supports publishing exactly one post at a time.'
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects video allocation without a token before creating the message', async () => {
    const videoPath = createTempMediaFile(
      'max-tokenless-video.mp4',
      Buffer.from('synthetic tokenless video bytes\n')
    );
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({ url: publicationFixture.uploads.tokenlessVideo.url });
      }

      if (isMaxMessageRequest(request)) {
        throw new Error('Message must not be created without an attachment token');
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(
        Buffer.from('synthetic tokenless video bytes\n')
      );
      return axiosResponse(publicationFixture.uploads.tokenlessVideo.retval);
    });

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost({ media: [{ type: 'video', path: videoPath }] })],
        syntheticIntegration()
      ),
      'MAX media upload did not return an attachment token.'
    );
    expect(calls.map((call) => call.url)).toEqual([
      `${MAX_API_BASE}/uploads?type=video`,
    ]);
    expect(mockedAxiosPost()).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'string',
      uploadBody: '<html>synthetic upload host response</html>',
      extraSecrets: ['<html>synthetic upload host response</html>'],
    },
    {
      name: 'array',
      uploadBody: [{ token: publicationFixture.uploads.imageOne.token }],
      extraSecrets: [publicationFixture.uploads.imageOne.token],
    },
  ])(
    'rejects image upload response when the upload host returns a $name instead of an object',
    async ({ uploadBody, extraSecrets }) => {
      const imageContent = Buffer.concat([tinyPng(), Buffer.from('invalid-image-body')]);
      const imagePath = createTempMediaFile('max-invalid-image-upload-body.png', imageContent);
      const { provider, calls } = providerWithFetchRecorder(async (request) => {
        if (isMaxUploadAllocation(request, 'image')) {
          return jsonResponse({ url: publicationFixture.uploads.imageOne.url });
        }

        if (isMaxMessageRequest(request)) {
          throw new Error('Message must not be created after an invalid image upload body');
        }

        throwUnexpectedRequest(request);
      });
      mockImageDimensions(provider);
      mockedAxiosPost().mockImplementation(async (url, form, config) => {
        const stream = expectAxiosUpload(url, form, config);
        expect(await readNodeReadable(stream)).toEqual(imageContent);
        return axiosResponse(uploadBody);
      });

      await expectPublicationRejectsWithoutLeaks(
        provider.post(
          SYNTHETIC_CHAT_ID,
          SYNTHETIC_TOKEN,
          [maxPost({ media: [{ type: 'image', path: imagePath }] })],
          syntheticIntegration()
        ),
        'MAX media upload did not return a valid upload response.',
        extraSecrets
      );
      expect(calls.map((call) => call.url)).toEqual([
        `${MAX_API_BASE}/uploads?type=image`,
      ]);
      expect(mockedAxiosPost()).toHaveBeenCalledTimes(1);
    }
  );

  it('retries attachment.not.ready message responses and completes the publication', async () => {
    const videoContent = Buffer.from('synthetic not-ready video bytes\n');
    const videoPath = createTempMediaFile('max-not-ready-video.mp4', videoContent);
    let messageAttempts = 0;
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        messageAttempts += 1;
        expect(await requestJson(request)).toEqual({
          text: SYNTHETIC_FORMATTED_TEXT,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return messageAttempts === 1
          ? jsonResponse({ code: 'attachment.not.ready', message: '' }, 400)
          : jsonResponse(publicationFixture.sendMessage);
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(videoContent);
      return axiosResponse(publicationFixture.uploads.video.retval);
    });

    const result = await provider.post(
      SYNTHETIC_CHAT_ID,
      SYNTHETIC_TOKEN,
      [maxPost({ media: [{ type: 'video', path: videoPath }] })],
      syntheticIntegration()
    );

    expect(result[0]).toEqual(
      expect.objectContaining({
        postId: publicationFixture.sendMessage.message.body.mid,
        status: 'completed',
      })
    );
    expect(messageAttempts).toBe(2);
    expect(
      calls.filter(
        (call) => call.url === `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`
      )
    ).toHaveLength(2);
  });

  it('fails without leaking the post body or bot token when attachment.not.ready persists', async () => {
    const secretPostText = 'secret MAX post body for persistent not-ready retries';
    const videoContent = Buffer.from('synthetic persistent not-ready video bytes\n');
    const videoPath = createTempMediaFile('max-persistent-not-ready-video.mp4', videoContent);
    let messageAttempts = 0;
    const { provider, calls } = providerWithFetchRecorder(async (request) => {
      if (isMaxUploadAllocation(request, 'video')) {
        return jsonResponse({
          url: publicationFixture.uploads.video.url,
          token: publicationFixture.uploads.video.token,
        });
      }

      if (isMaxMessageRequest(request)) {
        messageAttempts += 1;
        expect(await requestJson(request)).toEqual({
          text: secretPostText,
          format: 'html',
          notify: true,
          attachments: [
            {
              type: 'video',
              payload: { token: publicationFixture.uploads.video.token },
            },
          ],
        });
        return jsonResponse({ code: 'attachment.not.ready', message: '' }, 400);
      }

      throwUnexpectedRequest(request);
    });
    mockedAxiosPost().mockImplementation(async (url, form, config) => {
      const stream = expectAxiosUpload(url, form, config);
      expect(await readNodeReadable(stream)).toEqual(videoContent);
      return axiosResponse(publicationFixture.uploads.video.retval);
    });

    await expectPublicationRejectsWithoutLeaks(
      provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [
          maxPost({
            message: `<p>${secretPostText}</p>`,
            media: [{ type: 'video', path: videoPath }],
          }),
        ],
        syntheticIntegration()
      ),
      'MAX is still processing the uploaded attachment.',
      [secretPostText, publicationFixture.uploads.video.token]
    );
    expect(messageAttempts).toBe(4);
    expect(
      calls.filter(
        (call) => call.url === `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}`
      )
    ).toHaveLength(4);
  });

  it.each([401, 403])(
    'treats %i message responses as non-retry reconnect failures',
    async (status) => {
      let messageAttempts = 0;
      const { provider } = providerWithFetchRecorder(async (request) => {
        if (isMaxMessageRequest(request)) {
          messageAttempts += 1;
          return jsonResponse({ code: 'auth.failed' }, status);
        }

        throwUnexpectedRequest(request);
      });

      await expectPublicationRejectsWithoutLeaks(
        provider.post(
          SYNTHETIC_CHAT_ID,
          SYNTHETIC_TOKEN,
          [maxPost()],
          syntheticIntegration()
        ),
        ERROR_RECONNECT_REQUIRED
      );
      expect(messageAttempts).toBe(1);
    }
  );

  it.each([429, 500])(
    'retries retryable %i message responses under the SocialAbstract fetch contract',
    async (status) => {
      let messageAttempts = 0;
      const { provider } = providerWithFetchRecorder(async (request) => {
        if (isMaxMessageRequest(request)) {
          messageAttempts += 1;
          return messageAttempts === 1
            ? jsonResponse({ code: 'temporarily.unavailable' }, status)
            : jsonResponse(publicationFixture.sendMessage);
        }

        throwUnexpectedRequest(request);
      });

      const result = await provider.post(
        SYNTHETIC_CHAT_ID,
        SYNTHETIC_TOKEN,
        [maxPost()],
        syntheticIntegration()
      );

      expect(messageAttempts).toBe(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          postId: publicationFixture.sendMessage.message.body.mid,
          status: 'completed',
        })
      );
    }
  );
});

function providerWithFetch(...responses: Response[]) {
  const provider = createProvider();
  const fetchMock = jest.spyOn(globalThis, 'fetch') as FetchMock;
  fetchMock.mockImplementation(async () => {
    throw new Error('Unexpected outbound request');
  });
  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));

  return { provider, fetchMock };
}

function encodeCredentials(
  overrides: Partial<{ token: string; chatId: string }> = {}
): string {
  return Buffer.from(
    JSON.stringify({
      token: SYNTHETIC_TOKEN,
      chatId: SYNTHETIC_CHAT_ID,
      ...overrides,
    })
  ).toString('base64');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function providerWithFetchRecorder(handler: FetchHandler) {
  const provider = createProvider();
  const calls: RecordedFetchCall[] = [];
  const fetchMock = jest.spyOn(globalThis, 'fetch') as FetchMock;
  fetchMock.mockImplementation(async (input, init) => {
    const request = recordFetch(input, init);
    calls.push(request);
    return handler(request, calls.length - 1);
  });

  return { provider, fetchMock, calls };
}

function recordFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): RecordedFetchCall {
  const request = input instanceof Request ? input : undefined;

  return {
    input,
    init,
    url: fetchUrl(input),
    method: init?.method ?? request?.method ?? 'GET',
    headers: init?.headers ?? request?.headers,
    body: init && 'body' in init ? init.body : request?.body,
  };
}

function requestDispatcher(request: RecordedFetchCall): unknown {
  if (!request.init || typeof request.init !== 'object') {
    return undefined;
  }

  return (request.init as RequestInit & { dispatcher?: unknown }).dispatcher;
}

function expectMaxDispatcher(request: RecordedFetchCall) {
  expect(requestDispatcher(request)).toBe(getMaxDispatcher());
}

function resolveWithLookup(
  lookupFactoryResult: unknown,
  hostname: string
): Promise<{ address: string; family: number }> {
  const lookup = lookupFactoryResult as DnsLookup;
  return new Promise((resolve, reject) => {
    lookup(hostname, {}, (err, address, family) => {
      if (err) {
        reject(err);
        return;
      }

      if (Array.isArray(address)) {
        resolve(address[0]);
        return;
      }

      resolve({ address, family });
    });
  });
}

function maxPost(overrides: Partial<PostDetails> = {}): PostDetails {
  return {
    id: SYNTHETIC_POST_ID,
    message: SYNTHETIC_TEXT,
    settings: {},
    ...overrides,
  };
}

function syntheticIntegration(): Integration {
  const integration = {
    id: 'integration-max-synthetic',
    internalId: SYNTHETIC_CHAT_ID,
    providerIdentifier: 'max',
    token: SYNTHETIC_TOKEN,
  };

  // Test fixture only needs the Integration fields read by MaxProvider.post.
  return integration as unknown as Integration;
}

function createTempMediaFile(name: string, content: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postiz-max-provider-'));
  tempMediaDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function createSparseMediaFile(name: string, size: number): string {
  const filePath = createTempMediaFile(name, Buffer.alloc(0));
  fs.truncateSync(filePath, size);
  return filePath;
}

function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
}

function mockImageDimensions(
  provider: MaxProviderContract,
  dimensions = { width: 1, height: 1 }
) {
  return jest
    .spyOn(provider as unknown as ImageDimensionProbe, 'getImageDimensions')
    .mockResolvedValue(dimensions);
}

function forbidEagerFileReads(mediaPath: string) {
  // readFileSync needs the runtime CommonJS fs module; promises is shared
  // through the ESM import, so that spy can stay on fs.promises.
  const runtimeFs = require('fs') as typeof fs;
  const originalReadFileSync = runtimeFs.readFileSync.bind(runtimeFs);
  jest.spyOn(runtimeFs, 'readFileSync').mockImplementation(
    ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (pathMatchesFile(file, mediaPath)) {
        throw new Error('MAX media upload must stream the file instead of reading it eagerly');
      }

      return originalReadFileSync(
        file,
        options as Parameters<typeof runtimeFs.readFileSync>[1]
      );
    }) as unknown as typeof runtimeFs.readFileSync
  );

  const originalReadFile = fs.promises.readFile.bind(fs.promises);
  jest.spyOn(fs.promises, 'readFile').mockImplementation(
    ((file: fs.PathLike | fs.promises.FileHandle, options?: unknown) => {
      if (pathMatchesFile(file, mediaPath)) {
        throw new Error('MAX media upload must stream the file instead of reading it eagerly');
      }

      return originalReadFile(
        file,
        options as Parameters<typeof fs.promises.readFile>[1]
      );
    }) as unknown as typeof fs.promises.readFile
  );
}

function pathMatchesFile(file: unknown, expectedPath: string): boolean {
  const actualPath =
    typeof file === 'string' || Buffer.isBuffer(file)
      ? file.toString()
      : file instanceof URL
      ? file.pathname
      : undefined;

  return actualPath ? path.resolve(actualPath) === path.resolve(expectedPath) : false;
}

function mockedAxiosPost(): AxiosPostMock {
  return axios.post as AxiosPostMock;
}

function axiosResponse(data: unknown): Awaited<ReturnType<typeof axios.post>> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  } as unknown as Awaited<ReturnType<typeof axios.post>>;
}

function axiosResponseError(status: number, data: unknown) {
  const error = new Error(UPLOAD_RETRY_ERROR) as Error & {
    response: { status: number; data: unknown };
  };
  error.response = { status, data };
  return error;
}

function expectAxiosUpload(
  url: unknown,
  form: unknown,
  config: unknown
): NodeJS.ReadableStream {
  expect(String(url)).toMatch(/^https:\/\/uploads\.example\.test\/max\//);
  expect(form).toBeInstanceOf(FormDataUpload);
  expect(uploadConfigHeader(config, 'Authorization')).toBeUndefined();
  expect(uploadConfigMaxBodyLength(config)).toBe(Infinity);
  expectMaxUploadTransportConfig(config);
  expect(uploadConfigHeader(config, 'authorization')).toBeUndefined();
  return expectNodeReadableMultipartField(form, 'data');
}

function uploadConfigHeader(config: unknown, name: string): unknown {
  if (!config || typeof config !== 'object') {
    return undefined;
  }
  const headers = (config as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    return getter.call(headers, name);
  }
  const entries = Object.entries(headers);
  return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function uploadConfigMaxBodyLength(config: unknown): unknown {
  if (!config || typeof config !== 'object' || !('maxBodyLength' in config)) {
    return undefined;
  }

  return config.maxBodyLength;
}

function expectMaxUploadTransportConfig(config: unknown) {
  expect(uploadConfigValue(config, 'httpsAgent')).toBe(getMaxHttpsAgent());
  expect(uploadConfigValue(config, 'maxRedirects')).toBe(0);
  expect(uploadConfigValue(config, 'proxy')).toBe(false);
}

function uploadConfigValue(config: unknown, name: string): unknown {
  if (!config || typeof config !== 'object' || !(name in config)) {
    return undefined;
  }

  return (config as Record<string, unknown>)[name];
}


function isMaxUploadAllocation(request: RecordedFetchCall, type: 'image' | 'video') {
  const isMatch =
    request.url === `${MAX_API_BASE}/uploads?type=${type}` && request.method === 'POST';
  if (isMatch) {
    expect(headerValue(request.headers, 'Authorization')).toBe(SYNTHETIC_TOKEN);
    expectMaxDispatcher(request);
  }
  return isMatch;
}

function isMaxMessageRequest(request: RecordedFetchCall) {
  const isMatch =
    request.url === `${MAX_API_BASE}/messages?chat_id=${SYNTHETIC_CHAT_ID}` &&
    request.method === 'POST';
  if (isMatch) {
    expect(headerValue(request.headers, 'Authorization')).toBe(SYNTHETIC_TOKEN);
    expectMaxDispatcher(request);
  }
  return isMatch;
}

function expectMaxApiCall(
  request: RecordedFetchCall,
  pathWithQuery: string,
  method: string
) {
  expect(request.url).toBe(`${MAX_API_BASE}${pathWithQuery}`);
  expect(request.method).toBe(method);
  expect(request.url).not.toContain(SYNTHETIC_TOKEN);
  expect(headerValue(request.headers, 'Authorization')).toBe(SYNTHETIC_TOKEN);
  expectMaxDispatcher(request);
}

async function requestJson(request: RecordedFetchCall): Promise<unknown> {
  const body = request.body;
  if (typeof body === 'string') {
    return JSON.parse(body);
  }
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString('utf8'));
  }
  if (body instanceof URLSearchParams) {
    return JSON.parse(body.toString());
  }
  if (body instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(body).toString('utf8'));
  }
  if (ArrayBuffer.isView(body)) {
    return JSON.parse(
      Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
    );
  }

  throw new Error('Expected request body to be JSON-serializable bytes');
}

function multipartFieldValues(body: unknown, fieldName: string): unknown[] {
  if (isLegacyMultipartBody(body)) {
    const values: unknown[] = [];
    body._streams.forEach((part, index) => {
      if (typeof part !== 'string' || !part.includes(`name="${fieldName}"`)) {
        return;
      }

      const value = body._streams
        .slice(index + 1)
        .find((candidate) => typeof candidate !== 'function');
      values.push(unwrapMultipartValue(value));
    });
    return values;
  }

  throw new Error('Expected form-data multipart body with inspectable _streams');
}

function multipartHeaderForField(body: unknown, fieldName: string): string {
  if (!isLegacyMultipartBody(body)) {
    throw new Error('Expected form-data multipart body with inspectable _streams');
  }

  const header = body._streams.find(
    (part) => typeof part === 'string' && part.includes(`name=\"${fieldName}\"`)
  );
  if (typeof header !== 'string') {
    throw new Error(`Expected multipart field header for ${fieldName}`);
  }

  return header;
}

function isLegacyMultipartBody(body: unknown): body is { _streams: unknown[] } {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const candidate = body as { _streams?: unknown };
  return Array.isArray(candidate._streams);
}

function unwrapMultipartValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const candidate = value as { source?: unknown };
  return candidate.source ?? value;
}

function expectNodeReadableMultipartField(
  body: unknown,
  fieldName: string
): NodeJS.ReadableStream {
  const values = multipartFieldValues(body, fieldName);
  expect(values).toHaveLength(1);
  const value = values[0];
  expect(value).not.toBeInstanceOf(Blob);
  expect(isNodeReadable(value)).toBe(true);
  return value as NodeJS.ReadableStream;
}

function isNodeReadable(value: unknown): value is NodeJS.ReadableStream {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { on?: unknown; pipe?: unknown };
  return typeof candidate.on === 'function' && typeof candidate.pipe === 'function';
}

function readNodeReadable(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream
      .on('data', (chunk: Buffer | string | Uint8Array) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      })
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
    (stream as { resume?: () => void }).resume?.();
  });
}

function destroyNodeStream(stream: NodeJS.ReadableStream) {
  const destroy = (stream as { destroy?: unknown }).destroy;
  if (typeof destroy === 'function') {
    destroy.call(stream);
  }
}

async function expectPublicationRejectsWithoutLeaks(
  promise: Promise<unknown>,
  message: string,
  extraSecrets: string[] = []
) {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }

  expect(error).toBeInstanceOf(Error);
  const thrown = error as Error;
  expect(thrown.message).toContain(message);
  expectNoLeak(thrown, extraSecrets);
  expectNoConsoleLeak(extraSecrets);
}

function expectNoTokenInUrls(calls: RecordedFetchCall[]) {
  calls.forEach((call) => expect(call.url).not.toContain(SYNTHETIC_TOKEN));
}

function throwUnexpectedRequest(request: RecordedFetchCall): never {
  throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
}

function validationRegex(validation: string): RegExp {
  const match = validation.match(/^\/(.*)\/([dgimsuvy]*)$/);
  if (!match) {
    throw new Error(`Expected validation to be a /regex/ string, got ${validation}`);
  }

  return new RegExp(match[1], match[2]);
}

function expectGetCalls(fetchMock: FetchMock, urls: string[]) {
  expect(fetchMock).toHaveBeenCalledTimes(urls.length);

  urls.forEach((url, index) => {
    const [actualInput, options] = fetchMock.mock.calls[index];
    const actualUrl = fetchUrl(actualInput);
    const request = actualInput instanceof Request ? actualInput : undefined;
    const method = options?.method ?? request?.method ?? 'GET';
    const headers = options?.headers ?? request?.headers;

    expect(actualUrl).toBe(url);
    expect(actualUrl).not.toContain(SYNTHETIC_TOKEN);
    expect(method).toBe('GET');
    expect(headerValue(headers, 'Authorization')).toBe(SYNTHETIC_TOKEN);
  });
}

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function headerValue(headers: HeadersInit | undefined, name: string) {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }

  const foundKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase()
  );
  return foundKey ? headers[foundKey as keyof typeof headers] : undefined;
}

function expectAuthError(result: unknown, message: string, extraSecrets: string[] = []) {
  expect(typeof result).toBe('string');
  expect(result).toBe(message);
  expectNoLeak(result, extraSecrets);
}

function expectNoConsoleLeak(extraSecrets: string[] = []) {
  const consoleOutput = consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map(stringifyForLeakCheck)
    .join('\n');

  expectNoLeak(consoleOutput, extraSecrets);
}

function expectNoLeak(value: unknown, extraSecrets: string[] = []) {
  const output = stringifyForLeakCheck(value);

  [SYNTHETIC_TOKEN, ...extraSecrets]
    .filter((secret) => secret.length > 0)
    .forEach((secret) => expect(output).not.toContain(secret));
}

function stringifyForLeakCheck(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_err) {
    return String(value);
  }
}

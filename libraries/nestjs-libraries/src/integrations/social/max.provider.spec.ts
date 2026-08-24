import { MaxProvider } from './max.provider';

const MAX_API_BASE = 'https://platform-api2.max.ru';
const SYNTHETIC_TOKEN = 'max_synthetic_token_for_tests_0000000000000000000000';
const SYNTHETIC_CHAT_ID = '-1001234567890';
const CHANNEL_ICON_URL = 'https://cdn.example.test/max/channel-icon.png';
const BOT_AVATAR_URL = 'https://cdn.example.test/max/bot-avatar-small.png';
const BOT_FULL_AVATAR_URL = 'https://cdn.example.test/max/bot-avatar-full.png';

type FetchMock = jest.MockedFunction<
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
>;

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
};

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

beforeEach(() => {
  consoleSpies = CONSOLE_METHODS.map((method) =>
    jest.spyOn(console, method).mockImplementation()
  );
});

afterEach(() => {
  jest.restoreAllMocks();
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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

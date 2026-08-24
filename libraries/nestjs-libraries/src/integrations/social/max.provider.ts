import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Integration } from '@prisma/client';

const MAX_API_BASE = 'https://platform-api2.max.ru';
const MAX_INT64_MIN_ABS = '9223372036854775808';
const MAX_INT64_MAX = '9223372036854775807';
const MAX_CHAT_ID_VALIDATION =
  '/^(?:0|-9223372036854775808|-?(?:[1-9]\\d{0,17}|[1-8]\\d{18}|9[01]\\d{17}|92[01]\\d{16}|922[0-2]\\d{15}|9223[0-2]\\d{14}|92233[0-6]\\d{13}|922337[01]\\d{12}|92233720[0-2]\\d{10}|922337203[0-5]\\d{9}|9223372036[0-7]\\d{8}|92233720368[0-4]\\d{7}|922337203685[0-3]\\d{6}|9223372036854[0-6]\\d{5}|92233720368547[0-6]\\d{4}|922337203685477[0-4]\\d{3}|9223372036854775[0-7]\\d{2}|922337203685477580[0-7]))$/';

const ERROR_INVALID_BASE64 = 'MAX connection payload must be valid base64.';
const ERROR_INVALID_JSON = 'MAX connection payload must be valid JSON.';
const ERROR_INVALID_CHAT_ID = 'MAX channel chat_id must be a signed int64.';
const ERROR_INVALID_TOKEN = 'MAX bot token was rejected by MAX.';
const ERROR_NOT_CHANNEL = 'MAX chat_id must point to a channel.';
const ERROR_INACTIVE_CHANNEL = 'MAX channel must be active.';
const ERROR_NOT_ADMIN = 'MAX bot must be an administrator of the channel.';
const ERROR_MISSING_WRITE_PERMISSION =
  'MAX bot administrator must have the write permission.';
const ERROR_RECONNECT_REQUIRED =
  'MAX authentication has expired, please reconnect the MAX channel.';
const ERROR_PUBLICATION_UNSUPPORTED =
  'MAX publication is not implemented yet.';

type MaxCredentials = {
  token: string;
  chatId: string;
};

type MaxBot = {
  user_id?: number | string;
  first_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
  full_avatar_url?: string | null;
};

type MaxChannel = {
  chat_id?: number | string;
  type?: string | null;
  status?: string | null;
  title?: string | null;
  icon?: { url?: string | null } | null;
};

type MaxMembership = {
  is_admin?: boolean | null;
  permissions?: string[] | null;
};

export class MaxProvider extends SocialAbstract implements SocialProvider {
  identifier = 'max';
  name = 'MAX';
  editor = 'html' as const;
  isBetweenSteps = false;
  scopes = [] as string[];
  override maxConcurrentJob = 1;
  secureCustomFields = true;

  maxLength() {
    return 4000;
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  async customFields() {
    return [
      {
        key: 'token',
        label: 'MAX bot token',
        validation: '/.+/',
        type: 'password' as const,
      },
      {
        key: 'chatId',
        label: 'MAX channel chat_id',
        validation: MAX_CHAT_ID_VALIDATION,
        type: 'text' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    const parsed = this.parseCredentials(params.code);
    if (typeof parsed === 'string') {
      return parsed;
    }

    const token = parsed.token.trim();
    const chatId = parsed.chatId.trim();

    if (!token) {
      return ERROR_INVALID_TOKEN;
    }

    if (!this.isSignedInt64(chatId)) {
      return ERROR_INVALID_CHAT_ID;
    }

    const bot = await this.maxGet<MaxBot>('/me', token);
    if (!bot) {
      return ERROR_INVALID_TOKEN;
    }

    const channel = await this.maxGet<MaxChannel>(`/chats/${chatId}`, token);
    if (!channel || channel.type !== 'channel') {
      return ERROR_NOT_CHANNEL;
    }

    if (channel.status !== 'active') {
      return ERROR_INACTIVE_CHANNEL;
    }

    const membership = await this.maxGet<MaxMembership>(
      `/chats/${chatId}/members/me`,
      token
    );

    if (!membership?.is_admin) {
      return ERROR_NOT_ADMIN;
    }

    if (!membership.permissions?.includes('write')) {
      return ERROR_MISSING_WRITE_PERMISSION;
    }

    return {
      accessToken: token,
      id: String(channel.chat_id ?? chatId),
      name: channel.title || chatId,
      picture: channel.icon?.url || bot.avatar_url || bot.full_avatar_url || '',
      username: bot.username || bot.first_name || 'MAX bot',
    };
  }

  async refreshToken(): Promise<AuthTokenDetails> {
    throw new BadBody(this.identifier, '{}', '{}', ERROR_RECONNECT_REQUIRED);
  }

  override handleErrors(
    body: string,
    status: number
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined {
    if (status === 401 || status === 403) {
      return {
        type: 'bad-body',
        value: ERROR_RECONNECT_REQUIRED,
      };
    }

    return undefined;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    throw new BadBody(
      this.identifier,
      '{}',
      '{}',
      ERROR_PUBLICATION_UNSUPPORTED
    );
  }

  private parseCredentials(code: string): MaxCredentials | string {
    if (!this.isCanonicalStandardBase64(code)) {
      return ERROR_INVALID_BASE64;
    }

    let decoded: string;
    try {
      decoded = Buffer.from(code, 'base64').toString('utf8');
    } catch (err) {
      return ERROR_INVALID_BASE64;
    }

    let body: unknown;
    try {
      body = JSON.parse(decoded);
    } catch (err) {
      return ERROR_INVALID_JSON;
    }

    if (!body || typeof body !== 'object') {
      return ERROR_INVALID_JSON;
    }

    const credentials = body as Partial<Record<keyof MaxCredentials, unknown>>;
    return {
      token: typeof credentials.token === 'string' ? credentials.token : '',
      chatId: typeof credentials.chatId === 'string' ? credentials.chatId : '',
    };
  }

  private isCanonicalStandardBase64(value: string) {
    if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
      return false;
    }

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || /=[^=]/.test(value)) {
      return false;
    }

    return Buffer.from(value, 'base64').toString('base64') === value;
  }

  private isSignedInt64(value: string) {
    if (!/^(?:0|-?[1-9]\d*)$/.test(value)) {
      return false;
    }

    const unsignedValue = value.startsWith('-') ? value.slice(1) : value;
    if (unsignedValue.length < MAX_INT64_MAX.length) {
      return true;
    }

    if (unsignedValue.length > MAX_INT64_MAX.length) {
      return false;
    }

    return value.startsWith('-')
      ? unsignedValue <= MAX_INT64_MIN_ABS
      : unsignedValue <= MAX_INT64_MAX;
  }

  private async maxGet<T>(path: string, token: string): Promise<T | undefined> {
    let response: Response;
    try {
      response = await fetch(`${MAX_API_BASE}${path}`, {
        method: 'GET',
        headers: {
          Authorization: token,
        },
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
      });
    } catch (err) {
      return undefined;
    }

    if (!response.ok) {
      return undefined;
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      return undefined;
    }
  }
}

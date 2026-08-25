import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { MAX_TEXT_LIMIT } from '@gitroom/helpers/utils/max.limits';
import {
  BadBody,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { isBlockedIp } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import mime from 'mime';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Integration } from '@prisma/client';
import axios from 'axios';
import FormDataUpload from 'form-data';
import net from 'node:net';
import { getMaxDispatcher, getMaxHttpsAgent } from './max.tls';
import { MaxFormatError, MaxHtml, maxVisibleLength, toMaxHtml } from './max.html';

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
const MAX_IMAGE_SIZE_LIMIT = 50 * 1024 * 1024;
const MAX_VIDEO_SIZE_LIMIT = 250 * 1024 * 1024;
const MAX_IMAGE_DIMENSION_LIMIT = 7680;
const ERROR_SINGLE_POST_REQUIRED =
  'MAX supports publishing exactly one post at a time.';
const ERROR_MISSING_BOT_TOKEN = 'MAX requires a bot token before publication.';
const ERROR_UNSUPPORTED_MEDIA =
  'MAX supports image and video attachments only.';
const ERROR_IMAGE_TOO_LARGE =
  'MAX image attachments must be 50 MiB or smaller.';
const ERROR_IMAGE_DIMENSIONS_TOO_LARGE =
  'MAX image attachments must be 7680x7680 px or smaller.';
const ERROR_VIDEO_TOO_LARGE =
  'MAX video attachments must be 250 MiB or smaller.';
const ERROR_MISSING_UPLOAD_URL =
  'MAX media upload allocation did not return an upload URL.';
const ERROR_MISSING_ATTACHMENT_TOKEN =
  'MAX media upload did not return an attachment token.';
const ERROR_INVALID_MESSAGE_RESPONSE =
  'MAX did not return a valid message response.';
const ERROR_INVALID_UPLOAD_RESPONSE =
  'MAX media upload did not return a valid upload response.';
const ERROR_INVALID_UPLOAD_URL = 'MAX media upload URL must be public HTTPS.';
const ERROR_ATTACHMENT_NOT_READY =
  'MAX is still processing the uploaded attachment.';
const ERROR_MESSAGE_TOO_LONG = 'MAX message exceeds the text limit.';

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

type MaxMediaType = 'image' | 'video';

type MaxUploadAllocationResponse = {
  url?: string;
  token?: string;
};

// Ответ сервера загрузки различается по типу вложения (проверено живым API 25.08):
// image → {"photos":{"<key>":{"token":"…"}}}, video → XML `<retval>1</retval>`,
// а токен видео приходит ещё в allocation. Поэтому разбираем ответ по типу, а не
// ищем единое поле token.
type MaxPhotoTokens = Record<string, { token: string }>;

type MaxUploadResponse = {
  photos?: unknown;
};

type MaxAttachment =
  | { type: 'image'; payload: { photos: MaxPhotoTokens } }
  | { type: 'video'; payload: { token: string } };

type MaxValidatedMedia = {
  media: NonNullable<PostDetails['media']>[number];
  type: MaxMediaType;
  size: number;
};

type MaxSendMessageResponse = {
  message?: {
    body?: { mid?: string | number };
    url?: string | null;
  };
};

export class MaxProvider extends SocialAbstract implements SocialProvider {
  identifier = 'max';
  name = 'MAX';
  editor = 'html' as const;
  rawEditorContent = true;
  visibleLength = (content: string) => maxVisibleLength(content);
  isBetweenSteps = false;
  scopes = [] as string[];
  override maxConcurrentJob = 1;
  secureCustomFields = true;

  maxLength(_additionalSettings?: unknown, _hasMedia?: boolean) {
    // У MAX нет отдельного caption для медиа: всегда действует один лимит text.
    return MAX_TEXT_LIMIT;
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
      id: chatId,
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

    // MAX обрабатывает загруженное видео асинхронно и до готовности отвечает
    // `attachment.not.ready` на отправку сообщения. Повтор здесь безопасен:
    // сообщение ещё не создано, а SocialAbstract.fetch даёт три попытки с паузой.
    if (body.includes('attachment.not.ready')) {
      return {
        type: 'retry',
        value: ERROR_ATTACHMENT_NOT_READY,
      };
    }

    return undefined;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    _integration: Integration
  ): Promise<PostResponse[]> {
    if (postDetails.length !== 1) {
      throw new BadBody(this.identifier, '{}', '{}', ERROR_SINGLE_POST_REQUIRED);
    }

    const botToken = accessToken.trim();
    if (!botToken) {
      throw new BadBody(this.identifier, '{}', '{}', ERROR_MISSING_BOT_TOKEN);
    }

    const [firstPost] = postDetails;
    // Формат и длину проверяем до медиа, чтобы не загружать вложения для заведомо отклонённого текста.
    const { html, length } = this.formatMessage(firstPost.message || '');
    if (length > MAX_TEXT_LIMIT) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        this.lengthError(MAX_TEXT_LIMIT, length)
      );
    }

    const media = await this.validateMedia(firstPost.media || []);

    const attachments: MaxAttachment[] = [];
    for (const item of media) {
      attachments.push(await this.uploadMedia(item, botToken));
    }

    const body: {
      text: string;
      format: 'html';
      notify: true;
      attachments?: MaxAttachment[];
    } = {
      text: html,
      format: 'html',
      notify: true,
    };

    if (attachments.length > 0) {
      body.attachments = attachments;
    }

    const response = (await (
      await this.fetch(
        `${MAX_API_BASE}/messages?chat_id=${encodeURIComponent(id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: botToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          // @ts-ignore - undici-only option; MAX uses scoped pinned Russian root CA transport
          dispatcher: getMaxDispatcher(),
        },
        this.identifier
      )
    ).json()) as MaxSendMessageResponse;

    const mid = response.message?.body?.mid;
    const releaseURL =
      typeof response.message?.url === 'string' ? response.message.url : '';
    if (typeof mid !== 'string' && typeof mid !== 'number') {
      throw new BadBody(this.identifier, '{}', '{}', ERROR_INVALID_MESSAGE_RESPONSE);
    }

    return [
      {
        id: firstPost.id,
        postId: String(mid),
        releaseURL,
        status: 'completed',
      },
    ];
  }

  private formatMessage(editorHtml: string): MaxHtml {
    try {
      return toMaxHtml(editorHtml);
    } catch (error: unknown) {
      if (error instanceof MaxFormatError) {
        throw new BadBody(this.identifier, '{}', '{}', error.message);
      }

      throw error;
    }
  }

  private lengthError(limit: number, length: number): string {
    return `${ERROR_MESSAGE_TOO_LONG} Limit: ${limit}, actual: ${length}.`;
  }

  private async validateMedia(
    media: NonNullable<PostDetails['media']>
  ): Promise<MaxValidatedMedia[]> {
    const validatedMedia: MaxValidatedMedia[] = [];
    for (const item of media) {
      const type = this.resolveMediaType(item);
      if (!type) {
        throw new BadBody(this.identifier, '{}', '{}', ERROR_UNSUPPORTED_MEDIA);
      }

      const size = await this.mediaSize(item.path, this.identifier);
      if (type === 'image') {
        if (size > MAX_IMAGE_SIZE_LIMIT) {
          throw new BadBody(this.identifier, '{}', '{}', ERROR_IMAGE_TOO_LARGE);
        }

        const dimensions = await this.getImageDimensions(item.path);
        if (
          dimensions.width > MAX_IMAGE_DIMENSION_LIMIT ||
          dimensions.height > MAX_IMAGE_DIMENSION_LIMIT
        ) {
          throw new BadBody(
            this.identifier,
            '{}',
            '{}',
            ERROR_IMAGE_DIMENSIONS_TOO_LARGE
          );
        }
      } else if (size > MAX_VIDEO_SIZE_LIMIT) {
        throw new BadBody(this.identifier, '{}', '{}', ERROR_VIDEO_TOO_LARGE);
      }

      validatedMedia.push({ media: item, type, size });
    }

    return validatedMedia;
  }

  private async uploadMedia(
    item: MaxValidatedMedia,
    botToken: string
  ): Promise<MaxAttachment> {
    const { media, type, size } = item;
    const allocation = (await (
      await this.fetch(
        `${MAX_API_BASE}/uploads?type=${type}`,
        {
          method: 'POST',
          headers: {
            Authorization: botToken,
          },
          // @ts-ignore - undici-only option; MAX uses scoped pinned Russian root CA transport
          dispatcher: getMaxDispatcher(),
        },
        this.identifier
      )
    ).json()) as MaxUploadAllocationResponse;

    const uploadUrl = allocation.url;
    if (!uploadUrl) {
      throw new BadBody(this.identifier, '{}', '{}', ERROR_MISSING_UPLOAD_URL);
    }

    if (!this.isPublicHttpsUploadUrl(uploadUrl)) {
      throw new BadBody(this.identifier, '{}', '{}', ERROR_INVALID_UPLOAD_URL);
    }

    const uploadResponse = await this.runStreamedUpload<unknown>(async () => {
      const stream = await this.mediaStream(media.path, this.identifier);
      const form = new FormDataUpload();
      form.append('data', stream, {
        filename: this.mediaFilename(media.path),
        knownLength: size,
      });

      const { data } = await axios.post(uploadUrl, form, {
        headers: form.getHeaders(),
        httpsAgent: getMaxHttpsAgent(),
        maxBodyLength: Infinity,
        maxRedirects: 0,
        proxy: false,
      });

      return data;
    }, this.identifier);

    if (type === 'video') {
      // Тело ответа для видео — XML `<retval>1</retval>`, парсить нечего:
      // токен выдаётся ещё в allocation.
      const token = allocation.token;
      if (typeof token !== 'string' || token.length === 0) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          ERROR_MISSING_ATTACHMENT_TOKEN
        );
      }

      return { type, payload: { token } };
    }

    return { type, payload: { photos: this.parsePhotoTokens(uploadResponse) } };
  }

  private parsePhotoTokens(uploadResponse: unknown): MaxPhotoTokens {
    if (
      !uploadResponse ||
      typeof uploadResponse !== 'object' ||
      Array.isArray(uploadResponse)
    ) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        ERROR_INVALID_UPLOAD_RESPONSE
      );
    }

    const { photos } = uploadResponse as MaxUploadResponse;
    if (!photos || typeof photos !== 'object' || Array.isArray(photos)) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        ERROR_MISSING_ATTACHMENT_TOKEN
      );
    }

    const entries = Object.entries(photos as Record<string, unknown>);
    if (entries.length === 0) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        ERROR_MISSING_ATTACHMENT_TOKEN
      );
    }

    const tokens: MaxPhotoTokens = {};
    for (const [key, value] of entries) {
      const token =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as { token?: unknown }).token
          : undefined;

      if (typeof token !== 'string' || token.length === 0) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          ERROR_MISSING_ATTACHMENT_TOKEN
        );
      }

      tokens[key] = { token };
    }

    return tokens;
  }

  private resolveMediaType(
    media: NonNullable<PostDetails['media']>[number]
  ): MaxMediaType | undefined {
    if (media.type === 'video') {
      return 'video';
    }

    // `updateMedia` в общем пайплайне помечает ВСЕ вложения как `image`, поэтому
    // настоящий тип определяется по расширению. Telegram-провайдер для того же
    // делает `mime.getType`, здесь та же логика: иначе .mov или .webm уехали бы
    // в MAX как картинка.
    if (media.type === 'image') {
      const mimeType = mime.getType(media.path.split('?')[0]);

      if (mimeType?.startsWith('video/')) {
        return 'video';
      }

      if (mimeType?.startsWith('image/')) {
        return 'image';
      }

      return undefined;
    }

    return undefined;
  }

  private mediaFilename(mediaPath: string) {
    const withoutQuery = mediaPath.split('?')[0];
    return withoutQuery.split('/').pop() || 'media';
  }

  private isPublicHttpsUploadUrl(value: string) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }

    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost') {
      return false;
    }

    const literalIpFamily = net.isIP(hostname);
    return !literalIpFamily || !isBlockedIp(hostname);
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
        // @ts-ignore - undici-only option; MAX uses scoped pinned Russian root CA transport
        dispatcher: getMaxDispatcher(),
      });
    } catch (err) {
      return undefined;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      return undefined;
    }
  }
}

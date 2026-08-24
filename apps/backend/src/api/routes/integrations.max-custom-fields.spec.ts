import 'reflect-metadata';

jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {
    getAllowedSocialsIntegrations(): string[] {
      return [];
    }

    getSocialIntegration(): undefined {
      return undefined;
    }

    async getAllIntegrations(): Promise<{
      social: Array<{
        identifier: string;
        name: string;
        customFields?: Array<{
          key: string;
          label: string;
          validation: string;
          type: 'text' | 'password';
        }>;
        secureCustomFields?: boolean;
      }>;
      article: unknown[];
    }> {
      return {
        social: [
          {
            identifier: 'max',
            name: 'MAX',
            customFields: [
              {
                key: 'token',
                label: 'Bot token',
                validation: '/^.+$/',
                type: 'password',
              },
              {
                key: 'chatId',
                label: 'Channel chat ID',
                validation: '/^-?\\d+$/',
                type: 'text',
              },
            ],
            secureCustomFields: true,
          },
          {
            identifier: 'legacy-custom-fields',
            name: 'Legacy custom fields',
            customFields: [
              {
                key: 'apiKey',
                label: 'API key',
                validation: '/^.+$/',
                type: 'password',
              },
            ],
          },
        ],
        article: [] as unknown[],
      };
    }
  },
  socialIntegrationList: [],
}));

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({
    IntegrationService: class IntegrationService {},
  })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({
    PostsService: class PostsService {},
  })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({
    OrganizationService: class OrganizationService {},
  })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/subscriptions/pricing',
  () => ({
    pricing: { FREE: { channel: 0 } },
  })
);

jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({
    RefreshIntegrationService: class RefreshIntegrationService {},
  })
);

jest.mock(
  '@gitroom/nestjs-libraries/integrations/social/telegram.provider',
  () => ({
    TelegramProvider: class TelegramProvider {},
  })
);

jest.mock(
  '@gitroom/nestjs-libraries/integrations/social/moltbook.provider',
  () => ({
    MoltbookProvider: class MoltbookProvider {},
  })
);

jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: {
    fixedEncryption: jest.fn((value: unknown): string => String(value)),
    signJWT: jest.fn((): string => 'task-4-jwt'),
    verifyJWT: jest.fn((): Record<string, unknown> => ({})),
  },
}));

jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  getSsrfSafeDispatcher: (): undefined => undefined,
}));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IntegrationsController } from './integrations.controller';
import { NoAuthIntegrationsController } from './no.auth.integrations.controller';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import type {
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

const MAX_VALUES = {
  token: 'xbot.synthetic.secret.>plus-risk',
  chatId: '-1001234567890',
};

const MAX_CUSTOM_FIELDS = [
  {
    key: 'token',
    label: 'Bot token',
    validation: '/^.+$/',
    type: 'password' as const,
  },
  {
    key: 'chatId',
    label: 'Channel chat ID',
    validation: '/^-?\\d+$/',
    type: 'text' as const,
  },
];

type RecordedRedisOperation =
  | { op: 'get'; key: string }
  | { op: 'set'; key: string; value: unknown; args: unknown[] }
  | { op: 'getdel'; key: string }
  | { op: 'del'; key: string }
  | { op: 'authenticate' };

class RecordingRedis {
  readonly data = new Map<string, string>();
  readonly operations: RecordedRedisOperation[] = [];

  seed(values: Record<string, string>) {
    this.data.clear();
    this.operations.length = 0;
    for (const [key, value] of Object.entries(values)) {
      this.data.set(key, value);
    }
  }

  async get(key: string) {
    this.operations.push({ op: 'get', key });
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: unknown, ...args: unknown[]) {
    this.operations.push({ op: 'set', key, value, args });
    this.data.set(key, String(value));
    return 'OK';
  }

  async getdel(key: string) {
    this.operations.push({ op: 'getdel', key });
    const value = this.data.get(key) ?? null;
    this.data.delete(key);
    return value;
  }

  async del(...keys: string[]) {
    for (const key of keys) {
      this.operations.push({ op: 'del', key });
      this.data.delete(key);
    }
    return keys.length;
  }

  setOperation(key: string) {
    return this.operations.find(
      (operation): operation is Extract<RecordedRedisOperation, { op: 'set' }> =>
        operation.op === 'set' && operation.key === key
    );
  }

  operationIndex(op: RecordedRedisOperation['op'], key?: string) {
    return this.operations.findIndex(
      (operation) =>
        operation.op === op &&
        (!key || ('key' in operation && operation.key === key))
    );
  }
}

const redis = new RecordingRedis();

let consoleLog: jest.SpyInstance<void, Parameters<typeof console.log>>;
let consoleError: jest.SpyInstance<void, Parameters<typeof console.error>>;

type RedisRecorderTarget = {
  get(key: string): Promise<string | null>;
  set(key: string, value: unknown, ...args: unknown[]): Promise<string>;
  del(...keys: string[]): Promise<number>;
  getdel?: (key: string) => Promise<string | null>;
};

function installRedisRecorder() {
  const target = ioRedis as unknown as RedisRecorderTarget;
  jest.spyOn(target, 'get').mockImplementation(redis.get.bind(redis));
  jest.spyOn(target, 'set').mockImplementation(redis.set.bind(redis));
  jest.spyOn(target, 'del').mockImplementation(redis.del.bind(redis));
  Object.defineProperty(target, 'getdel', {
    value: jest.fn(redis.getdel.bind(redis)),
    configurable: true,
    writable: true,
  });
}

function assertSecretNeverLeaked(...values: string[]) {
  const logs = [...consoleLog.mock.calls, ...consoleError.mock.calls]
    .flat()
    .map(String)
    .join('\n');

  for (const value of values) {
    expect(logs).not.toContain(value);
  }
}

type MockProvider = {
  identifier: string;
  name: string;
  editor: string;
  isBetweenSteps: boolean;
  scopes: string[];
  oneTimeToken: boolean;
  secureCustomFields?: boolean;
  customFields: jest.MockedFunction<NonNullable<SocialProvider['customFields']>>;
  authenticate: jest.MockedFunction<SocialProvider['authenticate']>;
};

const createAuthenticateMock = (
  implementation: SocialProvider['authenticate'] = async (): Promise<AuthTokenDetails> => ({
    accessToken: 'provider-access-token',
    refreshToken: 'provider-refresh-token',
    expiresIn: 3600,
    id: MAX_VALUES.chatId,
    name: 'Synthetic MAX channel',
    picture: '',
    username: 'synthetic-max',
    additionalSettings: [],
  })
) => jest.fn(implementation) as jest.MockedFunction<SocialProvider['authenticate']>;

function createProvider(overrides: Partial<MockProvider> = {}): MockProvider {
  return {
    identifier: 'max',
    name: 'MAX',
    editor: 'normal',
    isBetweenSteps: false,
    scopes: [],
    oneTimeToken: true,
    secureCustomFields: true,
    customFields: jest.fn(async () => MAX_CUSTOM_FIELDS) as jest.MockedFunction<
      NonNullable<SocialProvider['customFields']>
    >,
    authenticate: createAuthenticateMock(),
    ...overrides,
  };
}

function createManager(providers: Record<string, MockProvider>) {
  return {
    getAllowedSocialsIntegrations: jest.fn(() => Object.keys(providers)),
    getSocialIntegration: jest.fn((identifier: string) => providers[identifier]),
    getAllIntegrations: jest.fn(async () => ({
      social: Object.values(providers).map((provider) => ({
        identifier: provider.identifier,
        name: provider.name,
        customFields: MAX_CUSTOM_FIELDS,
        ...(provider.secureCustomFields
          ? { secureCustomFields: provider.secureCustomFields }
          : {}),
      })),
      article: [],
    })),
  };
}

async function createAuthenticatedApp(
  providers: Record<string, MockProvider>,
  orgId = 'org-current'
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [IntegrationsController],
    providers: [
      {
        provide: IntegrationManager,
        useValue: createManager(providers) as unknown as IntegrationManager,
      },
      { provide: IntegrationService, useValue: {} as unknown as IntegrationService },
      { provide: PostsService, useValue: {} as unknown as PostsService },
      {
        provide: RefreshIntegrationService,
        useValue: {} as unknown as RefreshIntegrationService,
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use((req: unknown, _res: unknown, next: () => void) => {
    const request = req as { org?: { id: string } };
    request.org = { id: orgId };
    next();
  });
  await app.listen(0);
  return app;
}

async function postJson(app: INestApplication, path: string, body: unknown) {
  const response = await fetch(`${await app.getUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

function createCallbackBody(values: Record<string, string>) {
  return values as unknown as Parameters<
    NoAuthIntegrationsController['connectSocialMedia']
  >[1];
}

function createCallbackController(provider: MockProvider) {
  const integrationService = {
    checkPreviousConnections: jest.fn(async () => false),
    createOrUpdateIntegration: jest.fn(async () => ({
      id: 'integration-id',
      providerIdentifier: 'max',
      internalId: MAX_VALUES.chatId,
      name: 'Synthetic MAX channel',
      token: 'server-side-access-token',
      refreshToken: 'server-side-refresh-token',
      customInstanceDetails: 'server-side-custom-fields',
    })),
  };

  const refreshIntegrationService = {
    startRefreshWorkflow: jest.fn(() => Promise.resolve()),
  };
  const organizationService = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      isTrailing: false,
      apiKey: 'org-api-key',
    })),
  };

  const controller = new NoAuthIntegrationsController(
    createManager({ max: provider }) as unknown as IntegrationManager,
    integrationService as unknown as IntegrationService,
    refreshIntegrationService as unknown as RefreshIntegrationService,
    organizationService as unknown as OrganizationService
  );

  return { controller, integrationService };
}

describe('MAX secure custom-field transport contracts', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    installRedisRecorder();
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    redis.seed({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes MAX as the only secure custom-field social integration in IntegrationManager metadata', async () => {
    const payload = await new IntegrationManager().getAllIntegrations();

    const max = payload.social.find((integration) => integration.identifier === 'max');
    expect(max).toMatchObject({
      identifier: 'max',
      secureCustomFields: true,
    });

    for (const integration of payload.social) {
      if (integration.identifier !== 'max' && 'customFields' in integration) {
        const metadata = integration as { secureCustomFields?: boolean };
        expect(metadata.secureCustomFields).toBeFalsy();
      }
    }
  });

  it('rejects staging credentials into a state owned by another organization before storing or logging secrets', async () => {
    redis.seed({ 'organization:foreign-state': 'org-other' });
    const app = await createAuthenticatedApp({ max: createProvider() }, 'org-current');

    try {
      const response = await postJson(
        app,
        '/integrations/social/max/custom-fields',
        { state: 'foreign-state', values: MAX_VALUES }
      );

      expect(response.status).not.toBe(404);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(redis.setOperation('custom-fields:foreign-state')).toBeUndefined();
      expect(response.body).not.toContain(MAX_VALUES.token);
      expect(response.body).not.toContain(MAX_VALUES.chatId);
      assertSecretNeverLeaked(MAX_VALUES.token, MAX_VALUES.chatId);
    } finally {
      await app.close();
    }
  });

  it('requires provider opt-in before accepting custom-field staging', async () => {
    redis.seed({ 'organization:legacy-state': 'org-current' });
    const legacyProvider = createProvider({
      identifier: 'legacy',
      secureCustomFields: false,
    });
    const app = await createAuthenticatedApp({ legacy: legacyProvider }, 'org-current');

    try {
      const response = await postJson(
        app,
        '/integrations/social/legacy/custom-fields',
        { state: 'legacy-state', values: MAX_VALUES }
      );

      expect(response.status).not.toBe(404);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(redis.setOperation('custom-fields:legacy-state')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects values containing keys the provider did not declare', async () => {
    redis.seed({ 'organization:allowed-key-state': 'org-current' });
    const app = await createAuthenticatedApp({ max: createProvider() }, 'org-current');

    try {
      const response = await postJson(
        app,
        '/integrations/social/max/custom-fields',
        {
          state: 'allowed-key-state',
          values: { ...MAX_VALUES, apiKey: 'synthetic-disallowed-secret' },
        }
      );

      expect(response.status).not.toBe(404);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(redis.setOperation('custom-fields:allowed-key-state')).toBeUndefined();
      expect(response.body).not.toContain('synthetic-disallowed-secret');
      assertSecretNeverLeaked('synthetic-disallowed-secret');
    } finally {
      await app.close();
    }
  });

  it('stages allowed values under custom-fields:{state} with a 300 second TTL and returns no credentials', async () => {
    redis.seed({ 'organization:owned-state': 'org-current' });
    const app = await createAuthenticatedApp({ max: createProvider() }, 'org-current');

    try {
      const response = await postJson(
        app,
        '/integrations/social/max/custom-fields',
        { state: 'owned-state', values: MAX_VALUES }
      );

      expect([200, 201, 204]).toContain(response.status);
      const setOperation = redis.setOperation('custom-fields:owned-state');
      expect(setOperation).toBeDefined();
      expect(setOperation?.args).toEqual(['EX', 300]);
      expect(JSON.parse(String(setOperation?.value))).toEqual(MAX_VALUES);
      expect(response.body).not.toContain(MAX_VALUES.token);
      expect(response.body).not.toContain(MAX_VALUES.chatId);
      assertSecretNeverLeaked(MAX_VALUES.token, MAX_VALUES.chatId);
    } finally {
      await app.close();
    }
  });

  it('checks organization ownership before one-time GETDEL and rejects replayed staged credentials', async () => {
    const encodedValues = Buffer.from(JSON.stringify(MAX_VALUES)).toString('base64');
    redis.seed({
      'organization:callback-state': 'org-current',
      'custom-fields:callback-state': JSON.stringify(MAX_VALUES),
      'login:callback-state': 'pkce-verifier-that-must-not-carry-secrets',
    });
    const provider = createProvider();
    const { controller } = createCallbackController(provider);

    await expect(
      controller.connectSocialMedia(
        'max',
        createCallbackBody({
          state: 'callback-state',
          code: 'staged',
          timezone: '0',
        })
      )
    ).resolves.toMatchObject({ id: 'integration-id' });

    expect(provider.authenticate).toHaveBeenCalledTimes(1);
    expect(provider.authenticate).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: encodedValues }),
      undefined
    );
    expect(redis.operationIndex('get', 'organization:callback-state')).toBeLessThan(
      redis.operationIndex('getdel', 'custom-fields:callback-state')
    );
    expect(redis.data.has('custom-fields:callback-state')).toBe(false);

    await expect(
      controller.connectSocialMedia(
        'max',
        createCallbackBody({
          state: 'callback-state',
          code: 'staged',
          timezone: '0',
        })
      )
    ).rejects.toThrow(/expired|invalid|replayed|missing/i);
    expect(provider.authenticate).toHaveBeenCalledTimes(1);
  });

  it('cleans login and other one-time Redis keys after the provider connect attempt', async () => {
    redis.seed({
      'organization:cleanup-state': 'org-current',
      'custom-fields:cleanup-state': JSON.stringify(MAX_VALUES),
      'login:cleanup-state': 'pkce-verifier',
      'external:cleanup-state': JSON.stringify({ instanceUrl: 'https://example.invalid' }),
      'refresh:cleanup-state': 'channel-to-refresh',
      'onboarding:cleanup-state': 'true',
    });
    const provider = createProvider();
    provider.authenticate = createAuthenticateMock(async () => {
      redis.operations.push({ op: 'authenticate' });
      return 'provider refused synthetic credentials';
    });
    const { controller } = createCallbackController(provider);

    await expect(
      controller.connectSocialMedia(
        'max',
        createCallbackBody({
          state: 'cleanup-state',
          code: 'staged',
          refresh: 'client-refresh-token',
          timezone: '0',
        })
      )
    ).rejects.toMatchObject({
      message: 'provider refused synthetic credentials',
    });

    const authenticateIndex = redis.operationIndex('authenticate');
    for (const key of [
      'login:cleanup-state',
      'external:cleanup-state',
      'refresh:cleanup-state',
      'onboarding:cleanup-state',
    ]) {
      const deleteIndex = redis.operationIndex('del', key);
      expect(deleteIndex).toBeGreaterThan(authenticateIndex);
      expect(redis.data.has(key)).toBe(false);
    }
    assertSecretNeverLeaked(MAX_VALUES.token, MAX_VALUES.chatId);
  });
});

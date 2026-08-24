type SecureSubmitParams = {
  identifier: string;
  values: Record<string, string>;
  onboarding?: boolean;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  gotoUrl: (url: string) => void;
  closeAll: () => void;
  resetForm: () => void;
};

type SecureSubmit = (params: SecureSubmitParams) => Promise<void>;

const TOKEN = 'xbot.synthetic.secret.>plus-risk';
const CHAT_ID = '-1001234567890';
const STATE = 'opaque-state-without-secrets';

const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
const mockGotoUrl = jest.fn<void, [string]>();
const mockCloseAll = jest.fn<void, []>();
const mockResetForm = jest.fn<void, []>();

jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockGotoUrl }),
}));

jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModals: () => ({
    openModal: jest.fn(),
    closeAll: mockCloseAll,
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));

jest.mock('@gitroom/react/helpers/variable.context', () => ({
  useVariables: () => ({
    extensionId: '',
    isGeneral: false,
    isSecured: true,
  }),
}));

jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: jest.fn() }),
}));

jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));

jest.mock('@hookform/resolvers/class-validator', () => ({
  classValidatorResolver: () => async () => ({ values: {}, errors: {} }),
}));

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
  } as Response);
}

async function loadSecureSubmitSeam() {
  // RED contract: the seam is intentionally loaded dynamically so current
  // production can fail by assertion when the export is absent, not at
  // TypeScript compile time.
  const moduleExports = (await import('./add.provider.component')) as Record<
    string,
    unknown
  >;
  const seam = moduleExports.submitSecureCustomFields;

  expect(typeof seam).toBe('function');
  if (typeof seam !== 'function') {
    throw new Error(
      'Expected add.provider.component.tsx to export submitSecureCustomFields for secure custom-field staging'
    );
  }

  return seam as SecureSubmit;
}

describe('secure custom-field submit seam', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGotoUrl.mockReset();
    mockCloseAll.mockReset();
    mockResetForm.mockReset();

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/integrations/social/max' && !init) {
        return jsonResponse({ url: STATE });
      }
      if (url === '/integrations/social/max/custom-fields') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  it('places token only in POST JSON body and routes callback with opaque state plus staged sentinel', async () => {
    const submitSecureCustomFields = await loadSecureSubmitSeam();

    await submitSecureCustomFields({
      identifier: 'max',
      values: {
        token: TOKEN,
        chatId: CHAT_ID,
      },
      fetch: mockFetch,
      gotoUrl: mockGotoUrl,
      closeAll: mockCloseAll,
      resetForm: mockResetForm,
    });

    expect(mockFetch.mock.calls[0]?.[0]).toBe('/integrations/social/max');
    expect(mockFetch.mock.calls[0]?.[1]).toBeUndefined();

    const postCall = mockFetch.mock.calls.find(
      ([url]) => url === '/integrations/social/max/custom-fields'
    );
    expect(postCall).toBeDefined();
    if (!postCall) {
      throw new Error('Expected secure custom-field POST');
    }

    const [, postInit] = postCall;
    expect(postInit).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(postInit?.body))).toEqual({
      state: STATE,
      values: {
        token: TOKEN,
        chatId: CHAT_ID,
      },
    });

    expect(mockResetForm).toHaveBeenCalledTimes(1);
    expect(mockCloseAll).toHaveBeenCalledTimes(1);
    expect(mockGotoUrl).toHaveBeenCalledTimes(1);

    const routerUrl = mockGotoUrl.mock.calls[0]?.[0];
    expect(routerUrl).toBe(`/integrations/social/max?state=${STATE}&code=staged`);

    const legacyBase64 = Buffer.from(
      JSON.stringify({ token: TOKEN, chatId: CHAT_ID })
    ).toString('base64');
    const inspectedUrls = [
      routerUrl,
      ...mockFetch.mock.calls.map(([url]) => String(url)),
    ];

    for (const url of inspectedUrls) {
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain(CHAT_ID);
      expect(url).not.toContain(legacyBase64);
      expect(url).not.toContain(encodeURIComponent(legacyBase64));
    }
  });

  it('rejects a missing opaque state before posting secrets', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/integrations/social/max' && !init) {
        return jsonResponse({ url: '' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const submitSecureCustomFields = await loadSecureSubmitSeam();

    await expect(
      submitSecureCustomFields({
        identifier: 'max',
        values: {
          token: TOKEN,
          chatId: CHAT_ID,
        },
        fetch: mockFetch,
        gotoUrl: mockGotoUrl,
        closeAll: mockCloseAll,
        resetForm: mockResetForm,
      })
    ).rejects.toThrow('Could not start secure custom field staging');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockResetForm).not.toHaveBeenCalled();
    expect(mockCloseAll).not.toHaveBeenCalled();
    expect(mockGotoUrl).not.toHaveBeenCalled();
  });

  it('surfaces staging failure without reading or exposing response bodies', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/integrations/social/max' && !init) {
        return jsonResponse({ url: STATE });
      }
      if (url === '/integrations/social/max/custom-fields') {
        return Promise.resolve({
          ok: false,
          text: async () => TOKEN,
          json: async () => ({ error: TOKEN }),
        } as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const submitSecureCustomFields = await loadSecureSubmitSeam();

    await expect(
      submitSecureCustomFields({
        identifier: 'max',
        values: {
          token: TOKEN,
          chatId: CHAT_ID,
        },
        fetch: mockFetch,
        gotoUrl: mockGotoUrl,
        closeAll: mockCloseAll,
        resetForm: mockResetForm,
      })
    ).rejects.toThrow('Could not stage secure custom fields');
    expect(mockResetForm).not.toHaveBeenCalled();
    expect(mockCloseAll).not.toHaveBeenCalled();
    expect(mockGotoUrl).not.toHaveBeenCalled();
  });
});

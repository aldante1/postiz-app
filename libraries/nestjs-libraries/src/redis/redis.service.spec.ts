type RedisWithGetDel = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'EX', seconds?: number): Promise<string>;
  getdel(key: string): Promise<string | null>;
};

const originalRedisUrl = process.env.REDIS_URL;

async function loadNoRedisUrlShim() {
  jest.resetModules();
  delete process.env.REDIS_URL;
  // Import after clearing REDIS_URL so this spec exercises the module-load-time shim branch.
  const moduleExports = await import('./redis.service');
  return moduleExports.ioRedis as unknown as RedisWithGetDel;
}

describe('no-REDIS_URL Redis shim contract', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-08-24T00:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it('atomically returns and deletes values with getdel', async () => {
    const redis = await loadNoRedisUrlShim();

    await expect(redis.set('task-4:getdel', 'secret-value')).resolves.toBe('OK');
    await expect(redis.getdel('task-4:getdel')).resolves.toBe('secret-value');
    await expect(redis.getdel('task-4:getdel')).resolves.toBeNull();
  });

  it('expires keys written with EX seconds', async () => {
    const redis = await loadNoRedisUrlShim();

    await expect(redis.set('task-4:expiring', 'secret-value', 'EX', 5)).resolves.toBe(
      'OK'
    );
    await expect(redis.get('task-4:expiring')).resolves.toBe('secret-value');

    jest.advanceTimersByTime(5001);

    await expect(redis.get('task-4:expiring')).resolves.toBeNull();
    await expect(redis.getdel('task-4:expiring')).resolves.toBeNull();
  });
});

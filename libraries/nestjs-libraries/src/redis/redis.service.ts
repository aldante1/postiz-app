import { Redis } from 'ioredis';

// Create a mock Redis implementation for testing environments
type MockRedisEntry = {
  value: unknown;
  expiresAt?: number;
};

class MockRedis {
  private data: Map<string, MockRedisEntry> = new Map();

  async get(key: string) {
    const entry = this.data.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: unknown, mode?: string, seconds?: number) {
    const expiresAt =
      mode?.toUpperCase() === 'EX' && typeof seconds === 'number'
        ? Date.now() + seconds * 1000
        : undefined;
    this.data.set(key, { value, expiresAt });
    return 'OK';
  }

  async getdel(key: string) {
    const value = await this.get(key);
    if (value !== null) {
      this.data.delete(key);
    }
    return value;
  }

  async del(...keys: string[]) {
    let deleted = 0;
    for (const key of keys) {
      if (this.data.delete(key)) {
        deleted++;
      }
    }
    return deleted;
  }
}

// Use real Redis if REDIS_URL is defined, otherwise use MockRedis
export const ioRedis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
    })
  : (new MockRedis() as unknown as Redis); // Type cast to Redis to maintain interface compatibility

// Изолированный Jest config для Telegram-форматирования: корневой jest.config.ts
// требует незаявленный @nx/jest, поэтому у каждой задачи здесь свой config
// (см. jest.max.config.cjs, jest.task-4.*.config.cjs).
const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.base.json');

module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: [
    '<rootDir>/libraries/nestjs-libraries/src/integrations/social/telegram.html.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/integrations/social/telegram.provider.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/posts/post.limits.spec.ts',
    '<rootDir>/apps/orchestrator/src/activities/provider.message.spec.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          ...compilerOptions,
          module: 'commonjs',
          types: ['jest', 'node'],
          isolatedModules: true,
        },
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),
};

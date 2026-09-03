const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.base.json');

module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: [
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/media/media.retention.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/media/media.usage.service.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/chat/tools/integration.schedule.post.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/autopost/autopost.service.spec.ts',
    '<rootDir>/apps/media-retention/src/cli.spec.ts',
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

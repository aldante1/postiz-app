// Изолированный Jest config для frontend-контрактов MAX-форматирования.
// testEnvironment: 'node' — как в jest.task-4.frontend.config.cjs; рендер React
// тут не проверяется, только чистые функции и схемы расширений.
const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.base.json');

module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: [
    '<rootDir>/apps/frontend/src/components/new-launch/max.marks.spec.ts',
    '<rootDir>/apps/frontend/src/components/new-launch/providers/high.order.limits.spec.ts',
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          ...compilerOptions,
          jsx: 'react-jsx',
          module: 'commonjs',
          types: ['jest', 'node'],
          isolatedModules: true,
        },
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: {
    '\\.(css|less|sass|scss)$': '<rootDir>/jest.task-4.empty-module.cjs',
    ...pathsToModuleNameMapper(compilerOptions.paths, {
      prefix: '<rootDir>/',
    }),
  },
};

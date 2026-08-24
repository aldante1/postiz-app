const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.base.json');

module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: ['<rootDir>/apps/frontend/src/components/launches/add.provider.component.spec.tsx'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          ...compilerOptions,
          jsx: 'react-jsx',
          module: 'commonjs',
          types: ['jest', 'node'],
        },
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

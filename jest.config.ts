import type { Config } from 'jest';

const sharedTransform = {
    '^.+\\.tsx?$': ['ts-jest', {
        tsconfig: {
            esModuleInterop: true,
            moduleResolution: 'node',
            module: 'CommonJS',
            jsx: 'react-jsx',
            strict: false,
        },
    }],
};

const sharedModuleNameMapper = {
    '^@/(.*)$': '<rootDir>/src/$1',
};

const config: Config = {
    clearMocks: true,
    projects: [
        {
            displayName: 'api',
            testEnvironment: 'node',
            preset: 'ts-jest',
            clearMocks: true,
            moduleNameMapper: sharedModuleNameMapper,
            transform: sharedTransform,
            testMatch: [
                '<rootDir>/src/__tests__/api/**/*.test.ts',
                '<rootDir>/src/__tests__/lib/**/*.test.ts',
            ],
        },
        {
            displayName: 'components',
            testEnvironment: 'jsdom',
            preset: 'ts-jest',
            clearMocks: true,
            moduleNameMapper: sharedModuleNameMapper,
            transform: sharedTransform,
            setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
            testMatch: [
                '<rootDir>/src/__tests__/components/**/*.test.tsx',
            ],
        },
    ],
};

export default config;

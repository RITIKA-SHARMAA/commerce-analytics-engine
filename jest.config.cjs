module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  testTimeout: 30000,
  setupFiles: ["<rootDir>/tests/helpers/setup-env.ts"],
  collectCoverageFrom: ["apps/api/src/**/*.ts", "apps/worker/src/**/*.ts", "!**/server.ts", "!apps/worker/src/worker.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"]
};

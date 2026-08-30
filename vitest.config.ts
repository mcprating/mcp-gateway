import { defineConfig } from "vitest/config";

/**
 * The gateway ships as its own repo and its own npm package, so its tests live
 * beside its source rather than in the monorepo's tests/ tree — otherwise they
 * would not travel with the split, and the published package would be the one
 * thing without coverage.
 *
 * Colocated *.test.ts, so a control and the tests that pin it move together.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

module.exports = {
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "<rootDir>/__mocks__/fileMock.js" // Mock CSS imports with a file mock
  },
  transformIgnorePatterns: [
    // Default: "/node_modules/"
    // Allow transpiling specific ESM modules from node_modules
    "node_modules/(?!remark-gfm|rehype-raw|rehype-sanitize|remark-math|rehype-katex|react-markdown|unified|bail|is-plain-obj|trough|vfile|unist-.+|micromark-.+|decode-named-character-reference|character-entities|mdast-.+|ccount|escape-string-regexp)/"
  ],
  // Automatically clear mock calls and instances between every test
  clearMocks: true,
  // The directory where Jest should output its coverage files
  coverageDirectory: "coverage",
};

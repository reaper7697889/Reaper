import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import MarkdownEditor from './MarkdownEditor';
import ReactPlayer from 'react-player/lazy'; // Import for ReactPlayer.canPlay mocking

// Enhanced mock for ReactMarkdown to simulate custom component rendering
const mockReactMarkdown = jest.fn((props) => {
  let contentToRender = props.children;
  if (props.components && props.components.video && typeof props.children === 'string') {
    const trimmedContent = props.children.trim();
    // Simplified regexes for the mock to identify standalone video URLs
    // This needs to be broad enough for test cases, or test URLs must match these.
    const VIDEO_URL_REGEX_SIMPLIFIED = /youtube\.com|youtu\.be|vimeo\.com|example\.com\/video\.mp4/;

    if (VIDEO_URL_REGEX_SIMPLIFIED.test(trimmedContent)) {
      if (trimmedContent.split(/\s+/).length === 1 && trimmedContent.startsWith('http')) {
        const videoNode = { type: 'video', url: trimmedContent };
        contentToRender = props.components.video({ node: videoNode });
      }
    }
  }
  return <div data-testid="mock-react-markdown">{contentToRender}</div>;
});
jest.mock('react-markdown', () => (props) => mockReactMarkdown(props));

// Mock for react-player/lazy
const mockReactPlayerRenderFn = jest.fn((props) => <div data-testid="mock-react-player" data-url={props.url}>Mocked ReactPlayer</div>);
const actualReactPlayerCanPlay = ReactPlayer.canPlay; // Store original static method

jest.mock('react-player/lazy', () => ({
  __esModule: true,
  default: Object.assign(
    (props) => mockReactPlayerRenderFn(props), // The component mock
    { canPlay: actualReactPlayerCanPlay } // Initially, use actual canPlay
  ),
  canPlay: actualReactPlayerCanPlay // Also make it available directly on the module
}));


// Auto-mock other plugins
jest.mock('remark-math');
jest.mock('rehype-katex');
jest.mock('rehype-prism-plus');

// Import modules AFTER mocks are set up
const remarkMathModule = require('remark-math');
const rehypeKatexModule = require('rehype-katex');
const rehypePrismPlusModule = require('rehype-prism-plus');
const remarkSimpleVideoEmbed = require('./remark-plugins/remarkSimpleVideoEmbed');


describe('MarkdownEditor - Plugin Integrations', () => {
  let originalCanPlay;

  beforeEach(() => {
    mockReactMarkdown.mockClear();
    mockReactPlayerRenderFn.mockClear();

    // Restore ReactPlayer.canPlay if it was mocked in a test
    // The imported ReactPlayer is the mocked one, so we modify its 'canPlay' property for tests
    const RPlayer = require('react-player/lazy').default;
    if (originalCanPlay) {
      RPlayer.canPlay = originalCanPlay;
    } else {
      // Store it first time if not already stored
      originalCanPlay = RPlayer.canPlay;
    }
     // Ensure it's reset to actual implementation for each test unless overridden in the test
    RPlayer.canPlay = actualReactPlayerCanPlay;


    if (jest.isMockFunction(remarkMathModule)) remarkMathModule.mockClear();
    else if (remarkMathModule && jest.isMockFunction(remarkMathModule.default)) remarkMathModule.default.mockClear();

    if (jest.isMockFunction(rehypeKatexModule)) rehypeKatexModule.mockClear();
    else if (rehypeKatexModule && jest.isMockFunction(rehypeKatexModule.default)) rehypeKatexModule.default.mockClear();

    if (jest.isMockFunction(rehypePrismPlusModule)) rehypePrismPlusModule.mockClear();
    else if (rehypePrismPlusModule && jest.isMockFunction(rehypePrismPlusModule.default)) rehypePrismPlusModule.default.mockClear();
  });

  afterEach(() => {
    // Restore ReactPlayer.canPlay to its original state after each test
     const RPlayer = require('react-player/lazy').default;
     RPlayer.canPlay = actualReactPlayerCanPlay;
  });


  it('should include remarkMath, rehypeKatex, configured rehypePrismPlus, and remarkSimpleVideoEmbed in plugins', () => {
    render(<MarkdownEditor initialContent="```js\nconsole.log('hello');\n```" />);

    expect(mockReactMarkdown).toHaveBeenCalled();
    const passedProps = mockReactMarkdown.mock.calls[0][0];

    const expectedRemarkMath = remarkMathModule.default || remarkMathModule;
    const expectedRemarkSimpleVideoEmbed = remarkSimpleVideoEmbed.default || remarkSimpleVideoEmbed;
    expect(passedProps.remarkPlugins).toEqual(expect.arrayContaining([
      expect.any(Function),
      expectedRemarkMath,
      expectedRemarkSimpleVideoEmbed
    ]));

    const expectedRehypeKatex = rehypeKatexModule.default || rehypeKatexModule;
    const expectedRehypePrismPlus = rehypePrismPlusModule.default || rehypePrismPlusModule;

    const prismPluginEntry = passedProps.rehypePlugins.find(
      plugin => Array.isArray(plugin) && plugin[0] === expectedRehypePrismPlus
    );
    expect(prismPluginEntry).toBeDefined();
    expect(prismPluginEntry[1]).toEqual({ showLineNumbers: true });

    expect(passedProps.rehypePlugins).toEqual(expect.arrayContaining([
      expect.any(Function),
      expect.any(Function),
      expectedRehypeKatex,
      prismPluginEntry
    ]));
  });

  it('renders basic markdown content using the mock ReactMarkdown', () => {
    const testContent = "Some text";
    render(<MarkdownEditor initialContent={testContent} />);
    expect(screen.getByTestId('mock-react-markdown')).toHaveTextContent(testContent);
  });

  it('custom video renderer calls ReactPlayer for a standalone YouTube URL', () => {
    const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    render(<MarkdownEditor initialContent={youtubeUrl} />);
    expect(mockReactMarkdown).toHaveBeenCalled();
    expect(mockReactPlayerRenderFn).toHaveBeenCalled();
    expect(mockReactPlayerRenderFn.mock.calls[0][0].url).toBe(youtubeUrl);
  });

  it('custom video renderer calls ReactPlayer for a standalone Vimeo URL', () => {
    const vimeoUrl = "https://vimeo.com/123456789";
    render(<MarkdownEditor initialContent={vimeoUrl} />);
    expect(mockReactPlayerRenderFn).toHaveBeenCalled();
    expect(mockReactPlayerRenderFn.mock.calls[0][0].url).toBe(vimeoUrl);
  });

  it('custom video renderer shows error for unplayable URL (mocked canPlay)', () => {
    const RPlayer = require('react-player/lazy').default;
    RPlayer.canPlay = jest.fn(() => false); // Mock canPlay to return false

    const badUrl = "https://example.com/video.mp4"; // This URL will be processed by mockReactMarkdown
    render(<MarkdownEditor initialContent={badUrl} />);

    expect(screen.getByTestId('mock-react-markdown')).toHaveTextContent(`Invalid or unsupported video URL: ${badUrl}`);
    expect(mockReactPlayerRenderFn).not.toHaveBeenCalled();
  });

  it('custom video renderer is not invoked for URL mixed with text', () => {
    const textWithUrl = "Check this: https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    render(<MarkdownEditor initialContent={textWithUrl} />);
    expect(mockReactPlayerRenderFn).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-react-markdown')).toHaveTextContent(textWithUrl);
  });
});

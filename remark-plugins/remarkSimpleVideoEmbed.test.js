import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkSimpleVideoEmbed from './remarkSimpleVideoEmbed'; // Assuming it's in the same directory for the test

describe('remarkSimpleVideoEmbed Plugin', () => {
  const processMarkdown = (md) => {
    const processor = unified().use(remarkParse).use(remarkSimpleVideoEmbed);
    const ast = processor.parse(md);
    return processor.runSync(ast); // Run transforms
  };

  it('should transform a paragraph with only a YouTube URL into a video node', () => {
    const markdown = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const tree = processMarkdown(markdown);

    expect(tree.children.length).toBe(1);
    const node = tree.children[0];
    expect(node.type).toBe('video');
    expect(node.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(node.data.hName).toBe('div');
    // className is not set by the plugin, but by the React component.
    // The plugin sets hProperties for the wrapper div.
    // expect(node.data.hProperties.className).toBe('embedded-video-wrapper'); // This was illustrative, not in plugin
  });

  it('should transform a paragraph with only a Vimeo URL into a video node', () => {
    const markdown = 'https://vimeo.com/123456789';
    const tree = processMarkdown(markdown);

    expect(tree.children.length).toBe(1);
    const node = tree.children[0];
    expect(node.type).toBe('video');
    expect(node.url).toBe('https://vimeo.com/123456789');
  });

  it('should handle YouTube short URLs (youtu.be)', () => {
    const markdown = 'https://youtu.be/dQw4w9WgXcQ';
    const tree = processMarkdown(markdown);
    expect(tree.children[0].type).toBe('video');
    expect(tree.children[0].url).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('should handle Vimeo player URLs', () => {
    const markdown = 'https://player.vimeo.com/video/123456789';
    const tree = processMarkdown(markdown);
    expect(tree.children[0].type).toBe('video');
    expect(tree.children[0].url).toBe('https://player.vimeo.com/video/123456789');
  });

  it('should NOT transform a paragraph with text before a URL', () => {
    const markdown = 'Check this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const tree = processMarkdown(markdown);
    expect(tree.children[0].type).toBe('paragraph');
    expect(tree.children[0].children[0].type).toBe('text');
  });

  it('should NOT transform a paragraph with text after a URL', () => {
    const markdown = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ was fun.';
    const tree = processMarkdown(markdown);
    expect(tree.children[0].type).toBe('paragraph');
  });

  it('should NOT transform a paragraph with a non-video URL', () => {
    const markdown = 'https://www.google.com';
    const tree = processMarkdown(markdown);
    expect(tree.children[0].type).toBe('paragraph');
  });

  it('should NOT transform a paragraph with multiple text nodes even if one is a URL', () => {
    const tree = {
      type: 'root',
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
          { type: 'text', value: ' other text' }
        ]
      }]
    };
    const transformedTree = unified().use(remarkSimpleVideoEmbed).runSync(tree);
    expect(transformedTree.children[0].type).toBe('paragraph');
  });

  it('should correctly handle URLs with query parameters (YouTube)', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60s';
    const tree = processMarkdown(url);
    expect(tree.children[0].type).toBe('video');
    expect(tree.children[0].url).toBe(url);
  });

  it('should leave multiple paragraphs correctly, transforming only video ones', () => {
    const markdown = 'First para.\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nLast para.';
    const tree = processMarkdown(markdown);
    expect(tree.children.length).toBe(3);
    expect(tree.children[0].type).toBe('paragraph');
    expect(tree.children[1].type).toBe('video');
    expect(tree.children[1].url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(tree.children[2].type).toBe('paragraph');
  });
});

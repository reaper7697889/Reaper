// remark-plugins/remarkSimpleVideoEmbed.js
import { visit } from 'unist-util-visit';

const YOUTUBE_REGEX = /^https?:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[&?][^\s]*)?$/;
const VIMEO_REGEX = /^https?:\/\/(?:player\.vimeo\.com\/video\/|vimeo\.com\/)([0-9]+)(?:[&?][^\s]*)?$/;

function remarkSimpleVideoEmbed() {
  return (tree) => {
    visit(tree, 'paragraph', (node, index, parent) => {
      if (node.children.length === 1 && node.children[0].type === 'text') {
        const textNode = node.children[0];
        const url = textNode.value.trim();
        let isVideoUrl = false;

        if (YOUTUBE_REGEX.test(url) || VIMEO_REGEX.test(url)) {
          isVideoUrl = true;
        }

        if (isVideoUrl) {
          // Replace the paragraph node with a custom 'video' node
          const videoNode = {
            type: 'video', // Custom node type
            data: {
              hName: 'div', // Render as a div container for ReactPlayer
              hProperties: {
                // className will be handled by the React component wrapper for the video player
              },
            },
            url: url, // Store the URL here for our custom React renderer
            children: [] // Video nodes don't have children in this context
          };

          // Replace the current paragraph node with the new video node
          if (parent && typeof index === 'number') {
            parent.children.splice(index, 1, videoNode);
            return [visit.SKIP, index]; // Skip further processing of this node and adjust index
          }
        }
      }
    });
  };
}

export default remarkSimpleVideoEmbed;

import React, { useEffect, useRef, useState } from 'react';
import { ForceGraph2D } from 'react-force-graph';
import './KnowledgeGraph.css';

const KnowledgeGraph = ({ 
  onClose, 
  onNodeClick,
  theme = 'dark'
}) => {
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [highlightNodes, setHighlightNodes] = useState(new Set());
  const [highlightLinks, setHighlightLinks] = useState(new Set());
  const [centerNode, setCenterNode] = useState(null);
  
  const graphRef = useRef();
  
  // Fetch graph data on component mount
  useEffect(() => {
    const fetchGraphData = async () => {
      try {
        setLoading(true);
        
        // Fetch all markdown notes
        const notes = await window.electronAPI.getAllNotes();
        const markdownNotes = notes.filter(note => note.type === 'markdown');
        
        // Create nodes for each note
        const nodes = markdownNotes.map(note => ({
          id: note.id.toString(),
          title: note.title || `Note ${note.id}`,
          type: 'note',
          val: 1 // Size factor
        }));
        
        // Fetch links between notes
        const allLinks = [];
        for (const note of markdownNotes) {
          const outgoingLinks = await window.electronAPI.getOutgoingLinks(note.id);
          
          // Add links to the collection
          for (const link of outgoingLinks) {
            allLinks.push({
              source: note.id.toString(),
              target: link.id.toString(),
              value: 1 // Strength factor
            });
          }
        }
        
        setGraphData({ 
          nodes, 
          links: allLinks
        });
        
        // If there are nodes, center on the first one
        if (nodes.length > 0) {
          setCenterNode(nodes[0].id);
        }
        
        setLoading(false);
      } catch (error) {
        console.error("Failed to fetch graph data:", error);
        setLoading(false);
      }
    };
    
    fetchGraphData();
  }, []);
  
  // Center the graph on a specific node
  useEffect(() => {
    if (centerNode && graphRef.current) {
      const node = graphData.nodes.find(n => n.id === centerNode);
      if (node && graphRef.current) {
        graphRef.current.centerAt(node.x, node.y, 1000);
        graphRef.current.zoom(2, 1000);
      }
    }
  }, [centerNode, graphData.nodes]);
  
  // Handle node hover
  const handleNodeHover = node => {
    if (!node) {
      setHighlightNodes(new Set());
      setHighlightLinks(new Set());
      return;
    }
    
    // Get connected nodes and links
    const connectedNodes = new Set([node.id]);
    const connectedLinks = new Set();
    
    graphData.links.forEach(link => {
      if (link.source.id === node.id || link.target.id === node.id) {
        connectedNodes.add(link.source.id);
        connectedNodes.add(link.target.id);
        connectedLinks.add(link);
      }
    });
    
    setHighlightNodes(connectedNodes);
    setHighlightLinks(connectedLinks);
  };
  
  // Handle node click
  const handleNodeClick = node => {
    if (onNodeClick) {
      onNodeClick(parseInt(node.id));
    }
    onClose();
  };
  
  // Node color based on highlight state
  const getNodeColor = node => {
    if (!highlightNodes.size) return theme === 'dark' ? '#4a90e2' : '#2a6cb0';
    return highlightNodes.has(node.id) 
      ? '#ff6b6b' 
      : theme === 'dark' ? '#555' : '#ccc';
  };
  
  // Link color based on highlight state
  const getLinkColor = link => {
    if (!highlightLinks.size) return theme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
    return highlightLinks.has(link) 
      ? theme === 'dark' ? 'rgba(255,107,107,0.8)' : 'rgba(255,107,107,0.8)'
      : theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  };
  
  // Node label
  const getNodeLabel = node => node.title;
  
  return (
    <div className={`knowledge-graph theme-${theme}`}>
      <div className="graph-header">
        <h2>Knowledge Graph</h2>
        <div className="graph-controls">
          <button 
            onClick={() => graphRef.current && graphRef.current.zoomIn()}
            className="control-button"
          >
            +
          </button>
          <button 
            onClick={() => graphRef.current && graphRef.current.zoomOut()}
            className="control-button"
          >
            -
          </button>
          <button 
            onClick={onClose}
            className="control-button close-button"
          >
            ×
          </button>
        </div>
      </div>
      
      <div className="graph-container">
        {loading ? (
          <div className="loading-indicator">Loading graph data...</div>
        ) : graphData.nodes.length === 0 ? (
          <div className="empty-graph">
            <p>No markdown notes with links found.</p>
            <p>Create some markdown notes with [[wiki-style]] links to see the knowledge graph.</p>
          </div>
        ) : (
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            nodeColor={getNodeColor}
            linkColor={getLinkColor}
            nodeLabel={getNodeLabel}
            onNodeHover={handleNodeHover}
            onNodeClick={handleNodeClick}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            linkCurvature={0.25}
            backgroundColor={theme === 'dark' ? '#1a1d21' : '#f5f5f5'}
            nodeRelSize={6}
            linkWidth={1}
            cooldownTicks={100}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const label = node.title;
              const fontSize = 12/globalScale;
              ctx.font = `${fontSize}px Sans-Serif`;
              const textWidth = ctx.measureText(label).width;
              const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.8);
              
              // Node circle
              ctx.beginPath();
              ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI, false);
              ctx.fillStyle = getNodeColor(node);
              ctx.fill();
              
              // Text background
              ctx.fillStyle = theme === 'dark' ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)';
              ctx.fillRect(
                node.x - bckgDimensions[0] / 2,
                node.y + 8,
                bckgDimensions[0],
                bckgDimensions[1]
              );
              
              // Text
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = theme === 'dark' ? '#fff' : '#000';
              ctx.fillText(label, node.x, node.y + 8 + bckgDimensions[1] / 2);
            }}
          />
        )}
      </div>
    </div>
  );
};

export default KnowledgeGraph;

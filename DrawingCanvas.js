import React, { useState, useRef, useEffect } from 'react';
import CanvasDraw from 'react-canvas-draw';
import Pressure from 'pressure';
import './DrawingCanvas.css';

const DrawingCanvas = ({ 
  initialData = null,
  onSave,
  width = '100%',
  height = '100%',
  readOnly = false
}) => {
  const [brushColor, setBrushColor] = useState('#000000');
  const [brushRadius, setBrushRadius] = useState(3);
  const [backgroundColor, setBackgroundColor] = useState('#ffffff');
  const [canvasWidth, setCanvasWidth] = useState('100%');
  const [canvasHeight, setCanvasHeight] = useState('100%');
  const [isPressureSupported, setIsPressureSupported] = useState(false);
  const [currentPressure, setCurrentPressure] = useState(0.5);
  
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  
  // Initialize canvas dimensions based on container size
  useEffect(() => {
    if (containerRef.current) {
      const updateDimensions = () => {
        const { offsetWidth, offsetHeight } = containerRef.current;
        setCanvasWidth(offsetWidth);
        setCanvasHeight(offsetHeight);
      };
      
      updateDimensions();
      window.addEventListener('resize', updateDimensions);
      
      return () => {
        window.removeEventListener('resize', updateDimensions);
      };
    }
  }, []);
  
  // Initialize pressure detection
  useEffect(() => {
    if (containerRef.current && !readOnly) {
      Pressure.set(containerRef.current, {
        start: () => {
          setIsPressureSupported(true);
        },
        change: (force) => {
          setCurrentPressure(force);
          // Dynamic brush size based on pressure
          if (canvasRef.current) {
            const baseBrushSize = brushRadius;
            const newSize = baseBrushSize * (0.5 + force);
            canvasRef.current.props.brushRadius = newSize;
          }
        },
        unsupported: () => {
          setIsPressureSupported(false);
          console.log("Pressure sensitivity not supported on this device");
        }
      });
    }
  }, [brushRadius, readOnly]);
  
  // Load initial data if provided
  useEffect(() => {
    if (initialData && canvasRef.current) {
      try {
        canvasRef.current.loadSaveData(initialData);
      } catch (error) {
        console.error("Failed to load drawing data:", error);
      }
    }
  }, [initialData]);
  
  // Handle save
  const handleSave = () => {
    if (canvasRef.current && onSave) {
      const saveData = canvasRef.current.getSaveData();
      onSave(saveData);
    }
  };
  
  // Auto-save on changes
  const handleChange = () => {
    if (canvasRef.current && onSave) {
      const saveData = canvasRef.current.getSaveData();
      onSave(saveData);
    }
  };
  
  // Handle clear
  const handleClear = () => {
    if (canvasRef.current) {
      canvasRef.current.clear();
      handleChange();
    }
  };
  
  // Handle undo
  const handleUndo = () => {
    if (canvasRef.current) {
      canvasRef.current.undo();
      handleChange();
    }
  };
  
  return (
    <div className="drawing-canvas-container" ref={containerRef}>
      {!readOnly && (
        <div className="drawing-toolbar">
          <div className="tool-group">
            <label>Brush Color:</label>
            <input 
              type="color" 
              value={brushColor} 
              onChange={(e) => setBrushColor(e.target.value)} 
            />
          </div>
          
          <div className="tool-group">
            <label>Brush Size:</label>
            <input 
              type="range" 
              min="1" 
              max="20" 
              value={brushRadius} 
              onChange={(e) => setBrushRadius(parseInt(e.target.value))} 
            />
            <span>{brushRadius}px</span>
          </div>
          
          <div className="tool-group">
            <label>Background:</label>
            <input 
              type="color" 
              value={backgroundColor} 
              onChange={(e) => setBackgroundColor(e.target.value)} 
            />
          </div>
          
          <div className="tool-group actions">
            <button onClick={handleUndo}>Undo</button>
            <button onClick={handleClear}>Clear</button>
            <button onClick={handleSave}>Save</button>
          </div>
          
          {isPressureSupported && (
            <div className="pressure-indicator">
              <label>Pressure: </label>
              <div className="pressure-bar">
                <div 
                  className="pressure-level" 
                  style={{ width: `${currentPressure * 100}%` }}
                ></div>
              </div>
            </div>
          )}
        </div>
      )}
      
      <div className="canvas-wrapper">
        <CanvasDraw
          ref={canvasRef}
          brushColor={brushColor}
          brushRadius={brushRadius}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          backgroundColor={backgroundColor}
          hideGrid={true}
          onChange={handleChange}
          disabled={readOnly}
          immediateLoading={true}
          lazyRadius={0}
        />
      </div>
    </div>
  );
};

export default DrawingCanvas;

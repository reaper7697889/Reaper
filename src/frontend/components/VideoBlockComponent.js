import React, { useState, useEffect } from 'react';
import ReactPlayer from 'react-player/lazy'; // Lazy load for performance
import './VideoBlockComponent.css';

// Conceptual component for a block-based editor.
// Props it might receive:
// - initialUrl: string (the video URL)
// - onUrlChange: (newUrl) => void (to save changes)
// - blockId: string
// - isFocused: boolean (to switch to edit mode)
// - readOnly: boolean

const VideoBlockComponent = ({ initialUrl = '', onUrlChange, isInitiallyFocused = false, readOnly = false }) => {
  const [videoUrl, setVideoUrl] = useState(initialUrl);
  const [currentInput, setCurrentInput] = useState(initialUrl); // For the input field
  const [isEditing, setIsEditing] = useState(isInitiallyFocused && !readOnly);
  const [isValidPlayerUrl, setIsValidPlayerUrl] = useState(false);

  useEffect(() => {
    setVideoUrl(initialUrl);
    setCurrentInput(initialUrl);
  }, [initialUrl]);

  useEffect(() => {
    setIsValidPlayerUrl(ReactPlayer.canPlay(videoUrl));
  }, [videoUrl]);

  useEffect(() => {
    // If focused from outside and not readOnly, switch to edit mode
    if (isInitiallyFocused && !readOnly) {
        setIsEditing(true);
    } else if (readOnly) {
        setIsEditing(false); // Ensure not in editing mode if readOnly
    }
  }, [isInitiallyFocused, readOnly]);


  const handleInputChange = (event) => {
    setCurrentInput(event.target.value);
  };

  const handleApplyUrl = () => {
    if (currentInput !== videoUrl) {
      setVideoUrl(currentInput);
      if (onUrlChange) {
        onUrlChange(currentInput);
      }
    }
  }

  const handleInputBlur = () => {
    handleApplyUrl();
    // For this conceptual component, let's switch out of edit mode on blur if not readOnly
    if (!readOnly) {
       // setIsEditing(false); // Decided against auto-switching on blur for now to allow easier text selection/correction
    }
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        handleApplyUrl();
        if (!readOnly) {
          setIsEditing(false); // Switch to view mode on Enter
        }
        event.target.blur();
    }
  };

  const handlePlayerWrapperClick = () => {
    if (!isEditing && !readOnly) {
      setIsEditing(true);
      // It might be good to focus the input here, which would require a ref.
      // For simplicity, this is omitted for now.
    }
  };

  if (readOnly && !isValidPlayerUrl && videoUrl) { // Show error in readOnly if URL is bad and present
    return (
      <div className="video-block">
        <p className="video-block-error">Invalid or unplayable video URL: {videoUrl}</p>
      </div>
    );
  }
  if (readOnly && !videoUrl) { // Show placeholder in readOnly if no URL
     return (
      <div className="video-block">
        <p>No video URL provided.</p>
      </div>
    );
  }


  return (
    <div className="video-block">
      {(!readOnly) && ( // Show input area only if not readOnly. isEditing controls actual input visibility.
        <div className="video-block-input-area">
          {isEditing ? (
            <>
              <label htmlFor={`videoUrlInput-${initialUrl}`}>Video URL (YouTube, Vimeo, etc.):</label>
              <input
                id={`videoUrlInput-${initialUrl}`} // More unique ID if multiple instances
                type="text"
                className="video-block-input"
                value={currentInput}
                onChange={handleInputChange}
                onBlur={handleInputBlur}
                onKeyPress={handleKeyPress}
                placeholder="Enter video URL and press Enter"
                autoFocus={isInitiallyFocused}
              />
            </>
          ) : (
            <div onClick={handlePlayerWrapperClick} style={{padding: '5px', border: '1px dashed #ccc', textAlign: 'center', cursor: 'pointer'}}>
              <p style={{margin: '0', fontSize: '0.9em', color: '#555'}}>Video URL: {videoUrl || "(empty - click to edit)"}</p>
            </div>
          )}
        </div>
      )}

      {videoUrl && isValidPlayerUrl ? (
        <div className="video-block-player-wrapper" >
          <ReactPlayer
            className="video-block-react-player"
            url={videoUrl}
            controls={true}
            width="100%"
            height="100%"
            onError={(e) => {
                console.warn('ReactPlayer error:', e);
                setIsValidPlayerUrl(false); // Set to false on error to show error message
            }}
          />
        </div>
      ) : (
        videoUrl && !isValidPlayerUrl && ( // Only show if URL is set but invalid
         <p className="video-block-error">Could not load video. Please check the URL: {videoUrl}</p>
        )
      )}
      {!videoUrl && !isEditing && !readOnly && ( // Placeholder if no URL and not editing
         <div onClick={handlePlayerWrapperClick} style={{cursor: 'pointer', padding: '20px', textAlign: 'center', backgroundColor: '#f0f0f0'}}>
            <p>Click to enter video URL</p>
        </div>
      )}
    </div>
  );
};

export default VideoBlockComponent;

// Example Usage (conceptual):
//
// const MyBlockEditorView = () => {
//   const [url, setUrl] = useState('https://www.youtube.com/watch?v=ysz5S6PUM-U');
//   return (
//     <VideoBlockComponent
//       initialUrl={url}
//       onUrlChange={setUrl}
//       isInitiallyFocused={false}
//       readOnly={false}
//     />
//   );
// };

import React, { useState, useEffect, useRef } from 'react';
import { ReactMic } from 'react-mic';
import './VoiceMemoRecorder.css';

const VoiceMemoRecorder = ({ 
  onSave,
  initialAudio = null,
  readOnly = false
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  
  // Load initial audio if provided
  useEffect(() => {
    if (initialAudio && !audioUrl) {
      try {
        // Check if initialAudio is a URL string or a base64 string
        if (typeof initialAudio === 'string') {
          if (initialAudio.startsWith('data:audio')) {
            // It's already a data URL
            setAudioUrl(initialAudio);
            
            // Create a blob from the data URL
            fetch(initialAudio)
              .then(res => res.blob())
              .then(blob => {
                setAudioBlob(blob);
              });
          } else {
            // Assume it's a base64 string
            const dataUrl = `data:audio/wav;base64,${initialAudio}`;
            setAudioUrl(dataUrl);
            
            // Create a blob from the data URL
            fetch(dataUrl)
              .then(res => res.blob())
              .then(blob => {
                setAudioBlob(blob);
              });
          }
        }
      } catch (error) {
        console.error("Failed to load initial audio:", error);
      }
    }
  }, [initialAudio, audioUrl]);
  
  // Update audio duration when audio is loaded
  useEffect(() => {
    if (audioRef.current) {
      const handleLoadedMetadata = () => {
        setDuration(audioRef.current.duration);
      };
      
      audioRef.current.addEventListener('loadedmetadata', handleLoadedMetadata);
      
      return () => {
        if (audioRef.current) {
          audioRef.current.removeEventListener('loadedmetadata', handleLoadedMetadata);
        }
      };
    }
  }, [audioUrl]);
  
  // Update current time during playback
  useEffect(() => {
    if (audioRef.current) {
      const handleTimeUpdate = () => {
        setCurrentTime(audioRef.current.currentTime);
      };
      
      const handleEnded = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
      
      audioRef.current.addEventListener('timeupdate', handleTimeUpdate);
      audioRef.current.addEventListener('ended', handleEnded);
      
      return () => {
        if (audioRef.current) {
          audioRef.current.removeEventListener('timeupdate', handleTimeUpdate);
          audioRef.current.removeEventListener('ended', handleEnded);
        }
      };
    }
  }, [audioUrl]);
  
  // Timer for recording duration
  useEffect(() => {
    if (isRecording) {
      setDuration(0);
      timerRef.current = setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRecording]);
  
  // Handle recording start/stop
  const toggleRecording = () => {
    setIsRecording(!isRecording);
    
    // Stop playback if recording
    if (!isRecording && isPlaying) {
      stopPlayback();
    }
  };
  
  // Handle recording completion
  const onRecordingComplete = (recordedBlob) => {
    setAudioBlob(recordedBlob.blob);
    setAudioUrl(URL.createObjectURL(recordedBlob.blob));
    
    // Save the recording
    if (onSave) {
      // Convert blob to base64 for storage
      const reader = new FileReader();
      reader.readAsDataURL(recordedBlob.blob);
      reader.onloadend = () => {
        const base64data = reader.result;
        onSave(base64data);
      };
    }
  };
  
  // Handle playback
  const togglePlayback = () => {
    if (!audioRef.current) return;
    
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  };
  
  const startPlayback = () => {
    if (!audioRef.current) return;
    
    audioRef.current.play();
    setIsPlaying(true);
  };
  
  const stopPlayback = () => {
    if (!audioRef.current) return;
    
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setIsPlaying(false);
    setCurrentTime(0);
  };
  
  // Handle seeking
  const handleSeek = (e) => {
    if (!audioRef.current || !duration) return;
    
    const seekTime = (e.nativeEvent.offsetX / e.target.clientWidth) * duration;
    audioRef.current.currentTime = seekTime;
    setCurrentTime(seekTime);
  };
  
  // Format time (seconds) to MM:SS
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };
  
  return (
    <div className="voice-memo-recorder">
      {!readOnly && (
        <div className="recording-controls">
          <button 
            onClick={toggleRecording} 
            className={`record-button ${isRecording ? 'recording' : ''}`}
          >
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </button>
          
          {isRecording && (
            <div className="recording-indicator">
              <div className="recording-dot"></div>
              <span className="recording-time">{formatTime(duration)}</span>
            </div>
          )}
        </div>
      )}
      
      {audioUrl && (
        <div className="playback-controls">
          <button 
            onClick={togglePlayback} 
            className={`playback-button ${isPlaying ? 'playing' : ''}`}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          
          <div className="playback-progress" onClick={handleSeek}>
            <div 
              className="progress-bar" 
              style={{ width: `${(currentTime / duration) * 100}%` }}
            ></div>
          </div>
          
          <span className="playback-time">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          
          <audio ref={audioRef} src={audioUrl} />
        </div>
      )}
      
      {!readOnly && (
        <ReactMic
          record={isRecording}
          className="sound-wave"
          onStop={onRecordingComplete}
          strokeColor="#4a90e2"
          backgroundColor="rgba(0, 0, 0, 0.1)"
          mimeType="audio/wav"
        />
      )}
    </div>
  );
};

export default VoiceMemoRecorder;

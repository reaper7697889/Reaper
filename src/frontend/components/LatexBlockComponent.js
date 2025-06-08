import React, { useState, useEffect } from 'react';
import { BlockMath } from 'react-katex'; // Using react-katex. InlineMath not used in this version.
import 'katex/dist/katex.min.css'; // Ensure KaTeX CSS is loaded
import './LatexBlockComponent.css';

// This is a conceptual component.
// In a real block editor, it would receive props like:
// - initialLatex: string
// - onLatexChange: (newLatexString) => void
// - blockId: string (for unique key, etc.)
// - isFocused: boolean (to switch between input and preview)
// - readOnly: boolean

const LatexBlockComponent = ({
  initialLatex = '',
  onLatexChange,
  isInitiallyFocused = false,
  readOnly = false
}) => {
  const [latexInput, setLatexInput] = useState(initialLatex);
  const [error, setError] = useState(null); // For custom error handling if needed beyond KaTeX's renderError
  const [isEditing, setIsEditing] = useState(isInitiallyFocused && !readOnly);

  useEffect(() => {
    setLatexInput(initialLatex);
  }, [initialLatex]);

  useEffect(() => {
    if (!readOnly) {
      setIsEditing(isInitiallyFocused);
    } else {
      setIsEditing(false);
    }
  }, [isInitiallyFocused, readOnly]);

  const handleChange = (event) => {
    if (readOnly) return;
    const newLatex = event.target.value;
    setLatexInput(newLatex);
    if (onLatexChange) {
      onLatexChange(newLatex); // Callback to update parent/store
    }
    setError(null); // Clear previous error on new input
  };

  const handlePreviewClick = () => {
    if (!readOnly) {
      setIsEditing(true);
    }
  };

  const handleInputBlur = () => {
    // For this conceptual component, stay in edit mode unless readOnly is true.
    // A more complex component might switch to preview on blur if not readOnly.
    if (!readOnly) {
        // setIsEditing(false); // Example: switch to preview on blur
    }
  };

  const katexSettings = {
    throwOnError: false,
    errorColor: '#CD5C5C',
    // displayMode: true, // BlockMath handles this
  };

  return (
    <div className="latex-block">
      {isEditing && !readOnly ? (
        <textarea
          className="latex-block-input"
          value={latexInput}
          onChange={handleChange}
          onBlur={handleInputBlur}
          placeholder="Enter LaTeX, e.g., E = mc^2 or \sum_{i=0}^n i^2"
          autoFocus={isInitiallyFocused}
          readOnly={readOnly}
        />
      ) : null}

      <div
        className="latex-block-preview"
        onClick={!isEditing && !readOnly ? handlePreviewClick : undefined}
        title={!isEditing && !readOnly ? "Click to edit LaTeX" : ""}
        style={{ cursor: !isEditing && !readOnly ? 'pointer' : 'default' }}
      >
        <BlockMath
          math={latexInput || (readOnly ? "" : "\text{Enter LaTeX above...}")}
          settings={katexSettings}
          renderError={(katexError) => {
            // KaTeX's <BlockMath> will render its own error message.
            // This callback could be used to set a custom error state if needed.
            // e.g., setError(katexError.toString());
            // For now, we rely on KaTeX's default error rendering.
            // To show a custom error below the preview, you could use:
            // return <span className="latex-block-error">Custom Error: {katexError.message}</span>;
            // However, KaTeX usually does a good job rendering its own errors inline.
            // If latexInput is empty and not readonly, show placeholder text.
            if (!latexInput && !readOnly) return <span style={{color: "#aaa"}}>{"\text{LaTeX Preview}"}</span>;
            return null; // Let KaTeX handle error rendering by default if math is not empty
          }}
        />
      </div>
      {/* Example of an external error display, if needed: */}
      {/* {error && <div className="latex-block-error">Error: {error}</div>} */}
    </div>
  );
};

export default LatexBlockComponent;

// Example Usage (conceptual, would be in the main block editor):
//
// const MyBlockEditor = () => {
//   const [latexContent, setLatexContent] = useState("\\frac{a}{b}");
//
//   return (
//     <div>
//       <p>Some text before.</p>
//       <LatexBlockComponent
//         initialLatex={latexContent}
//         onLatexChange={setLatexContent}
//         isInitiallyFocused={false}
//         readOnly={false}
//       />
//       <p>Some text after. Current LaTeX: {latexContent}</p>
//       <LatexBlockComponent initialLatex={"E=mc^2"} readOnly={true} />
//     </div>
//   );
// };

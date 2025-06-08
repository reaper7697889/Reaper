import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import LatexBlockComponent from './LatexBlockComponent';

// Mock react-katex
// We store the mock function to check its props later
const mockBlockMathRender = jest.fn(({ math, renderError, settings }) => {
  // Simulate error propagation for testing our component's renderError handling
  // Note: The test will pass "\\\\invalid{command" which becomes "\\invalid{command" as the math prop.
  if (typeof math === 'string' && math.includes('\\invalid')) {
    if (renderError) {
      // Simulate KaTeX calling our renderError prop
      return renderError(new Error('KaTeX parse error: Simulated from mock'));
    }
    // Fallback if renderError prop isn't used as expected by the test
    return <div data-testid="mock-block-math">KaTeX Error Fallback</div>;
  }
  return <div data-testid="mock-block-math">{math}</div>;
});

jest.mock('react-katex', () => ({
  BlockMath: (props) => mockBlockMathRender(props), // Use the stored mock function
  InlineMath: jest.fn(({ math }) => <span data-testid="mock-inline-math">{math}</span>),
}));


describe('LatexBlockComponent - Basic Rendering & Props (with react-katex mock)', () => {
  const mockOnLatexChange = jest.fn();

  beforeEach(() => {
    mockOnLatexChange.mockClear();
    mockBlockMathRender.mockClear(); // Clear calls to our BlockMath mock
  });

  it('renders with initial LaTeX and passes it to BlockMath (view mode by default)', () => {
    render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} />);
    expect(screen.getByTestId('mock-block-math')).toBeInTheDocument();
    expect(screen.getByTestId('mock-block-math')).toHaveTextContent("E=mc^2");
    expect(mockBlockMathRender).toHaveBeenCalledWith(
      expect.objectContaining({ math: "E=mc^2" })
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('renders placeholder text via BlockMath when initialLatex is empty (view mode)', () => {
    render(<LatexBlockComponent initialLatex="" onLatexChange={mockOnLatexChange} />);
    // The component passes "\text{Enter LaTeX above...}" to BlockMath.
    // The mock will render this text.
    expect(screen.getByTestId('mock-block-math')).toHaveTextContent("\text{Enter LaTeX above...}");
    expect(mockBlockMathRender).toHaveBeenCalledWith(
      // The string in the component is "\text{Enter LaTeX above...}"
      // If it was received by the mock with a tab, the mock would have rendered the tab.
      // The failure `Received: "	ext{Enter LaTeX above...}"` was for the math prop, not textContent.
      // The component code is: math={latexInput || (readOnly ? "" : "\text{Enter LaTeX above...")}
      // This string does not have a tab.
      expect.objectContaining({ math: "\\text{Enter LaTeX above...}" })
    );
  });

  it('renders in edit mode with textarea if isInitiallyFocused is true (and not readOnly)', () => {
    render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} isInitiallyFocused={true} readOnly={false} />);
    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("E=mc^2");
    // BlockMath should still be rendered
    expect(screen.getByTestId('mock-block-math')).toHaveTextContent("E=mc^2");
  });

  it('updates latexInput state and calls onLatexChange when textarea value changes', () => {
    render(<LatexBlockComponent initialLatex="" onLatexChange={mockOnLatexChange} isInitiallyFocused={true} readOnly={false} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '\\sum' } });
    expect(textarea.value).toBe('\\sum');
    expect(mockOnLatexChange).toHaveBeenCalledWith('\\sum');
  });

  it('does not render textarea if readOnly is true, even if isInitiallyFocused is true', () => {
    render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} isInitiallyFocused={true} readOnly={true} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-block-math')).toHaveTextContent("E=mc^2");
  });

  it('updates BlockMath prop when latexInput changes in edit mode', () => {
    render(<LatexBlockComponent initialLatex="" onLatexChange={mockOnLatexChange} isInitiallyFocused={true} readOnly={false} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'a^2+b^2=c^2' } });
    expect(screen.getByTestId('mock-block-math')).toHaveTextContent('a^2+b^2=c^2');
    expect(mockBlockMathRender.mock.calls[mockBlockMathRender.mock.calls.length - 1][0])
      .toMatchObject({ math: 'a^2+b^2=c^2' });
  });

  it('syncs BlockMath with initialLatex prop changes when in edit mode', () => {
    const { rerender } = render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} isInitiallyFocused={true} readOnly={false} />);
    expect(screen.getByRole('textbox')).toHaveValue("E=mc^2");
    expect(mockBlockMathRender.mock.calls[mockBlockMathRender.mock.calls.length - 1][0])
      .toMatchObject({ math: "E=mc^2" });

    rerender(<LatexBlockComponent initialLatex="F=ma" onLatexChange={mockOnLatexChange} isInitiallyFocused={true} readOnly={false} />);
    expect(screen.getByRole('textbox')).toHaveValue("F=ma");
    expect(mockBlockMathRender.mock.calls[mockBlockMathRender.mock.calls.length - 1][0])
      .toMatchObject({ math: "F=ma" });
  });

  it('syncs BlockMath with initialLatex prop changes when in view mode', () => {
    const { rerender } = render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} isInitiallyFocused={false} readOnly={false} />);
    expect(mockBlockMathRender.mock.calls[mockBlockMathRender.mock.calls.length - 1][0])
      .toMatchObject({ math: "E=mc^2" });

    rerender(<LatexBlockComponent initialLatex="F=ma" onLatexChange={mockOnLatexChange} isInitiallyFocused={false} readOnly={false} />);
    expect(mockBlockMathRender.mock.calls[mockBlockMathRender.mock.calls.length - 1][0])
      .toMatchObject({ math: "F=ma" });
  });

  it('uses the renderError prop of BlockMath to display errors', () => {
    const invalidLatex = "\\\\invalid{command"; // This becomes "\\invalid{command}" for the math prop
    const { container } = render(<LatexBlockComponent initialLatex={invalidLatex} onLatexChange={mockOnLatexChange} isInitiallyFocused={false} readOnly={false} />);

    const errorSpan = container.querySelector('span.latex-block-error');
    expect(errorSpan).toBeInTheDocument();
    expect(errorSpan).toHaveTextContent('Error: KaTeX parse error: Simulated from mock');
  });

});

describe('LatexBlockComponent - Mode Switching', () => {
  const mockOnLatexChange = jest.fn();

  beforeEach(() => {
    mockOnLatexChange.mockClear();
    mockBlockMathRender.mockClear();
  });

  it('switches from view to edit mode on preview click (if not readOnly)', () => {
    render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} readOnly={false} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-block-math'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue("E=mc^2");
  });

  it('does not switch to edit mode on preview click if readOnly', () => {
    render(<LatexBlockComponent initialLatex="E=mc^2" onLatexChange={mockOnLatexChange} readOnly={true} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mock-block-math'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

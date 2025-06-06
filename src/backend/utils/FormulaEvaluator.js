// src/backend/utils/FormulaEvaluator.js
const { Parser } = require('expr-eval');

// Helper to create a mapping from [Column Name] to a safe variable name
// and a context object for evaluation.
function _prepareFormulaContext(formulaString, rowData, columnDefinitions) {
  const columnMapByName = {}; // Maps "lowercase column name" to columnId
  const columnMapById = {};   // Maps columnId to its original definition (for type, etc. if needed later)

  columnDefinitions.forEach(col => {
    // It's possible for column names to not be unique if not enforced by DB schema strictly on name only (e.g. unique per (db_id, name))
    // For formulas, we assume column names within a single database context are unique enough for reliable mapping.
    // Using lowercase for matching ensures case-insensitivity for column references in formulas.
    if (col.name) { // Ensure column name exists
        columnMapByName[col.name.toLowerCase()] = col.id;
    }
    columnMapById[col.id] = col;
  });

  let processedFormula = formulaString;
  const evaluationContext = {};
  const variableMapForError = {}; // Maps safeVarName back to original [Column Name] for error messages

  // Regex to find [Column Name] references. Allows spaces and most chars except ']' inside.
  const columnRefRegex = /\[([^\]]+)\]/g;
  let match;

  // First pass: identify all column references and build context
  // This regex exec loop needs to be carefully managed if replacing inline, as string length changes.
  // Better to find all matches first, then replace. Or replace with placeholders that have same length.
  // For simplicity with expr-eval, direct replacement with safe variable names is usually fine if names are distinct.

  const matches = [];
  while((match = columnRefRegex.exec(formulaString)) !== null) {
    matches.push({fullMatch: match[0], columnName: match[1].trim()});
  }

  for (const m of matches) {
    const { fullMatch, columnName } = m;
    const columnId = columnMapByName[columnName.toLowerCase()];

    if (columnId === undefined) { // Check for undefined specifically
      throw new Error(`Formula Error: Column "[${columnName}]" not found.`);
    }

    // Create a safe variable name for expr-eval. Using 'c_' prefix.
    // Sanitize columnId to ensure it's a valid variable name component.
    const safeVarName = `c_${String(columnId).replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Replace all occurrences of this fullMatch with safeVarName in the formula string
    // This simple replace might have issues if column names are substrings of others,
    // e.g., "[Col]" and "[Col Extended]". Regex replacement with non-greedy match is better.
    // However, the initial regex `\[([^\]]+)\]` should capture the longest possible non-']' sequence.
    // Using string.replace(new RegExp(regexEscape(fullMatch), 'g'), safeVarName) would be more robust.
    // For now, assuming distinct full matches from the loop.
    processedFormula = processedFormula.split(fullMatch).join(safeVarName); // Basic global replace

    // Populate context for expr-eval
    // rowData is expected to be keyed by columnId and have JS-typed values.
    evaluationContext[safeVarName] = rowData[columnId];
    variableMapForError[safeVarName] = `[${columnName}]`;
  }

  return { processedFormula, evaluationContext, variableMapForError };
}

const parser = new Parser({
  allowMemberAccess: false, // Security: disable member access
  operators: {
    logical: true,
    comparison: true,
    // 'in': true, // Example: enable 'in' operator if needed
  }
});

// Define custom functions
parser.functions.IF = (condition, trueVal, falseVal) => condition ? trueVal : falseVal;
parser.functions.CONCAT = (...args) => args.map(arg => (arg === null || arg === undefined) ? '' : String(arg)).join('');
parser.functions.UPPER = (str) => (str === null || str === undefined) ? '' : String(str).toUpperCase();
parser.functions.LOWER = (str) => (str === null || str === undefined) ? '' : String(str).toLowerCase();
parser.functions.LEN = (str) => (str === null || str === undefined) ? 0 : String(str).length;
parser.functions.ROUND = (num, digits = 0) => {
  if (typeof num !== 'number' || isNaN(num)) return NaN;
  const factor = Math.pow(10, digits);
  return Math.round(num * factor) / factor;
};
parser.functions.TODAY = () => new Date().toISOString().split('T')[0]; // YYYY-MM-DD
parser.functions.YEAR = (dateStr) => {
  const date = new Date(String(dateStr)); // Ensure input is string for Date constructor
  return date instanceof Date && !isNaN(date.valueOf()) ? date.getFullYear() : NaN;
};
parser.functions.MONTH = (dateStr) => {
  const date = new Date(String(dateStr));
  return date instanceof Date && !isNaN(date.valueOf()) ? date.getMonth() + 1 : NaN;
};
parser.functions.DAY = (dateStr) => {
  const date = new Date(String(dateStr));
  return date instanceof Date && !isNaN(date.valueOf()) ? date.getDate() : NaN;
};
// Add more math functions if needed, though many are built-in
parser.functions.ABS = Math.abs;
parser.functions.SQRT = Math.sqrt;
parser.functions.POW = Math.pow;

parser.functions.DATE_DIFF = (dateStr1, dateStr2, unit = 'days') => {
  const date1 = new Date(String(dateStr1));
  const date2 = new Date(String(dateStr2));

  if (!(date1 instanceof Date && !isNaN(date1.valueOf())) ||
      !(date2 instanceof Date && !isNaN(date2.valueOf()))) {
    return NaN; // Invalid date input
  }

  const diffMs = date1.getTime() - date2.getTime();

  let conversionFactor;
  const lowerUnit = String(unit).toLowerCase();

  switch (lowerUnit) {
    case 'days':
      conversionFactor = 1000 * 60 * 60 * 24;
      break;
    case 'hours':
      conversionFactor = 1000 * 60 * 60;
      break;
    case 'minutes':
      conversionFactor = 1000 * 60;
      break;
    case 'seconds':
      conversionFactor = 1000;
      break;
    default: // Default to 'days' if unit is invalid or not provided
      conversionFactor = 1000 * 60 * 60 * 24;
      break;
  }

  return diffMs / conversionFactor;
};
// Consider adding text functions like LEFT, RIGHT, MID, REPLACE, FIND if required.

/**
 * Evaluates a formula string using row data and column definitions.
 * @param {string} formulaString - The formula string, e.g., "[Price] * [Quantity]".
 * @param {object} rowData - Data for the current row, keyed by columnId, with JS-typed values.
 * @param {Array<object>} columnDefinitions - Array of column defs for the database, including {id, name, type}.
 * @returns {{result: any, error: string | null}} - An object with the result or an error message.
 */
function evaluateFormula(formulaString, rowData, columnDefinitions) {
  if (!formulaString || typeof formulaString !== 'string' || formulaString.trim() === '') {
    return { result: null, error: null }; // Empty formula is not an error, just no result.
  }
  if (!rowData || typeof rowData !== 'object') {
     return { result: null, error: "Formula Error: Invalid row data provided for evaluation." };
  }
  if (!columnDefinitions || !Array.isArray(columnDefinitions)) {
     return { result: null, error: "Formula Error: Invalid column definitions provided for evaluation." };
  }

  let processedFormula, evaluationContext, variableMapForError;
  try {
    const contextPrep = _prepareFormulaContext(formulaString, rowData, columnDefinitions);
    processedFormula = contextPrep.processedFormula;
    evaluationContext = contextPrep.evaluationContext;
    variableMapForError = contextPrep.variableMapForError;
  } catch (e) {
    return { result: null, error: e.message }; // Error from _prepareFormulaContext (e.g. column not found)
  }

  try {
    const expression = parser.parse(processedFormula);
    const result = expression.evaluate(evaluationContext);

    if (result === Infinity || result === -Infinity) {
      return { result: null, error: "Formula Error: Calculation resulted in Infinity (e.g., division by zero)." };
    }
    if (Number.isNaN(result)) {
      // Attempt to find if NaN was due to an undefined variable in the context (e.g. a column was null)
      // This is tricky as expr-eval might already convert some undefined vars to NaN in operations.
      // A more robust check would be to see if any variable used in `expression.variables()`
      // had a value of `undefined` or `NaN` in `evaluationContext`.
      return { result: null, error: "Formula Error: Calculation resulted in NaN (Not a Number). This might be due to operations with undefined or null column values." };
    }

    return { result, error: null };

  } catch (e) {
    let errorMessage = e.message || "Formula evaluation error.";
    // Attempt to map safe variable names back to [Column Name] in error messages
    // Example: "undefined variable c_123" -> "undefined variable [Column Name corresponding to c_123]"
    for (const safeVar in variableMapForError) {
        if (errorMessage.includes(safeVar)) {
            errorMessage = errorMessage.replace(new RegExp(safeVar, 'g'), variableMapForError[safeVar]);
        }
    }
    return { result: null, error: `Formula Error: ${errorMessage}` };
  }
}

module.exports = { evaluateFormula };

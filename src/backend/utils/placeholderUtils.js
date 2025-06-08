// src/backend/utils/placeholderUtils.js

// Simplified date formatter for backend use.
// For more complex formatting, consider a robust library if not already used elsewhere in backend.
function formatDate(date, formatStr = 'YYYY-MM-DD') {
  const year = date.getFullYear();
  const month = (`0${date.getMonth() + 1}`).slice(-2);
  const day = (`0${date.getDate()}`).slice(-2);

  let formatted = formatStr;
  formatted = formatted.replace('YYYY', year);
  formatted = formatted.replace('MM', month);
  formatted = formatted.replace('DD', day);
  return formatted;
}

function processBackendPlaceholders(content, targetDate) {
  if (!content) return '';
  let processedContent = content;
  const now = targetDate || new Date(); // Use targetDate if provided

  // Only handle {{date}} for now in the backend for simplicity
  // Assumes a simple format like YYYY-MM-DD for the {{date}} placeholder.
  // More complex {{date:FORMAT}} would require parsing the format string.
  const dateRegex = /\{\{date\}\}/g;
  processedContent = processedContent.replace(dateRegex, formatDate(now, 'YYYY-MM-DD'));

  // {{uuid}} can also be handled if needed, using a simple UUID generator
  // const uuidRegex = /\{\{uuid\}\}/g;
  // const generateUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => (Math.random()*16|0).toString(16));
  // processedContent = processedContent.replace(uuidRegex, generateUUID());

  return processedContent;
}

module.exports = {
  processBackendPlaceholders,
  formatDate, // Export formatDate for use in journalService title generation
};

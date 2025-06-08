// placeholderProcessor.js

// Using a simple date formatter for now.
// For more complex formatting, a library like date-fns or dayjs would be good.
const formatDate = (date, formatStr = 'YYYY-MM-DD') => {
  const year = date.getFullYear();
  const month = (`0${date.getMonth() + 1}`).slice(-2);
  const day = (`0${date.getDate()}`).slice(-2);

  let formatted = formatStr;
  formatted = formatted.replace('YYYY', year);
  formatted = formatted.replace('MM', month);
  formatted = formatted.replace('DD', day);
  // Add more replacements for other common formats if needed (e.g., YY, M, D)
  return formatted;
};

const formatTime = (date, formatStr = 'HH:mm') => {
  const hours = (`0${date.getHours()}`).slice(-2);
  const minutes = (`0${date.getMinutes()}`).slice(-2);
  const seconds = (`0${date.getSeconds()}`).slice(-2);

  let formatted = formatStr;
  formatted = formatted.replace('HH', hours);
  formatted = formatted.replace('mm', minutes);
  formatted = formatted.replace('ss', seconds);
  // Add 12-hour format with AM/PM if needed
  return formatted;
};

// Basic UUID generator (sufficient for non-crypto needs)
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

export const processPlaceholders = (content, title = '') => {
  const now = new Date();
  let processedContent = content;
  let processedTitle = title;

  // Date, Time, DateTime Placeholders with optional format
  const dateTimeRegex = /\{\{(date|time|datetime)(?::([^}]+))?\}\}/g;

  const replacer = (match, type, format) => {
    switch (type) {
      case 'date':
        return formatDate(now, format);
      case 'time':
        return formatTime(now, format);
      case 'datetime':
        // For datetime, format might combine date and time parts, or be a full ISO string
        return format ? `${formatDate(now, format.split(' ')[0] || 'YYYY-MM-DD')} ${formatTime(now, format.split(' ')[1] || 'HH:mm')}` : now.toISOString();
      default:
        return match;
    }
  };

  processedContent = processedContent.replace(dateTimeRegex, replacer);
  processedTitle = processedTitle.replace(dateTimeRegex, replacer);

  // UUID
  processedContent = processedContent.replace(/\{\{uuid\}\}/g, generateUUID());
  processedTitle = processedTitle.replace(/\{\{uuid\}\}/g, generateUUID());

  // Title placeholder (if present in content) - might be filled by actual new note title later
  // For now, just remove it or replace with a generic prompt if it's in content
  processedContent = processedContent.replace(/\{\{new_note_title\}\}/g, '');

  // Cursor placeholder - just remove it for now.
  // Actual cursor positioning would require editor-specific API calls after content is set.
  let cursorPosition = -1; // -1 means not found or end of content
  if (processedContent.includes('{{cursor}}')) {
    cursorPosition = processedContent.indexOf('{{cursor}}');
    processedContent = processedContent.replace('{{cursor}}', '');
  }

  return { processedContent, processedTitle, cursorPosition };
};

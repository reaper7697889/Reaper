// src/backend/utils/recurrenceUtils.js
const { RRule } = require('rrule');

/**
 * Generates recurrence instances for a given RRULE string within a specified date range.
 *
 * @param {string} rruleString - The RRULE string (e.g., "FREQ=WEEKLY;BYDAY=MO;UNTIL=20241231T235959Z").
 * @param {Date} eventStartDateTime - A JavaScript Date object representing the original start date/time of the event (dtstart).
 * @param {Date} rangeStartDate - A JavaScript Date object for the beginning of the period for which to find occurrences.
 * @param {Date} rangeEndDate - A JavaScript Date object for the end of the period for which to find occurrences.
 * @returns {Date[]} An array of Date objects representing the start times of the occurrences. Returns empty array on error or if no instances.
 */
function getRecurrenceInstances(rruleString, eventStartDateTime, rangeStartDate, rangeEndDate) {
  if (!rruleString || typeof rruleString !== 'string' || rruleString.trim() === "") {
    // If there's no rule, and the event itself falls within the range,
    // some might expect it to be returned. However, this function is for *recurring* instances.
    // For this implementation, an empty rruleString means no recurring instances.
    return [];
  }

  if (!(eventStartDateTime instanceof Date && !isNaN(eventStartDateTime)) ||
      !(rangeStartDate instanceof Date && !isNaN(rangeStartDate)) ||
      !(rangeEndDate instanceof Date && !isNaN(rangeEndDate))) {
    console.error("Invalid Date object provided for eventStartDateTime, rangeStartDate, or rangeEndDate.");
    return [];
  }

  try {
    const options = RRule.parseString(rruleString);

    // Ensure dtstart is correctly set from eventStartDateTime.
    // RRule.parseString might produce its own dtstart if the rruleString contains one,
    // but the function signature implies eventStartDateTime is authoritative for the series start.
    options.dtstart = eventStartDateTime;

    // Ensure UNTIL is a Date object if present, as rrule.js might parse it as a string sometimes.
    if (options.until && typeof options.until === 'string') {
        options.until = new Date(options.until);
    }
    // Similar for DTSTART if it was part of the original rruleString (though we override with eventStartDateTime)
    // This is more of a defensive measure if rrule.parseString behavior is inconsistent.
    // Modern rrule versions are generally good, but explicit Date conversion ensures type safety.

    const rule = new RRule(options);

    // Generate instances. The 'inc' parameter (3rd arg) means inclusive for rangeStartDate and rangeEndDate.
    const instances = rule.between(rangeStartDate, rangeEndDate, true);

    return instances;

  } catch (error) {
    console.error("Error processing RRULE string or generating instances:", error.message);
    console.error("RRULE String:", rruleString);
    console.error("Event Start:", eventStartDateTime);
    console.error("Range:", rangeStartDate, "-", rangeEndDate);
    // Depending on desired strictness, could throw the error or return empty array.
    // For this subtask, returning empty array on error.
    return [];
  }
}

module.exports = {
  getRecurrenceInstances,
};

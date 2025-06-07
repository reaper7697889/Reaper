// src/backend/services/schedulerService.js
const cron = require('node-cron');
const smartRuleService = require('./smartRuleService'); // To fetch rules and trigger execution
const { getDb } = require('../../db'); // For direct DB updates if needed (e.g., last_triggered_at)

const SYSTEM_USER_ID = 0; // Define a system user ID (e.g., 0 or -1)

const activeCronJobs = new Map(); // Stores cron jobs by ruleId
let intervalCheckTimer = null;
const CHECK_INTERVAL_MS = 60 * 1000; // Check interval-based rules every minute (configurable)

// Function to be called by the scheduler when a rule is triggered
// This will eventually call a more detailed function in smartRuleService
async function processRuleExecution(rule) {
    console.log(`Scheduler: Processing rule ID ${rule.id} (${rule.name}) of type ${rule.trigger_type}`);
    try {
        await smartRuleService.executeTimeBasedRule(rule.id, SYSTEM_USER_ID); // Pass SYSTEM_USER_ID

        if (rule.trigger_type === 'TIME_BASED_INTERVAL') {
            // Update last_triggered_at for interval rules after successful (or attempted) execution
            // This update might be better placed *inside* executeTimeBasedRule after it confirms action,
            // but for now, keeping it here signifies the scheduler attempted execution.
            const db = getDb();
            db.prepare("UPDATE smart_rules SET last_triggered_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(rule.id);
            console.log(`Scheduler: Updated last_triggered_at for interval rule ID ${rule.id}`);
        }
    } catch (error) {
        console.error(`Scheduler: Error processing rule ID ${rule.id}:`, error);
    }
}

function scheduleCronRule(rule) {
    if (!rule.schedule_cron || !cron.validate(rule.schedule_cron)) {
        console.error(`Scheduler: Invalid CRON string for rule ID ${rule.id}: ${rule.schedule_cron}. Skipping.`);
        return;
    }

    if (activeCronJobs.has(rule.id)) {
        activeCronJobs.get(rule.id).stop();
        activeCronJobs.delete(rule.id);
    }

    const job = cron.schedule(rule.schedule_cron, async () => {
        try {
            console.log(`Scheduler: CRON job triggered for rule ID ${rule.id} (${rule.name}) at ${new Date()}`);
            // Fetch the latest version of the rule in case it was updated
            const currentRule = await smartRuleService.getRuleById(rule.id);
            if (currentRule && currentRule.is_enabled && currentRule.trigger_type === 'TIME_BASED_SCHEDULE') {
                await processRuleExecution(currentRule);
            } else {
                console.log(`Scheduler: Rule ID ${rule.id} no longer active or type changed. CRON job will persist but skip execution.`);
                // Optionally, the job could self-destroy or be cleaned up if the rule is disabled/deleted.
            }
        } catch (error) {
            console.error(`Scheduler: Unhandled error in CRON job for rule ID ${rule.id}:`, error);
        }
    }, {
        timezone: rule.timezone || undefined // Use rule's timezone if provided
    });
    activeCronJobs.set(rule.id, job);
    console.log(`Scheduler: Scheduled CRON rule ID ${rule.id} (${rule.name}) with schedule: ${rule.schedule_cron}`);
}

async function checkAndRunIntervalRules() {
    // console.log("Scheduler: Checking interval-based rules...");
    const intervalRules = await smartRuleService.getAllEnabledRulesByTriggerType('TIME_BASED_INTERVAL');

    const now = Date.now();
    for (const rule of intervalRules) {
        const lastTriggeredTime = rule.last_triggered_at ? new Date(rule.last_triggered_at).getTime() : 0;
        const intervalSeconds = rule.schedule_interval_seconds;

        if (intervalSeconds && now >= lastTriggeredTime + (intervalSeconds * 1000)) {
            console.log(`Scheduler: Interval rule ID ${rule.id} (${rule.name}) is due. Last triggered: ${rule.last_triggered_at || 'never'}`);
            await processRuleExecution(rule); // rule object here already contains all necessary fields
        }
    }
}

async function loadAndScheduleAllTimeBasedRules() {
    console.log("Scheduler: Loading and scheduling all time-based rules...");
    activeCronJobs.forEach(job => job.stop());
    activeCronJobs.clear();

    const scheduleRules = await smartRuleService.getAllEnabledRulesByTriggerType('TIME_BASED_SCHEDULE');
    for (const rule of scheduleRules) {
        scheduleCronRule(rule);
    }
    // Interval rules are handled by the separate checkAndRunIntervalRules timer,
    // so no need to explicitly load them here for individual cron job scheduling.

    if (!intervalCheckTimer) {
        intervalCheckTimer = setInterval(checkAndRunIntervalRules, CHECK_INTERVAL_MS);
        console.log(`Scheduler: Interval check initiated every ${CHECK_INTERVAL_MS / 1000} seconds.`);
    }
     await checkAndRunIntervalRules(); // Run once on startup
}

function stopScheduler() {
    console.log("Scheduler: Stopping all scheduled jobs...");
    activeCronJobs.forEach(job => job.stop());
    activeCronJobs.clear();
    if (intervalCheckTimer) {
        clearInterval(intervalCheckTimer);
        intervalCheckTimer = null;
    }
    console.log("Scheduler: All jobs stopped.");
}

// Public interface for the scheduler
module.exports = {
    initialize: loadAndScheduleAllTimeBasedRules, // Renamed for clarity
    reloadRules: loadAndScheduleAllTimeBasedRules, // Function to manually reload/reschedule
    stop: stopScheduler,
    scheduleCronRule, // Export for dynamic scheduling
    unscheduleRule,   // Export for dynamic unscheduling
};

function unscheduleRule(ruleId) {
    if (activeCronJobs.has(ruleId)) {
        activeCronJobs.get(ruleId).stop();
        activeCronJobs.delete(ruleId);
        console.log(`Scheduler: Unscheduled CRON job for rule ID ${ruleId}.`);
        return true;
    }
    // console.log(`Scheduler: No active CRON job found for rule ID ${ruleId} to unschedule.`);
    return false;
}

// Initialize on load (call this from main app entry point)
// initialize();
// For this subtask, we define it but don't auto-call initialize().
// The main application would call schedulerService.initialize().

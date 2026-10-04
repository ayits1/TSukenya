/* Keep the documented B04 command; its create/receipt/payroll proof now uses the shared B06 panel. */
process.env.WORK_CONFLICT_FROM ||= 'primary';
require('./work-shift-conflict-ui.cjs');

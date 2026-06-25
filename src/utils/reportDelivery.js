import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://llmyvutkvrxnhzkptbar.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const getClient = () => {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for report delivery but is missing.");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
};

/**
 * Reads a daily report, resolves recipient contact info, performs pre-CRM validations,
 * and prepares the payload for CRM delivery.
 *
 * @param {string} reportId The UUID of the daily report row
 * @returns {Promise<Object>} Structured delivery response with prepared payload or validation failure details
 */
export async function sendDailyReport(reportId) {
  console.log(`[INFO] Preparing Delivery`);

  try {
    const supabase = getClient();

    // 1. Fetch and validate report
    const { data: report, error: reportErr } = await supabase
      .from('daily_reports')
      .select('*')
      .eq('id', reportId)
      .maybeSingle();

    if (reportErr) {
      console.warn(`[WARNING] Database error fetching report ${reportId}: ${reportErr.message}`);
      return { success: false, reason: "DATABASE_ERROR", details: reportErr.message };
    }
    if (!report) {
      console.warn(`[WARNING] Report delivery failed: Report ${reportId} not found.`);
      return { success: false, reason: "REPORT_MISSING" };
    }

    // 2. Validate WhatsApp message exists
    if (!report.whatsapp_message || !report.whatsapp_message.trim()) {
      console.warn(`[WARNING] Report delivery failed: WhatsApp message content missing in report ${reportId}.`);
      return { success: false, reason: "WHATSAPP_MESSAGE_MISSING" };
    }

    // 3. Fetch and validate household
    const { data: household, error: householdErr } = await supabase
      .from('households')
      .select('id, owner_id, property_name')
      .eq('id', report.household_id)
      .maybeSingle();

    if (householdErr) {
      console.warn(`[WARNING] Database error fetching household ${report.household_id}: ${householdErr.message}`);
      return { success: false, reason: "DATABASE_ERROR", details: householdErr.message };
    }
    if (!household) {
      console.warn(`[WARNING] Report delivery failed: Household ${report.household_id} not found.`);
      return { success: false, reason: "HOUSEHOLD_MISSING" };
    }

    // 4. Fetch and validate owner
    if (!household.owner_id) {
      console.warn(`[WARNING] Report delivery failed: Owner ID missing on household ${household.id}.`);
      return { success: false, reason: "OWNER_MISSING" };
    }

    const { data: ownerUser, error: userErr } = await supabase
      .from('user')
      .select('id, full_name, phone')
      .eq('id', household.owner_id)
      .maybeSingle();

    if (userErr) {
      console.warn(`[WARNING] Database error fetching owner ${household.owner_id}: ${userErr.message}`);
      return { success: false, reason: "DATABASE_ERROR", details: userErr.message };
    }
    if (!ownerUser) {
      console.warn(`[WARNING] Report delivery failed: Owner details not found for household ${household.id}.`);
      return { success: false, reason: "OWNER_MISSING" };
    }

    // 5. Validate phone number exists
    if (!ownerUser.phone || !ownerUser.phone.trim()) {
      console.warn(`[WARNING] Report delivery failed: Phone number missing for owner ${ownerUser.id}.`);
      return { success: false, reason: "PHONE_NUMBER_MISSING" };
    }

    const recipient = ownerUser.full_name || 'Zenacle User';
    const phone = ownerUser.phone.trim();
    console.log(`[INFO] Recipient Resolved`);

    // 6. Build frozen CRM payload
    const payload = {
      report_id: report.id,
      household_id: report.household_id,
      report_date: report.report_date,
      recipient_name: recipient,
      phone: phone,
      message: report.whatsapp_message,
      delivery_type: "daily_energy_report",
      source: "zenacle_home"
    };
    console.log(`[INFO] Payload Generated`);
    console.log(`[INFO] Ready For CRM Delivery`);

    return {
      success: true,
      reportId: report.id,
      householdId: report.household_id,
      recipient,
      phone,
      message: report.whatsapp_message,
      payload
    };

  } catch (error) {
    console.error(`[ERROR] Delivery Layer exception for report ${reportId}:`, error.message);
    return {
      success: false,
      reason: "UNEXPECTED_EXCEPTION",
      details: error.message
    };
  }
}

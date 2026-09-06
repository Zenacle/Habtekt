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
 * sends the payload to CRM, and updates daily_reports.delivery_status & delivered_at accordingly.
 *
 * @param {string} reportId The UUID of the daily report row
 * @returns {Promise<Object>} Structured delivery response with payload or error details
 */
export async function sendDailyReport(reportId) {
  console.log(`[INFO] [CRM_DELIVERY] Starting delivery for Report ID: ${reportId}`);
  const supabase = getClient();

  const markFailed = async (reason, details, httpStatus = null) => {
    console.error(`[ERROR] [CRM_DELIVERY] Report ID: ${reportId} | HTTP Status: ${httpStatus || 'N/A'} | CRM Result: Failed (${reason}) | DB Status Update: failed | Details: ${details || 'None'}`);
    try {
      await supabase
        .from('daily_reports')
        .update({ delivery_status: 'failed' })
        .eq('id', reportId);
    } catch (dbErr) {
      console.error(`[ERROR] [CRM_DELIVERY] Failed to update delivery_status to failed for report ${reportId}: ${dbErr.message}`);
    }
    return { success: false, reason, details, status: httpStatus };
  };

  try {
    // 1. Fetch and validate report
    const { data: report, error: reportErr } = await supabase
      .from('daily_reports')
      .select('*')
      .eq('id', reportId)
      .maybeSingle();

    if (reportErr) {
      return await markFailed("DATABASE_ERROR", reportErr.message);
    }
    if (!report) {
      return await markFailed("REPORT_MISSING", `Report ${reportId} not found`);
    }

    // 2. Retry Safety: If already delivered, skip dispatch to avoid duplicate messages
    if (report.delivery_status === 'delivered') {
      console.log(`[INFO] [CRM_DELIVERY] Report ID: ${reportId} already marked as delivered at ${report.delivered_at}. Skipping CRM dispatch.`);
      return { success: true, reportId: report.id, alreadyDelivered: true, status: 200 };
    }

    // 3. Validate WhatsApp message exists
    if (!report.whatsapp_message || !report.whatsapp_message.trim()) {
      return await markFailed("WHATSAPP_MESSAGE_MISSING", `WhatsApp message content missing in report ${reportId}`);
    }

    // 4. Fetch and validate household
    const { data: household, error: householdErr } = await supabase
      .from('households')
      .select('id, owner_id, property_name')
      .eq('id', report.household_id)
      .maybeSingle();

    if (householdErr) {
      return await markFailed("DATABASE_ERROR", householdErr.message);
    }
    if (!household) {
      return await markFailed("HOUSEHOLD_MISSING", `Household ${report.household_id} not found`);
    }

    // 5. Fetch and validate owner
    if (!household.owner_id) {
      return await markFailed("OWNER_MISSING", `Owner ID missing on household ${household.id}`);
    }

    const { data: ownerUser, error: userErr } = await supabase
      .from('user')
      .select('id, full_name, phone')
      .eq('id', household.owner_id)
      .maybeSingle();

    if (userErr) {
      return await markFailed("DATABASE_ERROR", userErr.message);
    }
    if (!ownerUser) {
      return await markFailed("OWNER_MISSING", `Owner details not found for household ${household.id}`);
    }

    // 6. Validate phone number exists
    if (!ownerUser.phone || !ownerUser.phone.trim()) {
      return await markFailed("PHONE_NUMBER_MISSING", `Phone number missing for owner ${ownerUser.id}`);
    }

    const recipient = ownerUser.full_name || 'Zenacle User';
    const phone = ownerUser.phone.trim();

    // 7. Build frozen CRM payload
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

    const crmUrl = process.env.CRM_INTEGRATION_URL || 'http://localhost:3000/api/integrations/zenacle-home';
    const secret = process.env.CRM_INTEGRATION_SECRET;

    const maxRetries = 3;
    let attempt = 0;
    let response = null;
    let lastError = null;

    while (attempt < maxRetries) {
      attempt++;
      console.log(`[INFO] [CRM_DELIVERY] Sending report ${reportId} to CRM (Attempt ${attempt}/${maxRetries})...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        response = await fetch(crmUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${secret}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const deliveredAt = new Date().toISOString();
          console.log(`[INFO] [CRM_DELIVERY] Report ID: ${reportId} | HTTP Status: ${response.status} | CRM Result: Success | Updating DB status to delivered...`);
          
          const { error: updateErr } = await supabase
            .from('daily_reports')
            .update({
              delivery_status: 'delivered',
              delivered_at: deliveredAt
            })
            .eq('id', report.id);

          if (updateErr) {
            console.error(`[ERROR] [CRM_DELIVERY] Report ID: ${reportId} | HTTP Status: ${response.status} | DB Status Update Failed: ${updateErr.message}`);
          } else {
            console.log(`[INFO] [CRM_DELIVERY] Report ID: ${reportId} | DB Status Update: delivered (at ${deliveredAt})`);
          }

          return {
            success: true,
            reportId: report.id,
            householdId: report.household_id,
            recipient,
            phone,
            status: response.status,
            deliveredAt,
            payload
          };
        } else {
          console.error(`[ERROR] [CRM_DELIVERY] Report ID: ${reportId} | HTTP Status: ${response.status} | CRM POST failed.`);
          if (response.status >= 400 && response.status < 500) {
            return await markFailed("CRM_DELIVERY_FAILED", `CRM responded with HTTP status ${response.status}`, response.status);
          }
          lastError = new Error(`CRM responded with HTTP status ${response.status}`);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[ERROR] [CRM_DELIVERY] Report ID: ${reportId} | Attempt ${attempt} failed: ${error.message}`);
        lastError = error;
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const reason = lastError && lastError.name === 'AbortError' ? "CRM_TIMEOUT" : "CRM_UNAVAILABLE";
    return await markFailed(reason, lastError ? lastError.message : "Max retries reached", response?.status || null);

  } catch (error) {
    return await markFailed("UNEXPECTED_EXCEPTION", error.message);
  }
}

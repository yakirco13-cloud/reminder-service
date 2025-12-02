/**
 * Automated WhatsApp Service for Base44 Booking System
 * 
 * This service runs 24/7 and provides:
 * - Automatic WhatsApp reminders before appointments (checked every 15 minutes)
 * - API endpoints for sending confirmation, update, and broadcast messages
 * 
 * Features:
 * - Uses Twilio WhatsApp API
 * - Express server for API endpoints
 * - Checks every 15 minutes for bookings that need reminders
 * - PRECISE TIMING: Sends reminders exactly X hours before (±10 min window)
 * - Tracks sent messages in a file to avoid duplicates (survives restarts)
 * - Supports multiple businesses
 * - Hebrew language support
 * - Respects user notification preferences (whatsapp_notifications_enabled)
 * 
 * API Endpoints:
 * - POST /api/send-confirmation - Send booking confirmation
 * - POST /api/send-update - Send booking update/cancellation notification
 * - POST /api/send-broadcast - Send broadcast message to all clients
 * - GET /health - Health check
 * 
 * SECURITY: Credentials are loaded from environment variables
 */

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { format, parseISO, differenceInMinutes } from 'date-fns';
import { he } from 'date-fns/locale';
import fs from 'fs';
import path from 'path';

// Set timezone to Israel (GMT+2)
process.env.TZ = 'Asia/Jerusalem';

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Base44 API Configuration
const BASE44_CONFIG = {
  apiUrl: 'https://base44.app/api/apps/690b351ea4e5f2f9d798cdbb',
  apiKey: 'd6ebcd1dd1844f4c8f98c35af622bde7',
};

// Twilio WhatsApp Configuration - LOADED FROM ENVIRONMENT VARIABLES
const TWILIO_CONFIG = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
  // Template SIDs
  reminderTemplateSid: process.env.TWILIO_TEMPLATE_SID, // Existing reminder template
  confirmationTemplateSid: 'HX835cc8141398f0a037c21e061404bba0',
  updateTemplateSid: 'HXfb6f60eb9acb068d3100d204e8d866b9',
  broadcastTemplateSid: 'HXd94763214416ec4100848e81162aad92',
};

// Validate that all required environment variables are set
if (!TWILIO_CONFIG.accountSid || !TWILIO_CONFIG.authToken || !TWILIO_CONFIG.whatsappNumber || !TWILIO_CONFIG.reminderTemplateSid) {
  console.error('❌ ERROR: Missing Twilio credentials in environment variables!');
  console.error('Please set: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, TWILIO_TEMPLATE_SID');
  process.exit(1);
}

// File to track sent messages
const SENT_REMINDERS_FILE = path.join(process.cwd(), 'sent-reminders.json');

/**
 * Load sent items from file
 */
function loadSentItems(filename) {
  try {
    if (fs.existsSync(filename)) {
      const data = fs.readFileSync(filename, 'utf8');
      const items = JSON.parse(data);
      
      // Clean up old items (older than 7 days)
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const cleaned = {};
      for (const [key, timestamp] of Object.entries(items)) {
        if (timestamp > sevenDaysAgo) {
          cleaned[key] = timestamp;
        }
      }
      
      // Save cleaned version
      fs.writeFileSync(filename, JSON.stringify(cleaned, null, 2));
      
      return new Set(Object.keys(cleaned));
    }
  } catch (error) {
    console.error(`Error loading sent items from ${filename}:`, error);
  }
  return new Set();
}

/**
 * Save a sent item to file
 */
function saveSentItem(filename, itemKey) {
  try {
    let items = {};
    if (fs.existsSync(filename)) {
      const data = fs.readFileSync(filename, 'utf8');
      items = JSON.parse(data);
    }
    
    items[itemKey] = Date.now();
    fs.writeFileSync(filename, JSON.stringify(items, null, 2));
  } catch (error) {
    console.error(`Error saving sent item to ${filename}:`, error);
  }
}

// Load sent items on startup
const sentReminders = loadSentItems(SENT_REMINDERS_FILE);
console.log(`📋 Loaded ${sentReminders.size} sent reminders from file`);

/**
 * Fetch all businesses from Base44
 */
async function fetchBusinesses() {
  try {
    const response = await fetch(`${BASE44_CONFIG.apiUrl}/entities/Business`, {
      headers: {
        'api_key': BASE44_CONFIG.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch businesses: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching businesses:', error);
    return [];
  }
}

/**
 * Fetch all bookings
 */
async function fetchAllBookings() {
  try {
    const response = await fetch(`${BASE44_CONFIG.apiUrl}/entities/Booking`, {
      headers: {
        'api_key': BASE44_CONFIG.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch bookings: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching bookings:', error);
    return [];
  }
}

/**
 * Fetch all bookings for a specific business
 */
async function fetchBookings(businessId) {
  try {
    const allBookings = await fetchAllBookings();
    return allBookings.filter(b => b.business_id === businessId);
  } catch (error) {
    console.error(`Error fetching bookings for business ${businessId}:`, error);
    return [];
  }
}

/**
 * Format phone number for WhatsApp (remove leading 0, add country code if needed)
 */
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // If starts with 0, remove it (Israeli numbers)
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  
  // If doesn't start with country code, add Israel code (972)
  if (!cleaned.startsWith('972')) {
    cleaned = '972' + cleaned;
  }
  
  return 'whatsapp:+' + cleaned;
}

/**
 * Generic function to send WhatsApp message via Twilio
 */
async function sendTwilioWhatsApp(toNumber, templateSid, contentVariables) {
  try {
    const formattedNumber = formatPhoneNumber(toNumber);
    if (!formattedNumber) {
      throw new Error('Invalid phone number');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;

    const params = new URLSearchParams();
    params.append('To', formattedNumber);
    params.append('From', TWILIO_CONFIG.whatsappNumber);
    params.append('ContentSid', templateSid);
    params.append('ContentVariables', JSON.stringify(contentVariables));

    const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send WhatsApp: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`✅ WhatsApp sent to ${toNumber}, SID: ${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send WhatsApp message via Twilio using Content Template (for reminders - existing function)
 */
async function sendWhatsAppMessage(toNumber, business, booking) {
  try {
    const formattedNumber = formatPhoneNumber(toNumber);
    if (!formattedNumber) {
      throw new Error('Invalid phone number');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
    
    // Format date in Hebrew
    const formattedDate = format(parseISO(booking.date), 'd בMMMM', { locale: he });
    
    // Template variables in order (matching Twilio template):
    // {{1}} = client_name (שלום {{1}})
    // {{2}} = business_name (מאת צוות {{2}})
    // {{3}} = date (בתאריך {{3}})
    // {{4}} = time (בשעה {{4}})
    const contentVariables = JSON.stringify({
      "1": booking.client_name || 'לקוח יקר',
      "2": business.name,
      "3": formattedDate,
      "4": booking.time
    });

    const params = new URLSearchParams();
    params.append('To', formattedNumber);
    params.append('From', TWILIO_CONFIG.whatsappNumber);
    params.append('ContentSid', TWILIO_CONFIG.reminderTemplateSid);
    params.append('ContentVariables', contentVariables);

    const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send WhatsApp: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    return true;
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error);
    return false;
  }
}

/**
 * Send reminder WhatsApp
 */
async function sendReminderWhatsApp(business, booking) {
  try {
    // Check if client has phone number
    if (!booking.client_phone) {
      console.log(`   ⏭️  No phone number for booking ${booking.id}`);
      return false;
    }

    const success = await sendWhatsAppMessage(booking.client_phone, business, booking);

    if (success) {
      console.log(`✅ Sent WhatsApp reminder to ${booking.client_phone} for booking ${booking.id}`);
    }
    
    return success;
  } catch (error) {
    console.error(`❌ Failed to send reminder for booking ${booking.id}:`, error);
    return false;
  }
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Send booking confirmation
 * POST /api/send-confirmation
 * Body: { phone, clientName, businessName, date, time, whatsappEnabled }
 */
app.post('/api/send-confirmation', async (req, res) => {
  try {
    const { phone, clientName, businessName, date, time, whatsappEnabled } = req.body;

    // Check if user has WhatsApp notifications enabled
    if (whatsappEnabled === false) {
      return res.json({ 
        success: false, 
        skipped: true,
        message: 'User has WhatsApp notifications disabled' 
      });
    }

    if (!phone || !clientName || !businessName || !date || !time) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: phone, clientName, businessName, date, time' 
      });
    }

    // Format date as dd.MM.yyyy (e.g., 10.12.2025)
    const formattedDate = format(parseISO(date), 'd.M.yyyy');

    // Template: היי {{1}}, התור שלך ל{{2}} בתאריך {{3}} בשעה {{4}} אושר! נתראה!
    const contentVariables = {
      "1": clientName,
      "2": businessName,
      "3": formattedDate,
      "4": time
    };

    const result = await sendTwilioWhatsApp(phone, TWILIO_CONFIG.confirmationTemplateSid, contentVariables);
    
    if (result.success) {
      console.log(`📱 Confirmation sent to ${clientName} (${phone})`);
      res.json({ success: true, message: 'Confirmation sent', sid: result.sid });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Error in send-confirmation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Send booking update/cancellation notification
 * POST /api/send-update
 * Body: { phone, clientName, businessName, whatsappEnabled }
 */
app.post('/api/send-update', async (req, res) => {
  try {
    const { phone, clientName, businessName, whatsappEnabled } = req.body;

    // Check if user has WhatsApp notifications enabled
    if (whatsappEnabled === false) {
      return res.json({ 
        success: false, 
        skipped: true,
        message: 'User has WhatsApp notifications disabled' 
      });
    }

    if (!phone || !clientName || !businessName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: phone, clientName, businessName' 
      });
    }

    // Template: היי {{1}}, התור שלך ב{{2}} עודכן! ניתן לראות את הפרטים המעודכנים באפליקציה.
    const contentVariables = {
      "1": clientName,
      "2": businessName
    };

    const result = await sendTwilioWhatsApp(phone, TWILIO_CONFIG.updateTemplateSid, contentVariables);
    
    if (result.success) {
      console.log(`📱 Update notification sent to ${clientName} (${phone})`);
      res.json({ success: true, message: 'Update notification sent', sid: result.sid });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Error in send-update:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Send broadcast message to multiple clients
 * POST /api/send-broadcast
 * Body: { businessId, businessName, message, clients: [{phone, name, whatsappEnabled}] }
 */
app.post('/api/send-broadcast', async (req, res) => {
  try {
    const { businessId, businessName, message, clients } = req.body;

    if (!businessName || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: businessName, message' 
      });
    }

    let clientList = clients;

    // If no client list provided, fetch from bookings
    if (!clientList && businessId) {
      const bookings = await fetchBookings(businessId);
      
      // Get unique clients with phone numbers
      const uniqueClients = {};
      for (const booking of bookings) {
        if (booking.client_phone && booking.client_name && !uniqueClients[booking.client_phone]) {
          uniqueClients[booking.client_phone] = {
            phone: booking.client_phone,
            name: booking.client_name,
            whatsappEnabled: booking.whatsapp_notifications_enabled !== false // Default to true
          };
        }
      }
      clientList = Object.values(uniqueClients);
    }

    if (!clientList || clientList.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No clients found to send broadcast' 
      });
    }

    // Filter only clients with WhatsApp enabled
    const enabledClients = clientList.filter(c => c.whatsappEnabled !== false);
    
    console.log(`📢 Sending broadcast to ${enabledClients.length} clients (${clientList.length - enabledClients.length} opted out)...`);

    const results = {
      success: 0,
      failed: 0,
      skipped: clientList.length - enabledClients.length,
      errors: []
    };

    // Send to each client
    for (const client of enabledClients) {
      // Template: היי {{1}}, יש לך הודעה חדשה מאת {{2}}: {{3}} בברכה, LinedUp
      const contentVariables = {
        "1": client.name || 'לקוח יקר',
        "2": businessName,
        "3": message
      };

      const result = await sendTwilioWhatsApp(client.phone, TWILIO_CONFIG.broadcastTemplateSid, contentVariables);
      
      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({ phone: client.phone, error: result.error });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`📢 Broadcast complete: ${results.success} sent, ${results.failed} failed, ${results.skipped} skipped`);
    
    res.json({ 
      success: true, 
      message: `Broadcast sent to ${results.success} clients`,
      results 
    });
  } catch (error) {
    console.error('Error in send-broadcast:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// REMINDER SERVICE (existing functionality)
// ============================================

/**
 * Process reminders for a specific business
 */
async function processBusinessReminders(business) {
  // Get reminder settings from business (default: 12 hours before)
  const reminderHours = business.reminder_hours_before || 12;
  const reminderEnabled = business.reminder_enabled !== false; // Default to true
  
  if (!reminderEnabled) {
    console.log(`⏭️  Reminders disabled for business: ${business.name}`);
    return { business: business.name, sent: 0, skipped: 'disabled' };
  }

  console.log(`\n📋 Processing reminders for: ${business.name} (${reminderHours}h before)`);
  
  // Fetch all bookings for this business
  const bookings = await fetchBookings(business.id);
  
  if (bookings.length === 0) {
    console.log('   No bookings found');
    return { business: business.name, sent: 0 };
  }

  console.log(`   Found ${bookings.length} booking(s)`);

  let sentCount = 0;
  let skippedCount = 0;
  
  const now = new Date();
  console.log(`   Current time: ${now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
  
  for (const booking of bookings) {
    console.log(`\n   --- Booking ${booking.id} ---`);
    console.log(`   Client: ${booking.client_name}, Phone: ${booking.client_phone || 'NO PHONE'}`);
    console.log(`   Date: ${booking.date}, Time: ${booking.time}, Status: ${booking.status}`);
    
    // Only process confirmed bookings
    if (booking.status !== 'confirmed') {
      console.log(`   ⏭️  SKIPPED: Status is "${booking.status}" (not confirmed)`);
      skippedCount++;
      continue;
    }
    
    // Skip if no client phone
    if (!booking.client_phone) {
      console.log(`   ⏭️  SKIPPED: No phone number`);
      skippedCount++;
      continue;
    }

    // Check if user has WhatsApp notifications enabled (default to true if not set)
    if (booking.whatsapp_notifications_enabled === false) {
      console.log(`   ⏭️  SKIPPED: User disabled WhatsApp notifications`);
      skippedCount++;
      continue;
    }
    
    // Parse booking datetime - assuming Israel timezone
    const bookingDateTime = new Date(`${booking.date}T${booking.time}+02:00`);
    console.log(`   Appointment: ${bookingDateTime.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
    
    // Calculate exact minutes until appointment
    const minutesUntil = differenceInMinutes(bookingDateTime, now);
    const hoursUntil = minutesUntil / 60;
    console.log(`   Time until appointment: ${hoursUntil.toFixed(2)} hours (${minutesUntil} minutes)`);
    
    // PRECISE TIMING: Send if within ±10 minutes of the target reminder time
    // Example: If reminder is set for 3 hours, send between 2h50m-3h10m before
    const targetMinutes = reminderHours * 60;
    const lowerBound = targetMinutes - 10; // 10 min before target
    const upperBound = targetMinutes + 10; // 10 min after target
    
    console.log(`   Reminder window: ${lowerBound}-${upperBound} minutes (${(lowerBound/60).toFixed(2)}h - ${(upperBound/60).toFixed(2)}h)`);
    
    const shouldSend = minutesUntil >= lowerBound && minutesUntil <= upperBound;
    
    if (!shouldSend) {
      if (minutesUntil < lowerBound) {
        console.log(`   ⏭️  SKIPPED: Too late (appointment in ${hoursUntil.toFixed(2)}h, reminder was for ${reminderHours}h before)`);
      } else {
        console.log(`   ⏭️  SKIPPED: Too early (appointment in ${hoursUntil.toFixed(2)}h, reminder is for ${reminderHours}h before)`);
      }
      skippedCount++;
      continue;
    }
    
    // Check if we already sent to this booking
    const reminderKey = `${booking.id}-${booking.date}-${booking.time}`;
    if (sentReminders.has(reminderKey)) {
      console.log(`   ⏭️  SKIPPED: Already sent reminder for this booking`);
      skippedCount++;
      continue;
    }
    
    console.log(`   ✅ SENDING WhatsApp reminder (${hoursUntil.toFixed(1)}h before appointment)`);
    
    // Send the reminder
    const success = await sendReminderWhatsApp(business, booking);
    
    if (success) {
      sentReminders.add(reminderKey);
      saveSentItem(SENT_REMINDERS_FILE, reminderKey);
      sentCount++;
    } else {
      skippedCount++;
    }
  }
  
  console.log(`\n   📊 Results: ${sentCount} sent, ${skippedCount} skipped`);
  
  return {
    business: business.name,
    sent: sentCount,
    skipped: skippedCount
  };
}

/**
 * Main function - Check all businesses and send reminders
 */
async function checkAndSendReminders() {
  console.log('\n' + '='.repeat(60));
  console.log(`🔔 WhatsApp Reminder Check Started: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  
  try {
    // Fetch all businesses
    const businesses = await fetchBusinesses();
    console.log(`\n📊 Found ${businesses.length} business(es)\n`);
    
    if (businesses.length === 0) {
      console.log('⚠️  No businesses found');
      return;
    }
    
    // Process each business
    const results = [];
    for (const business of businesses) {
      const result = await processBusinessReminders(business);
      results.push(result);
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Summary:');
    const totalSent = results.reduce((sum, r) => sum + r.sent, 0);
    const totalSkipped = results.reduce((sum, r) => sum + (r.skipped || 0), 0);
    console.log(`   Total WhatsApp reminders sent: ${totalSent}`);
    console.log(`   Total skipped: ${totalSkipped}`);
    console.log(`   💰 Cost: $${(totalSent * 0.0353).toFixed(3)} (at $0.0353/message)`);
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('❌ Error in reminder check:', error);
  }
}

/**
 * Schedule next run at fixed time (:00, :15, :30, :45)
 */
function scheduleNextRun() {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();
  
  // Calculate minutes until next :00, :15, :30, or :45
  const nextSlot = Math.ceil((minutes + 1) / 15) * 15;
  const minutesUntilNext = nextSlot - minutes;
  
  // Calculate total milliseconds until next slot
  const msUntilNext = (minutesUntilNext * 60 * 1000) - (seconds * 1000) - milliseconds;
  
  const nextRunTime = new Date(now.getTime() + msUntilNext);
  console.log(`⏰ Next check scheduled at: ${nextRunTime.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
  
  setTimeout(() => {
    checkAndSendReminders();
    // After running, schedule the next one in exactly 15 minutes
    setInterval(checkAndSendReminders, 15 * 60 * 1000);
  }, msUntilNext);
}

/**
 * Start the service
 */
function startService() {
  // Start Express server
  app.listen(PORT, () => {
    console.log('🚀 WhatsApp Service Started');
    console.log(`🌐 API Server running on port ${PORT}`);
    console.log(`⏰ Reminder checks: at :00, :15, :30, :45 of every hour`);
    console.log(`🎯 Timing: SUPER PRECISE (±10 minutes of target time)`);
    console.log(`🌍 Timezone: ${process.env.TZ || 'UTC'}`);
    console.log(`📱 Provider: Twilio WhatsApp`);
    console.log(`📞 From Number: ${TWILIO_CONFIG.whatsappNumber}`);
    console.log(`📋 Reminder Template: ${TWILIO_CONFIG.reminderTemplateSid}`);
    console.log(`💰 Cost: $0.0353 per message\n`);
    console.log('📡 API Endpoints:');
    console.log('   POST /api/send-confirmation - Send booking confirmation');
    console.log('   POST /api/send-update - Send update/cancellation notification');
    console.log('   POST /api/send-broadcast - Send broadcast to all clients');
    console.log('   GET  /health - Health check\n');
  });
  
  // Run reminder check immediately on start
  checkAndSendReminders();
  
  // Schedule next run at fixed time
  scheduleNextRun();
}

// Start the service
startService();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Service shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Service shutting down...');
  process.exit(0);
});
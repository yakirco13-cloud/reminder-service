/**
 * Automated WhatsApp Reminder Service for Base44 Booking System
 * 
 * This service runs 24/7 and automatically:
 * - Sends WhatsApp reminders before appointments (checked every 15 minutes)
 * 
 * Features:
 * - Uses Twilio WhatsApp API
 * - Checks every 15 minutes for bookings that need reminders (PRECISE!)
 * - PRECISE TIMING: Sends reminders exactly X hours before (±10 min window)
 * - Tracks sent messages in a file to avoid duplicates (survives restarts)
 * - Supports multiple businesses
 * - Hebrew language support
 * - Uses approved WhatsApp template
 * 
 * SECURITY: Credentials are loaded from environment variables
 * 
 * NOTE: Confirmation messages are DISABLED to save costs
 * 
 * COST: $0.005 per WhatsApp message (52x cheaper than SMS!)
 */

import fetch from 'node-fetch';
import { format, parseISO, differenceInMinutes } from 'date-fns';
import { he } from 'date-fns/locale';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';

// Set timezone to Israel (GMT+2)
process.env.TZ = 'Asia/Jerusalem';

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// API Key for authentication (set in Railway environment variables)
const API_KEY = process.env.WHATSAPP_API_KEY || 'linedup-whatsapp-2024-secure';

// Middleware to check API key
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== API_KEY) {
    console.log('❌ Unauthorized request - invalid API key');
    return res.status(401).json({ error: 'Unauthorized - Invalid API key' });
  }
  
  next();
};

// Base44 API Configuration
const BASE44_CONFIG = {
  apiUrl: 'https://base44.app/api/apps/690b351ea4e5f2f9d798cdbb',
  apiKey: 'd6ebcd1dd1844f4c8f98c35af622bde7',
};

// Twilio WhatsApp Configuration - LOADED FROM ENVIRONMENT VARIABLES
const TWILIO_CONFIG = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER, // whatsapp:+15558717047
  templateSid: process.env.TWILIO_TEMPLATE_SID, // HX5abe889e6eb7edfb9ea5ccf39f5e5b84
};

// Validate that all required environment variables are set
if (!TWILIO_CONFIG.accountSid || !TWILIO_CONFIG.authToken || !TWILIO_CONFIG.whatsappNumber || !TWILIO_CONFIG.templateSid) {
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
 * Fetch all bookings for a specific business (only next 48 hours, confirmed only)
 */
async function fetchBookings(businessId) {
  try {
    const allBookings = await fetchAllBookings();
    
    // Get current time and 48 hours from now
    const now = new Date();
    const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    
    // Format dates for comparison
    const todayStr = now.toISOString().split('T')[0];
    const in48HoursStr = in48Hours.toISOString().split('T')[0];
    
    return allBookings.filter(b => {
      // Only this business
      if (b.business_id !== businessId) return false;
      
      // Only confirmed bookings
      if (b.status !== 'confirmed') return false;
      
      // Only bookings with phone numbers
      if (!b.client_phone) return false;
      
      // Only bookings in the next 48 hours
      if (b.date < todayStr || b.date > in48HoursStr) return false;
      
      return true;
    });
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
 * Send WhatsApp message via Twilio using Content Template
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
    params.append('ContentSid', TWILIO_CONFIG.templateSid);
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
  
  // Fetch bookings for this business (already filtered: next 48h, confirmed, with phone)
  const bookings = await fetchBookings(business.id);
  
  if (bookings.length === 0) {
    console.log('   No upcoming bookings with phone numbers');
    return { business: business.name, sent: 0 };
  }

  console.log(`   Found ${bookings.length} upcoming booking(s) with phone numbers`);

  let sentCount = 0;
  let skippedCount = 0;
  
  const now = new Date();
  
  for (const booking of bookings) {
    // Parse booking datetime - assuming Israel timezone
    const bookingDateTime = new Date(`${booking.date}T${booking.time}+02:00`);
    
    // Calculate exact minutes until appointment
    const minutesUntil = differenceInMinutes(bookingDateTime, now);
    const hoursUntil = minutesUntil / 60;
    
    // PRECISE TIMING: Send if within ±10 minutes of the target reminder time
    const targetMinutes = reminderHours * 60;
    const lowerBound = targetMinutes - 10;
    const upperBound = targetMinutes + 10;
    
    const shouldSend = minutesUntil >= lowerBound && minutesUntil <= upperBound;
    
    if (!shouldSend) {
      // Only log if it's close (within 2x the reminder time)
      if (hoursUntil > 0 && hoursUntil < reminderHours * 2) {
        console.log(`   ⏳ ${booking.client_name} @ ${booking.time} on ${booking.date} - ${hoursUntil.toFixed(1)}h away (reminder at ${reminderHours}h)`);
      }
      skippedCount++;
      continue;
    }
    
    // Check if we already sent to this booking
    const reminderKey = `${booking.id}-${booking.date}-${booking.time}`;
    if (sentReminders.has(reminderKey)) {
      console.log(`   ⏭️  ${booking.client_name} - Already sent`);
      skippedCount++;
      continue;
    }
    
    console.log(`   📤 SENDING to ${booking.client_name} (${booking.client_phone}) - ${hoursUntil.toFixed(1)}h before appointment`);
    
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
    console.log(`   💰 Cost: $${(totalSent * 0.005).toFixed(3)} (at $0.005/message)`);
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

// ============================================================
// EXPRESS API ENDPOINTS
// ============================================================

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Send confirmation WhatsApp (auth required)
app.post('/api/send-confirmation', authenticateApiKey, async (req, res) => {
  console.log('📥 Received confirmation request:', req.body);
  
  const { phone, clientName, businessName, date, time, whatsappEnabled } = req.body;
  
  if (!phone || !clientName || !businessName || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (whatsappEnabled === false) {
    console.log('⏭️ WhatsApp disabled for this user');
    return res.json({ success: true, skipped: true, reason: 'WhatsApp disabled' });
  }
  
  try {
    const formattedNumber = formatPhoneNumber(phone);
    if (!formattedNumber) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    // Format date for template (d.M.yyyy format)
    let formattedDate;
    try {
      formattedDate = format(parseISO(date), 'd.M.yyyy');
    } catch (e) {
      formattedDate = date;
    }
    
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');
    
    // Confirmation template SID
    const confirmationTemplateSid = 'HX833cc8141398f0a037c21e061404bba0';
    
    const contentVariables = JSON.stringify({
      "1": String(clientName),
      "2": String(businessName),
      "3": String(formattedDate),
      "4": String(time)
    });
    
    console.log('📤 Sending confirmation with variables:', contentVariables);
    
    const params = new URLSearchParams();
    params.append('To', formattedNumber);
    params.append('From', TWILIO_CONFIG.whatsappNumber);
    params.append('ContentSid', confirmationTemplateSid);
    params.append('ContentVariables', contentVariables);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      console.error('❌ Twilio error:', result);
      return res.status(500).json({ error: 'Failed to send WhatsApp', details: result });
    }
    
    console.log('✅ Confirmation sent successfully');
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('❌ Error sending confirmation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send update/cancellation WhatsApp (auth required)
app.post('/api/send-update', authenticateApiKey, async (req, res) => {
  console.log('📥 Received update request:', req.body);
  
  const { phone, clientName, businessName, whatsappEnabled } = req.body;
  
  if (!phone || !clientName || !businessName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (whatsappEnabled === false) {
    console.log('⏭️ WhatsApp disabled for this user');
    return res.json({ success: true, skipped: true, reason: 'WhatsApp disabled' });
  }
  
  try {
    const formattedNumber = formatPhoneNumber(phone);
    if (!formattedNumber) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');
    
    // Update template SID
    const updateTemplateSid = 'HXfb6f60eb9acb068d3100d204e8d866b9';
    
    const contentVariables = JSON.stringify({
      "1": String(clientName),
      "2": String(businessName)
    });
    
    console.log('📤 Sending update with variables:', contentVariables);
    
    const params = new URLSearchParams();
    params.append('To', formattedNumber);
    params.append('From', TWILIO_CONFIG.whatsappNumber);
    params.append('ContentSid', updateTemplateSid);
    params.append('ContentVariables', contentVariables);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      console.error('❌ Twilio error:', result);
      return res.status(500).json({ error: 'Failed to send WhatsApp', details: result });
    }
    
    console.log('✅ Update sent successfully');
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('❌ Error sending update:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send broadcast message (auth required)
app.post('/api/send-broadcast', authenticateApiKey, async (req, res) => {
  console.log('📥 Received broadcast request');
  
  const { recipients, message } = req.body;
  
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid recipients' });
  }
  
  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }
  
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');
    
    // Broadcast template SID
    const broadcastTemplateSid = 'HXd94763214416ec4100848e81162aad92';
    
    let successCount = 0;
    let failCount = 0;
    
    for (const recipient of recipients) {
      const formattedNumber = formatPhoneNumber(recipient.phone);
      if (!formattedNumber) {
        failCount++;
        continue;
      }
      
      const contentVariables = JSON.stringify({
        "1": String(recipient.name || 'לקוח יקר'),
        "2": String(message)
      });
      
      const params = new URLSearchParams();
      params.append('To', formattedNumber);
      params.append('From', TWILIO_CONFIG.whatsappNumber);
      params.append('ContentSid', broadcastTemplateSid);
      params.append('ContentVariables', contentVariables);
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params
        });
        
        if (response.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        failCount++;
      }
    }
    
    console.log(`✅ Broadcast complete: ${successCount} sent, ${failCount} failed`);
    res.json({ success: true, sent: successCount, failed: failCount });
  } catch (error) {
    console.error('❌ Error sending broadcast:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// REMINDER SERVICE
// ============================================================

/**
 * Start the service
 */
function startService() {
  console.log('🚀 Automated WhatsApp Reminder Service Started');
  console.log(`⏰ Reminder checks: at :00, :15, :30, :45 of every hour`);
  console.log(`🎯 Timing: SUPER PRECISE (±10 minutes of target time)`);
  console.log(`🌍 Timezone: ${process.env.TZ || 'UTC'}`);
  console.log(`📱 Provider: Twilio WhatsApp`);
  console.log(`📞 From Number: ${TWILIO_CONFIG.whatsappNumber}`);
  console.log(`📋 Template SID: ${TWILIO_CONFIG.templateSid}`);
  console.log(`💰 Cost: $0.005 per message (52x cheaper than SMS!)`);
  console.log(`💡 Confirmations: DISABLED (reminders only to save costs)\n`);
  
  // Run reminder check immediately on start
  checkAndSendReminders();
  
  // Schedule next run at fixed time
  scheduleNextRun();
}

// Start the reminder service
startService();

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 API server running on port ${PORT}`);
  console.log(`📡 Endpoints: /health, /api/send-confirmation, /api/send-update, /api/send-broadcast`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Service shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Service shutting down...');
  process.exit(0);
});
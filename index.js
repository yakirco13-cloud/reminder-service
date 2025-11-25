/**
 * Automated SMS Reminder Service for Base44 Booking System
 * 
 * This service runs 24/7 and automatically:
 * - Sends SMS reminders before appointments (checked hourly)
 * 
 * Features:
 * - Uses Twilio for SMS messaging
 * - Checks every hour for bookings that need reminders
 * - PRECISE TIMING: Sends reminders exactly X hours before (±30 min window)
 * - Tracks sent messages in a file to avoid duplicates (survives restarts)
 * - Supports multiple businesses
 * - Hebrew language support
 * - Customizable message templates (edit the templates in this file)
 * 
 * SECURITY: Credentials are loaded from environment variables
 * 
 * NOTE: Confirmation messages are DISABLED to save SMS costs
 */

import fetch from 'node-fetch';
import { format, parseISO, differenceInHours, differenceInMinutes } from 'date-fns';
import { he } from 'date-fns/locale';
import fs from 'fs';
import path from 'path';

// Set timezone to Israel (GMT+2)
process.env.TZ = 'Asia/Jerusalem';

// Base44 API Configuration
const BASE44_CONFIG = {
  apiUrl: 'https://base44.app/api/apps/690b351ea4e5f2f9d798cdbb',
  apiKey: 'd6ebcd1dd1844f4c8f98c35af622bde7',
};

// Twilio API Configuration - LOADED FROM ENVIRONMENT VARIABLES
const TWILIO_CONFIG = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  phoneNumber: process.env.TWILIO_PHONE_NUMBER,
};

// Validate that all required environment variables are set
if (!TWILIO_CONFIG.accountSid || !TWILIO_CONFIG.authToken || !TWILIO_CONFIG.phoneNumber) {
  console.error('❌ ERROR: Missing Twilio credentials in environment variables!');
  console.error('Please set: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
  process.exit(1);
}

// MESSAGE TEMPLATE - Edit this to customize your reminder message!
const MESSAGE_TEMPLATE = `שלום {client_name},

תזכורת לתור שלך {date} ב-{time} ב-{business_name}

שירות: {service_name} ({duration} דק')

נתראה! 
צוות {business_name}`;

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
 * Format phone number for SMS (remove leading 0, add country code if needed)
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
  
  return '+' + cleaned;
}

/**
 * Replace template variables with actual values
 */
function fillTemplate(template, business, booking) {
  return template
    .replace(/{client_name}/g, booking.client_name || 'לקוח יקר')
    .replace(/{date}/g, format(parseISO(booking.date), 'd בMMMM', { locale: he }))
    .replace(/{time}/g, booking.time)
    .replace(/{business_name}/g, business.name)
    .replace(/{service_name}/g, booking.service_name)
    .replace(/{duration}/g, booking.duration);
}

/**
 * Send SMS via Twilio
 */
async function sendSMS(toNumber, message) {
  try {
    const formattedNumber = formatPhoneNumber(toNumber);
    if (!formattedNumber) {
      throw new Error('Invalid phone number');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
    
    const params = new URLSearchParams();
    params.append('To', formattedNumber);
    params.append('From', TWILIO_CONFIG.phoneNumber);
    params.append('Body', message);

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
      throw new Error(`Failed to send SMS: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    return true;
  } catch (error) {
    console.error('Failed to send SMS:', error);
    return false;
  }
}

/**
 * Send reminder SMS
 */
async function sendReminderSMS(business, booking) {
  try {
    // Check if client has phone number
    if (!booking.client_phone) {
      console.log(`   ⏭️  No phone number for booking ${booking.id}`);
      return false;
    }

    const message = fillTemplate(MESSAGE_TEMPLATE, business, booking);
    const success = await sendSMS(booking.client_phone, message);

    if (success) {
      console.log(`✅ Sent SMS reminder to ${booking.client_phone} for booking ${booking.id}`);
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
  
  // Fetch all bookings for this business
  const bookings = await fetchBookings(business.id);
  
  if (bookings.length === 0) {
    console.log('   No bookings found');
    return { business: business.name, sent: 0 };
  }

  let sentCount = 0;
  let skippedCount = 0;
  
  const now = new Date();
  
  for (const booking of bookings) {
    // Only process confirmed bookings
    if (booking.status !== 'confirmed') {
      continue;
    }
    
    // Skip if no client phone
    if (!booking.client_phone) {
      skippedCount++;
      continue;
    }
    
    // Parse booking datetime - assuming Israel timezone
    const bookingDateTime = new Date(`${booking.date}T${booking.time}+02:00`);
    
    // Calculate exact minutes until appointment
    const minutesUntil = differenceInMinutes(bookingDateTime, now);
    const hoursUntil = minutesUntil / 60;
    
    // PRECISE TIMING: Send if within ±30 minutes of the target reminder time
    // Example: If reminder is set for 3 hours, send between 2.5-3.5 hours before
    const targetMinutes = reminderHours * 60;
    const lowerBound = targetMinutes - 30; // 30 min before target
    const upperBound = targetMinutes + 30; // 30 min after target
    
    const shouldSend = minutesUntil >= lowerBound && minutesUntil <= upperBound;
    
    if (shouldSend) {
      // Check if we already sent to this booking
      const reminderKey = `${booking.id}-${booking.date}-${booking.time}`;
      if (sentReminders.has(reminderKey)) {
        console.log(`   ⏭️  Already sent reminder for booking ${booking.id}`);
        skippedCount++;
        continue;
      }
      
      console.log(`   📤 Sending reminder for booking ${booking.id} (${hoursUntil.toFixed(1)}h before appointment)`);
      
      // Send the reminder
      const success = await sendReminderSMS(business, booking);
      
      if (success) {
        sentReminders.add(reminderKey);
        saveSentItem(SENT_REMINDERS_FILE, reminderKey);
        sentCount++;
      } else {
        skippedCount++;
      }
    }
  }
  
  console.log(`   📊 Results: ${sentCount} sent, ${skippedCount} skipped`);
  
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
  console.log(`🔔 Reminder Check Started: ${new Date().toISOString()}`);
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
    console.log(`   Total reminders sent: ${totalSent}`);
    console.log(`   Total skipped: ${totalSkipped}`);
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('❌ Error in reminder check:', error);
  }
}

/**
 * Start the service
 */
function startService() {
  console.log('🚀 Automated SMS Reminder Service Started');
  console.log(`⏰ Reminder checks: every hour`);
  console.log(`🎯 Timing: PRECISE (±30 minutes of target time)`);
  console.log(`🌍 Timezone: ${process.env.TZ || 'UTC'}`);
  console.log(`📱 SMS Provider: Twilio`);
  console.log(`📞 From Number: ${TWILIO_CONFIG.phoneNumber}`);
  console.log(`💡 Confirmations: DISABLED (reminders only to save costs)\n`);
  
  // Run reminder check immediately on start
  checkAndSendReminders();
  
  // Schedule reminder checks every hour
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(checkAndSendReminders, ONE_HOUR);
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

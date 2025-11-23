/**
 * Automated SMS Reminder & Confirmation Service for Base44 Booking System
 * 
 * This service runs 24/7 and automatically:
 * - Sends SMS reminders before appointments (checked hourly)
 * - Sends SMS confirmations when bookings are approved (checked every minute)
 * 
 * Features:
 * - Uses Twilio for SMS messaging
 * - Checks every hour for bookings that need reminders
 * - Checks every minute for newly approved bookings
 * - Sends reminders X hours before appointment (configurable per business)
 * - Tracks sent messages in a file to avoid duplicates (survives restarts)
 * - Supports multiple businesses
 * - Hebrew language support
 * - Customizable message templates (edit the templates in this file)
 */

import fetch from 'node-fetch';
import { format, parseISO, differenceInHours } from 'date-fns';
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

// Twilio API Configuration
const TWILIO_CONFIG = {
  accountSid: 'ACa59ff3a9b0c8ed933bfa214c68154b78',
  authToken: 'ba26df5822b832a9006be1b44638144e',
  phoneNumber: '+16184404560',
};

// MESSAGE TEMPLATES - Edit these to customize your messages!
const MESSAGE_TEMPLATES = {
  reminder: `שלום {client_name},

תזכורת לתור שלך {date} ב-{time} ב-{business_name}

שירות: {service_name} ({duration} דק')

נתראה! 
צוות {business_name}`,

  confirmation: `שלום {client_name},

התור שלך אושר! ✅

📅 {date} ב-{time}
✂️ {service_name} ({duration} דק')

נתראה!
{business_name}`
};

// Files to track sent messages
const SENT_REMINDERS_FILE = path.join(process.cwd(), 'sent-reminders.json');
const SENT_CONFIRMATIONS_FILE = path.join(process.cwd(), 'sent-confirmations.json');

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
const sentConfirmations = loadSentItems(SENT_CONFIRMATIONS_FILE);
console.log(`📋 Loaded ${sentReminders.size} sent reminders and ${sentConfirmations.size} sent confirmations from files`);

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

    const message = fillTemplate(MESSAGE_TEMPLATES.reminder, business, booking);
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
 * Send confirmation SMS when booking is approved
 */
async function sendConfirmationSMS(business, booking) {
  try {
    // Check if client has phone number
    if (!booking.client_phone) {
      console.log(`   ⏭️  No phone number for booking ${booking.id}`);
      return false;
    }

    const message = fillTemplate(MESSAGE_TEMPLATES.confirmation, business, booking);
    const success = await sendSMS(booking.client_phone, message);

    if (success) {
      console.log(`✅ Sent SMS confirmation to ${booking.client_phone} for booking ${booking.id}`);
    }
    
    return success;
  } catch (error) {
    console.error(`❌ Failed to send confirmation for booking ${booking.id}:`, error);
    return false;
  }
}

/**
 * Check for newly approved bookings and send confirmation SMS messages
 */
async function checkApprovals() {
  try {
    const businesses = await fetchBusinesses();
    const allBookings = await fetchAllBookings();
    
    let confirmationsSent = 0;
    
    for (const booking of allBookings) {
      // Only process confirmed bookings with phone number
      if (booking.status !== 'confirmed' || !booking.client_phone) {
        continue;
      }
      
      // Check if this is a newly confirmed booking (not booked by owner)
      if (booking.booked_by_owner) {
        continue; // Owner bookings don't need confirmation messages
      }
      
      // Check if we already sent confirmation
      const confirmationKey = `${booking.id}-confirmed`;
      if (sentConfirmations.has(confirmationKey)) {
        continue;
      }
      
      // Find the business
      const business = businesses.find(b => b.id === booking.business_id);
      if (!business) {
        continue;
      }
      
      // Send confirmation SMS
      const success = await sendConfirmationSMS(business, booking);
      
      if (success) {
        sentConfirmations.add(confirmationKey);
        saveSentItem(SENT_CONFIRMATIONS_FILE, confirmationKey);
        confirmationsSent++;
      }
    }
    
    if (confirmationsSent > 0) {
      console.log(`📧 Sent ${confirmationsSent} SMS confirmation(s)`);
    }
    
  } catch (error) {
    console.error('❌ Error checking approvals:', error);
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
    
    // Calculate hours until appointment
    const hoursUntil = differenceInHours(bookingDateTime, now);
    
    // Check if we should send reminder
    // Send if: appointment is within the reminder window (e.g., 10-14 hours from now for 12h setting)
    // This gives a 4-hour buffer window to catch appointments
    const shouldSend = hoursUntil >= (reminderHours - 2) && hoursUntil <= (reminderHours + 2);
    
    if (shouldSend) {
      // Check if we already sent to this booking
      const reminderKey = `${booking.id}-${booking.date}-${booking.time}`;
      if (sentReminders.has(reminderKey)) {
        console.log(`   ⏭️  Already sent reminder for booking ${booking.id}`);
        skippedCount++;
        continue;
      }
      
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
 * Start both services
 */
function startServices() {
  console.log('🚀 Automated SMS Reminder & Confirmation Service Started');
  console.log(`⏰ Reminder checks: every hour`);
  console.log(`📧 Approval checks: every minute`);
  console.log(`🌍 Timezone: ${process.env.TZ || 'UTC'}`);
  console.log(`📱 SMS Provider: Twilio`);
  console.log(`📞 From Number: ${TWILIO_CONFIG.phoneNumber}\n`);
  
  // Run reminder check immediately on start
  checkAndSendReminders();
  
  // Run approval check immediately on start
  checkApprovals();
  
  // Schedule reminder checks every hour
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(checkAndSendReminders, ONE_HOUR);
  
  // Schedule approval checks every minute
  const ONE_MINUTE = 60 * 1000;
  setInterval(checkApprovals, ONE_MINUTE);
}

// Start the services
startServices();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Services shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Services shutting down...');
  process.exit(0);
});

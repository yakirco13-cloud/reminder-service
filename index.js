/**
 * Automated Reminder Service for Base44 Booking System
 * 
 * This service runs 24/7 and automatically sends email reminders
 * to clients based on business settings stored in Base44.
 * 
 * Features:
 * - Checks every hour for bookings that need reminders
 * - Sends reminders X hours before appointment (configurable per business)
 * - Tracks sent reminders in a file to avoid duplicates (survives restarts)
 * - Supports multiple businesses
 * - Hebrew language support
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

// File to track sent reminders
const SENT_REMINDERS_FILE = path.join(process.cwd(), 'sent-reminders.json');

/**
 * Load sent reminders from file
 */
function loadSentReminders() {
  try {
    if (fs.existsSync(SENT_REMINDERS_FILE)) {
      const data = fs.readFileSync(SENT_REMINDERS_FILE, 'utf8');
      const reminders = JSON.parse(data);
      
      // Clean up old reminders (older than 7 days)
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const cleaned = {};
      for (const [key, timestamp] of Object.entries(reminders)) {
        if (timestamp > sevenDaysAgo) {
          cleaned[key] = timestamp;
        }
      }
      
      // Save cleaned version
      fs.writeFileSync(SENT_REMINDERS_FILE, JSON.stringify(cleaned, null, 2));
      
      return new Set(Object.keys(cleaned));
    }
  } catch (error) {
    console.error('Error loading sent reminders:', error);
  }
  return new Set();
}

/**
 * Save a sent reminder to file
 */
function saveSentReminder(reminderKey) {
  try {
    let reminders = {};
    if (fs.existsSync(SENT_REMINDERS_FILE)) {
      const data = fs.readFileSync(SENT_REMINDERS_FILE, 'utf8');
      reminders = JSON.parse(data);
    }
    
    reminders[reminderKey] = Date.now();
    fs.writeFileSync(SENT_REMINDERS_FILE, JSON.stringify(reminders, null, 2));
  } catch (error) {
    console.error('Error saving sent reminder:', error);
  }
}

// Load sent reminders on startup
const sentReminders = loadSentReminders();
console.log(`📋 Loaded ${sentReminders.size} previously sent reminders from file`);

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
 * Fetch all bookings for a specific business
 */
async function fetchBookings(businessId) {
  try {
    // Fetch ALL bookings (filter parameter doesn't work properly)
    const response = await fetch(`${BASE44_CONFIG.apiUrl}/entities/Booking`, {
      headers: {
        'api_key': BASE44_CONFIG.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch bookings: ${response.status}`);
    }
    
    const allBookings = await response.json();
    
    // Filter by business_id manually
    return allBookings.filter(b => b.business_id === businessId);
  } catch (error) {
    console.error(`Error fetching bookings for business ${businessId}:`, error);
    return [];
  }
}

/**
 * Send reminder email via Base44 SendEmail integration
 */
async function sendReminderEmail(business, booking) {
  try {
    const emailBody = `
שלום ${booking.client_name || 'לקוח יקר'},

תזכורת לתור שלך ${format(parseISO(booking.date), 'd בMMMM', { locale: he })} ב-${booking.time} ב-${business.name}

שירות: ${booking.service_name} (${booking.duration} דק')

נתראה! 
צוות ${business.name}
    `.trim();

    const response = await fetch(`${BASE44_CONFIG.apiUrl}/integration-endpoints/Core/SendEmail`, {
      method: 'POST',
      headers: {
        'api_key': BASE44_CONFIG.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from_name: business.name,
        to: booking.client_email,
        subject: `תזכורת לתור ב-${business.name} - ${booking.time}`,
        body: emailBody
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to send email: ${response.status}`);
    }

    console.log(`✅ Sent reminder to ${booking.client_email} for booking ${booking.id}`);
    return true;
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
    
    // Skip if no client email
    if (!booking.client_email) {
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
      const success = await sendReminderEmail(business, booking);
      
      if (success) {
        sentReminders.add(reminderKey);
        saveSentReminder(reminderKey);
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
 * Schedule the reminder checker to run every hour
 */
function startReminderService() {
  console.log('🚀 Automated Reminder Service Started');
  console.log(`⏰ Running checks every hour`);
  console.log(`🌍 Timezone: ${process.env.TZ || 'UTC'}\n`);
  
  // Run immediately on start
  checkAndSendReminders();
  
  // Then run every hour
  const ONE_HOUR = 60 * 60 * 1000;
  setInterval(checkAndSendReminders, ONE_HOUR);
}

// Start the service
startReminderService();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Reminder service shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Reminder service shutting down...');
  process.exit(0);
});

/**
 * Automated Reminder Service for Base44 Booking System
 * 
 * This service runs 24/7 and automatically sends email reminders
 * to clients based on business settings stored in Base44.
 * 
 * Features:
 * - Checks every hour for bookings that need reminders
 * - Sends reminders X hours before appointment (configurable per business)
 * - Tracks sent reminders to avoid duplicates
 * - Supports multiple businesses
 * - Hebrew language support
 */

import fetch from 'node-fetch';
import { format, parseISO, addHours, differenceInHours } from 'date-fns';
import { he } from 'date-fns/locale';

// Base44 API Configuration
const BASE44_CONFIG = {
  apiUrl: 'https://app.base44.com/api/apps/690b351ea4e5f2f9d798cdbb',
  apiKey: 'd6ebcd1dd1844f4c8f98c35af622bde7',
};

// In-memory tracker for sent reminders (prevents duplicates within same run)
// In production, consider using a database or Redis
const sentReminders = new Set();

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
    const response = await fetch(`${BASE44_CONFIG.apiUrl}/entities/Booking?filter=business_id:${businessId}`, {
      headers: {
        'api_key': BASE44_CONFIG.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch bookings: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
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

זוהי תזכורת לתור שלך ב-${business.name}

📅 תאריך: ${format(parseISO(booking.date), 'EEEE, d בMMMM yyyy', { locale: he })}
🕐 שעה: ${booking.time}
✂️ שירות: ${booking.service_name}
⏱️ משך: ${booking.duration} דקות

${booking.notes ? `📝 הערות: ${booking.notes}\n\n` : ''}
נשמח לראותך!

${business.phone ? `📞 ${business.phone}` : ''}
${business.email ? `✉️ ${business.email}` : ''}

בברכה,
צוות ${business.name}
    `.trim();

    const response = await fetch(`${BASE44_CONFIG.apiUrl}/integrations/SendEmail`, {
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
    
    // Parse booking datetime
    const bookingDateTime = parseISO(`${booking.date}T${booking.time}`);
    
    // Calculate hours until appointment
    const hoursUntil = differenceInHours(bookingDateTime, now);
    
    // Check if we should send reminder
    // Send if: appointment is within the reminder window (e.g., 11-13 hours from now for 12h setting)
    // This gives a 2-hour buffer window to catch appointments
    const shouldSend = hoursUntil >= (reminderHours - 1) && hoursUntil <= (reminderHours + 1);
    
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
  console.log(`⏰ Running checks every hour\n`);
  
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

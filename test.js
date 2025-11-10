/**
 * Test Script for Reminder Service
 * 
 * This script tests the connection to Base44 and checks if everything is set up correctly
 * Run with: node test.js
 */

import fetch from 'node-fetch';

const BASE44_CONFIG = {
  apiUrl: 'https://app.base44.com/api/apps/690b351ea4e5f2f9d798cdbb',
  apiKey: 'd6ebcd1dd1844f4c8f98c35af622bde7',
};

console.log('🧪 Testing Base44 Connection...\n');

async function testConnection() {
  try {
    // Test 1: Fetch businesses
    console.log('Test 1: Fetching businesses...');
    const businessResponse = await fetch(`${BASE44_CONFIG.apiUrl}/entities/Business`, {
      headers: {
        'api_key': BASE44_CONFIG.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    if (!businessResponse.ok) {
      throw new Error(`Failed to fetch businesses: ${businessResponse.status}`);
    }
    
    const businesses = await businessResponse.json();
    console.log(`✅ Success! Found ${businesses.length} business(es)`);
    
    if (businesses.length > 0) {
      console.log('\nBusiness Details:');
      businesses.forEach(b => {
        console.log(`  - Name: ${b.name}`);
        console.log(`    ID: ${b.id}`);
        console.log(`    Reminders Enabled: ${b.reminder_enabled !== false ? 'Yes' : 'No'}`);
        console.log(`    Reminder Hours: ${b.reminder_hours_before || '12 (default)'}`);
      });
    }
    
    // Test 2: Fetch bookings for first business
    if (businesses.length > 0) {
      console.log('\nTest 2: Fetching bookings...');
      const bookingResponse = await fetch(`${BASE44_CONFIG.apiUrl}/entities/Booking?filter=business_id:${businesses[0].id}`, {
        headers: {
          'api_key': BASE44_CONFIG.apiKey,
          'Content-Type': 'application/json'
        }
      });
      
      if (!bookingResponse.ok) {
        throw new Error(`Failed to fetch bookings: ${bookingResponse.status}`);
      }
      
      const bookings = await bookingResponse.json();
      console.log(`✅ Success! Found ${bookings.length} booking(s)`);
      
      // Count confirmed bookings with email
      const eligibleBookings = bookings.filter(b => 
        b.status === 'confirmed' && b.client_email
      );
      console.log(`   ${eligibleBookings.length} eligible for reminders (confirmed + has email)`);
      
      if (eligibleBookings.length > 0) {
        console.log('\nSample Booking:');
        const sample = eligibleBookings[0];
        console.log(`  - Client: ${sample.client_name}`);
        console.log(`  - Email: ${sample.client_email}`);
        console.log(`  - Date: ${sample.date}`);
        console.log(`  - Time: ${sample.time}`);
        console.log(`  - Service: ${sample.service_name}`);
        console.log(`  - Status: ${sample.status}`);
      }
    }
    
    console.log('\n✅ All tests passed! Your setup is ready.');
    console.log('\nNext steps:');
    console.log('1. Make sure reminder settings are configured in Business Settings');
    console.log('2. Run the service with: npm start');
    console.log('3. Create a test booking 12-13 hours from now');
    console.log('4. Wait 1 hour and check logs for reminder being sent');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Check your API key is correct');
    console.log('2. Verify the API URL is correct');
    console.log('3. Make sure you have internet connection');
    console.log('4. Check if Base44 service is accessible');
  }
}

testConnection();

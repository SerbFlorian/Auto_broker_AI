import 'dotenv/config';
// Wallapop archived for soft-launch (see src/scrapers/_archived/).
import { scrapeClicars } from './src/scrapers/clicars.scraper.js';
import { scrapeTheParking } from './src/scrapers/theparking.scraper.js';
import { scrapeOoyyo } from './src/scrapers/ooyyo.scraper.js';
import { prisma } from './src/db/prisma.js';

async function runAll() {
  console.log('🚀 Starting manual and immediate execution of all scrapers...');

  try {
    console.log('▶️ Running Clicars...');
    await scrapeClicars('https://www.clicars.com/coches-segunda-mano-ocasion');

    console.log('▶️ Running Ooyyo...');
    await scrapeOoyyo(
      'https://www.ooyyo.com/germany/used-cars-for-sale/c=CDA31D7114D3854F111BFE6FAA661551EDA2/'
    );

    console.log('▶️ Running TheParking...');
    await scrapeTheParking();

    console.log('🎯 Finding matches for VIP alerts (last 60 minutes)...');
    const { MatchingService } = await import('./src/services/matching.service.js');
    const sinceDate = new Date(Date.now() - 60 * 60 * 1000);
    const newCars = await prisma.carListing.findMany({
      where: { updatedAt: { gte: sinceDate } }
    });

    if (newCars.length > 0) {
      console.log(`🎯 Processing ${newCars.length} cars for VIP alerts...`);
      await MatchingService.processNewListings(newCars);
    } else {
      console.log('ℹ️ No new listings found in this execution.');
    }

    console.log('✅ Manual execution completed successfully.');
  } catch (error) {
    console.error('❌ Error during manual execution:', error);
  } finally {
    await prisma.$disconnect();
  }
}

runAll();

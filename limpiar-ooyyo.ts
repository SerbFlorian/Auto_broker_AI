import { prisma } from './src/db/prisma.js';

async function limpiarOoyyoDB() {
  console.log('🧹 Starting cleanup of corrupt OOYYO records...');

  try {
    const deleted = await prisma.carListing.deleteMany({
      where: {
        sourcePortal: 'ooyyo'
      }
    });

    console.log(`✅ Success! ${deleted.count} erroneous OOYYO cars have been deleted.`);
  } catch (error) {
    console.error('❌ Error cleaning the DB:', error);
  } finally {
    await prisma.$disconnect();
  }
}

limpiarOoyyoDB();
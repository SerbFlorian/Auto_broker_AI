import { prisma } from './src/db/prisma.js';

async function limpiarDB() {
  console.log('🧹 Starting database cleanup...');

  try {
    const deleted = await prisma.carListing.deleteMany({
      where: {
        sourcePortal: 'theparking'
      }
    });

    console.log(`✅ Success! ${deleted.count} erroneous cars from TheParking have been deleted.`);
  } catch (error) {
    console.error('❌ Error cleaning the DB:', error);
  } finally {
    await prisma.$disconnect();
  }
}

limpiarDB();
import { prisma } from './db/prisma.js';

async function main() {
  const users = await prisma.user.findMany({ include: { alerts: true } });
  for (const user of users) {
    console.log(`User: ${user.telegramId} | Status: ${user.subscriptionStatus}`);
    for (const alert of user.alerts) {
      console.log(`  Alert ID: ${alert.id} | Brand: ${alert.brand} | Model: ${alert.model} | MaxPrice: ${alert.maxPrice}`);
    }
  }
}

main().finally(() => prisma.$disconnect());

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearTodayData() {
  const today = new Date('2026-04-21');
  today.setHours(0, 0, 0, 0);
  
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  console.log(`Deleting items created between ${today.toISOString()} and ${tomorrow.toISOString()}`);

  try {
    // Delete variations first (if any)
    const variationsDeleted = await prisma.variation.deleteMany({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow
        }
      }
    });
    console.log(`Deleted ${variationsDeleted.count} variations.`);

    // Delete items
    const itemsDeleted = await prisma.item.deleteMany({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow
        }
      }
    });
    console.log(`Deleted ${itemsDeleted.count} items.`);

  } catch (error) {
    console.error('Error deleting data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearTodayData();

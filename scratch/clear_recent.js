const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearRecentData() {
  console.log('Fetching last 20 items...');
  const items = await prisma.item.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  if (items.length === 0) {
    console.log('No items found.');
    return;
  }

  const ids = items.map(it => it.id);
  console.log(`Deleting ${items.length} items:`, items.map(it => it.name).join(', '));

  try {
    // Delete variations linked to these items first
    await prisma.variation.deleteMany({
      where: { itemId: { in: ids } }
    });

    const deleted = await prisma.item.deleteMany({
      where: { id: { in: ids } }
    });
    console.log(`Deleted ${deleted.count} items.`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearRecentData();

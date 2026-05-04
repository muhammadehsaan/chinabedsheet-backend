const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearXYZXX() {
  console.log('Searching for XYZXX items...');
  const items = await prisma.item.findMany({
    where: { name: { contains: 'XYZXX', mode: 'insensitive' } },
    select: { id: true, name: true }
  });

  if (items.length === 0) {
    console.log('No XYZXX items found.');
    return;
  }

  const ids = items.map(it => it.id);
  console.log(`Deleting ${items.length} items:`, items.map(it => it.name).join(', '));

  try {
    // Delete related records first
    await prisma.variation.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.stockAdjustment.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.purchaseItem.deleteMany({ where: { itemId: { in: ids } } });
    await prisma.saleItem.deleteMany({ where: { itemId: { in: ids } } });

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

clearXYZXX();

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function listAllItems() {
  const items = await prisma.item.findMany({
    select: { id: true, name: true }
  });
  console.log('All items:', JSON.stringify(items, null, 2));
  await prisma.$disconnect();
}

listAllItems();

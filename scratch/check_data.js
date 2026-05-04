const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkData() {
  const items = await prisma.item.findMany({
    select: { id: true, createdAt: true, name: true },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log('Last 10 items:', JSON.stringify(items, null, 2));
  await prisma.$disconnect();
}

checkData();

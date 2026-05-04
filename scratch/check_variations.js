const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkVariations() {
  const variations = await prisma.variation.findMany({
    select: { id: true, createdAt: true, size: true, color: true },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log('Last 10 variations:', JSON.stringify(variations, null, 2));
  await prisma.$disconnect();
}

checkVariations();

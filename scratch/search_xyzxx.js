const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function searchXYZXX() {
  const items = await prisma.item.findMany({
    where: { name: { contains: 'XYZXX', mode: 'insensitive' } }
  });
  console.log('XYZXX items:', JSON.stringify(items, null, 2));
  await prisma.$disconnect();
}

searchXYZXX();

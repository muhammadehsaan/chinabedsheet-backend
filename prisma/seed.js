const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const units = ["Meters", "Pieces", "Bundles"];
  for (const name of units) {
    await prisma.unit.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  await prisma.category.upsert({
    where: { name: "Bedsheets" },
    update: {},
    create: { name: "Bedsheets" },
  });
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

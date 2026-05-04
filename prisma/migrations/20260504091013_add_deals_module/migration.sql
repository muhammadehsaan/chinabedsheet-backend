-- DropIndex
DROP INDEX "User_roleId_idx";

-- AlterTable
ALTER TABLE "Deal" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Role" ALTER COLUMN "permissions" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

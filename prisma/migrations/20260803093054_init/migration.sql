-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('unmapped', 'pending', 'synced', 'error');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('create', 'update', 'price_qty');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DarazAccount" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "sellerId" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DarazAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "darazItemId" TEXT,
    "darazSkuId" TEXT,
    "darazCategoryId" TEXT,
    "attributesJson" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'unmapped',
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "type" "SyncJobType" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DarazAccount_shop_key" ON "DarazAccount"("shop");

-- CreateIndex
CREATE INDEX "ProductMapping_shop_syncStatus_idx" ON "ProductMapping"("shop", "syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_shop_shopifyProductId_key" ON "ProductMapping"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "SyncJob_status_createdAt_idx" ON "SyncJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncJob_shop_shopifyProductId_idx" ON "SyncJob"("shop", "shopifyProductId");

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_shop_fkey" FOREIGN KEY ("shop") REFERENCES "DarazAccount"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_shop_fkey" FOREIGN KEY ("shop") REFERENCES "DarazAccount"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

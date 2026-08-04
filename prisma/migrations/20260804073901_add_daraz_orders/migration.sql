-- CreateTable
CREATE TABLE "DarazOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "darazOrderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "customerName" TEXT,
    "status" TEXT NOT NULL,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" TEXT,
    "currency" TEXT,
    "darazCreatedAt" TIMESTAMP(3),
    "darazUpdatedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DarazOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DarazOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "darazOrderItemId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT,
    "imageUrl" TEXT,
    "price" TEXT,
    "currency" TEXT,
    "status" TEXT,

    CONSTRAINT "DarazOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DarazOrder_shop_darazCreatedAt_idx" ON "DarazOrder"("shop", "darazCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DarazOrder_shop_darazOrderId_key" ON "DarazOrder"("shop", "darazOrderId");

-- CreateIndex
CREATE INDEX "DarazOrderItem_orderId_idx" ON "DarazOrderItem"("orderId");

-- AddForeignKey
ALTER TABLE "DarazOrder" ADD CONSTRAINT "DarazOrder_shop_fkey" FOREIGN KEY ("shop") REFERENCES "DarazAccount"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DarazOrderItem" ADD CONSTRAINT "DarazOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DarazOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

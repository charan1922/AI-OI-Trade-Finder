-- CreateTable
CREATE TABLE "master_contracts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "securityId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "underlying" TEXT,
    "expiryDate" DATETIME,
    "syncDate" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "master_contracts_exchange_symbol_idx" ON "master_contracts"("exchange", "symbol");

-- CreateIndex
CREATE INDEX "master_contracts_segment_instrument_underlying_idx" ON "master_contracts"("segment", "instrument", "underlying");

-- CreateIndex
CREATE INDEX "master_contracts_syncDate_idx" ON "master_contracts"("syncDate");

-- CreateIndex
CREATE UNIQUE INDEX "master_contracts_securityId_segment_key" ON "master_contracts"("securityId", "segment");

-- CreateIndex
CREATE INDEX "activity_createdAt_idx" ON "activity"("createdAt");

-- CreateIndex
CREATE INDEX "activity_symbol_idx" ON "activity"("symbol");

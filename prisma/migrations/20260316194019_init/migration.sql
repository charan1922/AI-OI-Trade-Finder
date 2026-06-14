-- CreateTable
CREATE TABLE "watchlist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "segment" TEXT NOT NULL DEFAULT 'EQ',
    "securityId" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "activity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "rowsCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "dhanClientId" TEXT NOT NULL DEFAULT '',
    "dhanAccessToken" TEXT NOT NULL DEFAULT '',
    "batchSize" INTEGER NOT NULL DEFAULT 10,
    "rateLimitMs" INTEGER NOT NULL DEFAULT 250,
    "defaultRange" TEXT NOT NULL DEFAULT '30',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "chartHeight" INTEGER NOT NULL DEFAULT 450,
    "autoRefresh" BOOLEAN NOT NULL DEFAULT true,
    "showTooltips" BOOLEAN NOT NULL DEFAULT true
);

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_symbol_exchange_key" ON "watchlist"("symbol", "exchange");

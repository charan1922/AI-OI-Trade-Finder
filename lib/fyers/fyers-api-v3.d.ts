/**
 * Minimal ambient types for the untyped fyers-api-v3 SDK — only the surface
 * lib/fyers/client.ts uses (verified against node_modules/fyers-api-v3).
 */
declare module 'fyers-api-v3' {
  export interface FyersModelParams {
    AccessToken?: string;
    AppID?: string;
    RedirectURL?: string;
    Version?: string;
    /** Directory the SDK writes its log files to. */
    path?: string;
    /** Defaults to TRUE in the SDK — pass false to suppress log files. */
    enableLogging?: boolean;
  }

  export class fyersModel {
    constructor(params?: FyersModelParams);
    setAppId(appId: string): void;
    setRedirectUrl(url: string): void;
    setAccessToken(token: string): void;
    getHistory(req: {
      symbol: string;
      resolution: string;
      date_format: string;
      range_from: string;
      range_to: string;
      cont_flag: string;
    }): Promise<Record<string, unknown>>;
    getQuotes(symbols: string[]): Promise<Record<string, unknown>>;
    getMarketDepth(req: { symbol: string[]; ohlcv_flag: number }): Promise<Record<string, unknown>>;
    // Trading surface (lib/auto-trade/brokers/fyers-adapter.ts). Verified
    // against node_modules/fyers-api-v3/apiService/apiService.js. NOTE:
    // get_orders resolves undefined on HTTP failure (the SDK logs instead of
    // rejecting) — callers must null-check.
    place_order(req: {
      symbol: string;
      qty: number;
      type: number; // 1=limit 2=market 3=SL-M 4=SL-L
      side: number; // 1=buy -1=sell
      productType: string; // 'INTRADAY' | 'CNC' | 'MARGIN'
      limitPrice: number;
      stopPrice: number;
      validity: string; // 'DAY' | 'IOC'
      disclosedQty: number;
      offlineOrder: boolean;
      orderTag?: string;
    }): Promise<Record<string, unknown>>;
    cancel_order(req: { id: string }): Promise<Record<string, unknown>>;
    get_orders(): Promise<Record<string, unknown> | undefined>;
    get_positions(): Promise<Record<string, unknown> | undefined>;
    get_funds(): Promise<Record<string, unknown> | undefined>;
  }

  export interface FyersDataSocketInstance {
    FullMode: unknown;
    LiteMode: unknown;
    on(event: 'connect' | 'message' | 'error' | 'close', handler: (message?: unknown) => void): void;
    subscribe(symbols: string[], depth?: boolean, channel?: number): void;
    unsubscribe(symbols: string[], depth?: boolean, channel?: number): void;
    mode(mode: unknown, channel?: number): void;
    connect(): void;
    close(): void;
    isConnected(): boolean;
    /** SDK releases have shipped both spellings; runtime code probes safely. */
    autoReconnect?: (retries?: number) => void;
    autoreconnect?: (retries?: number) => void;
  }

  export const fyersDataSocket: {
    new (accessToken: string, logPath?: string, enableLogging?: boolean): FyersDataSocketInstance;
    getInstance(accessToken: string, logPath?: string, enableLogging?: boolean): FyersDataSocketInstance;
  };
}

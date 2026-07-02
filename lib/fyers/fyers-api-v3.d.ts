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
  }
}

'use client';

import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type NiftyContext = {
  expiry: string;
  spot: number;
  capturedAt: string;
  proxy: {
    balance: 'call-side-higher' | 'put-side-higher' | 'equal';
    netSharePct: number;
    concentrationStrike: number | null;
  };
};

export function NiftyMarketContext({ refreshSignal }: { refreshSignal: number }) {
  const [data, setData] = useState<NiftyContext | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/live/nifty-context', {
          cache: 'no-store',
        });
        const payload = (await response.json()) as {
          data?: NiftyContext | null;
        };
        if (active) setData(payload.data ?? null);
      } catch {
        if (active) setData(null);
      }
    };
    void load();
    const timer = window.setInterval(load, 180_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshSignal]);

  return (
    <Card size="sm" className="h-full [--card-spacing:--spacing(2)]">
      <CardHeader className="flex flex-row flex-wrap items-center gap-x-2 gap-y-0">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Activity aria-hidden="true" /> NIFTY market context
        </CardTitle>
        <Badge variant="secondary">Experimental</Badge>
        <CardDescription className="basis-full text-xs">
          Public-OI gamma balance proxy - display only. Public OI cannot reveal dealer positioning; it never affects
          trade suggestions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {data === undefined ? (
          <Skeleton className="h-5 w-52" />
        ) : data == null ? (
          <p className="text-xs text-muted-foreground">Option-chain context is unavailable right now.</p>
        ) : (
          <>
            <Badge variant="outline">
              {data.proxy.netSharePct >= 0 ? '+' : ''}
              {data.proxy.netSharePct.toFixed(1)}% call-minus-put balance
            </Badge>
            <p className="text-sm text-foreground">
              NIFTY {data.spot.toFixed(2)} - expiry {data.expiry}
            </p>
            <p className="text-xs text-muted-foreground">
              As of{' '}
              {new Date(data.capturedAt).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Kolkata',
              })}{' '}
              IST
            </p>
            {data.proxy.concentrationStrike != null && (
              <p className="text-xs text-muted-foreground">
                Largest absolute call/put difference: {data.proxy.concentrationStrike}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

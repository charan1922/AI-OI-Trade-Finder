'use client';

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSyncExternalStore } from 'react';

/** The slot in the app header (components/layout-shell.tsx) a page can render its title into. */
export const PAGE_HEADER_SLOT_ID = 'page-header-slot';

const subscribe = () => () => {};
const getSlot = () => document.getElementById(PAGE_HEADER_SLOT_ID);
const getServerSlot = () => null;

/** Renders `children` into the app header instead of the page body (saves a row on dense pages). */
export function PageHeaderPortal({ children }: { children: ReactNode }) {
  const slot = useSyncExternalStore(subscribe, getSlot, getServerSlot);
  return slot ? createPortal(children, slot) : null;
}

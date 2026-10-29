"use client"

import { usePathname } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { BhavcopyReminder } from "@/components/bhavcopy-reminder"
import { HealthIndicator } from "@/components/health-indicator"
import { PAGE_HEADER_SLOT_ID } from "@/components/page-header-portal"
import { UserMenu } from "@/components/user-menu"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

export function LayoutShell({ children, commentaryV2 }: { children: React.ReactNode; commentaryV2: boolean }) {
  const pathname = usePathname()

  // The login screen renders full-bleed — no sidebar, header, or reminders.
  if (pathname === "/login") return <>{children}</>

  return (
    // Collapsed by default (operator 2026-10-29) — pages like /trade-commentary-v2 need the width; ☰ opens it.
    <SidebarProvider defaultOpen={false}>
      <AppSidebar commentaryV2={commentaryV2} />
      <SidebarInset>
        <BhavcopyReminder />
        <header className="flex h-12 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          {/* Pages may put their title here via <PageHeaderPortal> instead of spending a row on it. */}
          <div id={PAGE_HEADER_SLOT_ID} className="flex min-w-0 items-center gap-2" />
          <div className="ml-auto flex items-center gap-2">
            <HealthIndicator />
            {/* Settings + Sign out moved into the profile menu (user-menu.tsx). */}
            <UserMenu />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-3 sm:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}

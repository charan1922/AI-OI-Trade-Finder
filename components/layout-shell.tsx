"use client"

import { usePathname } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { BhavcopyReminder } from "@/components/bhavcopy-reminder"
import { HealthIndicator } from "@/components/health-indicator"
import { UserMenu } from "@/components/user-menu"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // The login screen renders full-bleed — no sidebar, header, or reminders.
  if (pathname === "/login") return <>{children}</>

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <BhavcopyReminder />
        <header className="flex h-12 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
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

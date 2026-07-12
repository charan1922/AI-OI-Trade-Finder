"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Settings } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { BhavcopyReminder } from "@/components/bhavcopy-reminder"
import { HealthIndicator } from "@/components/health-indicator"
import { UserMenu } from "@/components/user-menu"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { useRole } from "@/lib/auth/use-role"
import { cn } from "@/lib/utils"

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { readOnly } = useRole()

  // The login screen renders full-bleed — no sidebar, header, or reminders.
  if (pathname === "/login") return <>{children}</>

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <BhavcopyReminder />
        <header className="flex h-12 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="ml-auto flex items-center gap-1">
            <HealthIndicator />
            {/* Settings (/config) is admin-only — hidden for the read-only viewer
                role (the page itself also 403s writes, this is the UX layer). */}
            {!readOnly && (
              <Link
                href="/config"
                aria-label="Settings"
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  pathname.startsWith("/config")
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Settings className="size-4" />
                <span>Settings</span>
              </Link>
            )}
            <UserMenu />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-3 sm:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}

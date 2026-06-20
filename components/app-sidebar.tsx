"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { BarChart2, Bot, BookOpen, CalendarDays, ChevronDown, ChevronRight, Download, Eye, Flame, FlaskConical, Gauge, Grid3x3, History, LayoutGrid, LineChart, ScanSearch, Table2 } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

const NAV_ITEMS = {
  label: "Simulator",
  icon: FlaskConical,
  children: [
    { title: "Market Simulator", href: "/market-simulator", icon: BarChart2 },
    { title: "Data Downloader", href: "/data-downloader", icon: Download },
    { title: "Trade Assistant", href: "/trade-assistant", icon: Bot },
    { title: "Backtest", href: "/backtest", icon: LineChart },
    { title: "Signal Lab", href: "/signal-lab", icon: ScanSearch },
    { title: "Live Urgency", href: "/live", icon: Gauge },
    { title: "Heatmap", href: "/heatmap", icon: Grid3x3 },
    { title: "NSE Heatmap", href: "/nse/heatmap", icon: LayoutGrid },
    { title: "NSE Movers", href: "/nse/movers", icon: Flame },
    { title: "EOD Movers", href: "/nse/movers-history", icon: History },
    { title: "Trade Viewer", href: "/trade-viewer", icon: Eye },
    { title: "Market Holidays", href: "/holidays", icon: CalendarDays },
    { title: "F&O Lot Sizes", href: "/fno-lots", icon: Table2 },
    { title: "API Docs", href: "/api-docs", icon: BookOpen },
  ],
}

export function AppSidebar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(true)

  const isChildActive = NAV_ITEMS.children.some((c) => pathname.startsWith(c.href))

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Project-R Sim">
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <FlaskConical className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-sm font-semibold tracking-tight">Project-R Sim</span>
                  <span className="truncate text-xs text-sidebar-foreground/60">Simulation &amp; Backtesting</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          {/* Collapsible group header */}
          <SidebarGroupLabel asChild>
            <button
              onClick={() => setOpen((v) => !v)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium uppercase tracking-wider",
                "text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors cursor-pointer",
                "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
              )}
            >
              <NAV_ITEMS.icon className="size-4 shrink-0" />
              <span className="group-data-[collapsible=icon]:hidden flex-1 text-left">
                {NAV_ITEMS.label}
              </span>
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
              )}
            </button>
          </SidebarGroupLabel>

          {/* Sub-menu items */}
          {(open || isChildActive) && (
            <SidebarMenu className="mt-1">
              {NAV_ITEMS.children.map((item) => {
                const active = pathname.startsWith(item.href)
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.title}
                    >
                      <Link href={item.href}>
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  )
}

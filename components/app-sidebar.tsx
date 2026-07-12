"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { Activity, Bot, BookOpen, CalendarClock, CalendarDays, ChevronDown, ChevronRight, Download, Eye, Flame, FlaskConical, Gauge, Grid3x3, History, LayoutGrid, type LucideIcon, NotebookText, Radio, ScrollText, Sparkles, Table2, Target, Zap } from "lucide-react"

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

interface NavItem {
  title: string
  href: string
  icon: LucideIcon
}

interface NavGroup {
  label: string
  icon: LucideIcon
  children: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Live Market",
    icon: Activity,
    children: [
      { title: "Live Urgency", href: "/live", icon: Gauge },
      { title: "NSE Movers", href: "/nse/movers", icon: Flame },
      { title: "NSE Heatmap", href: "/nse/heatmap", icon: LayoutGrid },
      { title: "Heatmap", href: "/heatmap", icon: Grid3x3 },
      { title: "Fyers Live", href: "/fyers", icon: Radio },
    ],
  },
  {
    label: "Simulation",
    icon: FlaskConical,
    children: [
      { title: "Trade Viewer", href: "/trade-viewer", icon: Eye },
      { title: "Data Downloader", href: "/data-downloader", icon: Download },
    ],
  },
  {
    label: "Assistant",
    icon: Bot,
    children: [
      { title: "Trade Assistant", href: "/trade-assistant", icon: Bot },
      { title: "Trade Suggest", href: "/trade-suggest", icon: Target },
      { title: "Trade Commentary", href: "/trade-commentary", icon: Sparkles },
      { title: "Auto Trade", href: "/auto-trade", icon: Zap },
      { title: "Trade Log", href: "/trade-suggest/history", icon: NotebookText },
    ],
  },
  {
    label: "Reference",
    icon: BookOpen,
    children: [
      { title: "EOD Movers", href: "/nse/movers-history", icon: History },
      { title: "EOD Live Urgency", href: "/live/history", icon: CalendarClock },
      { title: "Market Holidays", href: "/holidays", icon: CalendarDays },
      { title: "F&O Lot Sizes", href: "/fno-lots", icon: Table2 },
      { title: "AI Prompts", href: "/prompts", icon: ScrollText },
      { title: "API Docs", href: "/api-docs", icon: BookOpen },
    ],
  },
]

/** One collapsible nav group — expanded by default; an active child keeps it open. */
function NavGroupSection({ group, pathname }: { group: NavGroup; pathname: string }) {
  const [open, setOpen] = useState(true)
  const isChildActive = group.children.some((c) => pathname.startsWith(c.href))

  return (
    <SidebarGroup>
      <SidebarGroupLabel asChild>
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider",
            "text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors cursor-pointer",
            "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          )}
        >
          <group.icon className="size-4 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden flex-1 text-left">{group.label}</span>
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
          )}
        </button>
      </SidebarGroupLabel>

      {(open || isChildActive) && (
        <SidebarMenu className="mt-1">
          {group.children.map((item) => {
            const active = pathname.startsWith(item.href)
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.title} className="text-xs">
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
  )
}

export function AppSidebar() {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Project-R">
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <FlaskConical className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-sm font-semibold tracking-tight">Project-R</span>
                  <span className="truncate text-xs text-sidebar-foreground/60">DeepQuant</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <NavGroupSection key={group.label} group={group} pathname={pathname} />
        ))}
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  )
}

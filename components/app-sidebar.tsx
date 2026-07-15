'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Activity,
  AlarmClock,
  Banknote,
  Bot,
  BookOpen,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Eye,
  Flame,
  FlaskConical,
  Gauge,
  Grid3x3,
  LayoutGrid,
  type LucideIcon,
  NotebookText,
  Radio,
  ScrollText,
  Sparkles,
  Table2,
  Target,
  Zap,
} from 'lucide-react';

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
} from '@/components/ui/sidebar';
import { isAdminOnlyPage } from '@/lib/auth/rbac';
import { useRole } from '@/lib/auth/use-role';
import { cn } from '@/lib/utils';

interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  icon: LucideIcon;
  children: NavItem[];
  /** Start collapsed (still auto-opens when a child route is active). */
  defaultCollapsed?: boolean;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Live Market',
    icon: Activity,
    children: [
      { title: 'Live Urgency', href: '/live', icon: Gauge },
      { title: 'NSE Movers', href: '/nse/movers', icon: Flame },
      { title: 'NSE Heatmap', href: '/nse/heatmap', icon: LayoutGrid },
      { title: 'Heatmap', href: '/heatmap', icon: Grid3x3 },
      { title: 'Fyers Live', href: '/fyers', icon: Radio },
      { title: 'Dhan', href: '/dhan', icon: Banknote },
    ],
  },
  {
    label: 'Assistant',
    icon: Bot,
    children: [
      { title: 'Trade Suggest', href: '/trade-suggest', icon: Target },
      { title: 'Trade Commentary', href: '/trade-commentary', icon: Sparkles },
      { title: 'Auto Trade', href: '/auto-trade', icon: Zap },
      { title: 'Trade Assistant', href: '/trade-assistant', icon: Bot },
    ],
  },
  {
    label: 'End of Day',
    icon: CalendarClock,
    defaultCollapsed: true,
    children: [
      { title: 'EOD Auto Trade', href: '/auto-trade/history', icon: Zap },
      { title: 'EOD Trade Log', href: '/trade-suggest/history', icon: NotebookText },
      { title: 'EOD Live Urgency', href: '/live/history', icon: Gauge },
      { title: 'EOD Movers', href: '/nse/movers-history', icon: Flame },
    ],
  },
  {
    label: 'Simulation',
    icon: FlaskConical,
    defaultCollapsed: true,
    children: [
      { title: 'Trade Viewer', href: '/trade-viewer', icon: Eye },
      { title: 'Data Downloader', href: '/data-downloader', icon: Download },
    ],
  },
  {
    label: 'Reference',
    icon: BookOpen,
    defaultCollapsed: true,
    children: [
      { title: 'Reminders', href: '/reminders', icon: AlarmClock },
      { title: 'Market Holidays', href: '/holidays', icon: CalendarDays },
      { title: 'F&O Lot Sizes', href: '/fno-lots', icon: Table2 },
      { title: 'Database', href: '/db-explorer', icon: Database },
      { title: 'AI Prompts', href: '/prompts', icon: ScrollText },
      { title: 'API Docs', href: '/api-docs', icon: BookOpen },
    ],
  },
];

/** One collapsible nav group. Expanded by default; a defaultCollapsed group
 *  starts (and stays) collapsed until the user clicks it — even when one of its
 *  pages is active. Normal groups auto-open when a child route is active. */
function NavGroupSection({ group, pathname }: { group: NavGroup; pathname: string }) {
  const isChildActive = group.children.some((c) => pathname.startsWith(c.href));
  const [open, setOpen] = useState(!group.defaultCollapsed);

  return (
    <SidebarGroup>
      <SidebarGroupLabel asChild>
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium tracking-wider uppercase',
            'cursor-pointer text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground',
            'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0'
          )}
        >
          <group.icon className="size-4 shrink-0" />
          <span className="flex-1 text-left group-data-[collapsible=icon]:hidden">{group.label}</span>
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
          )}
        </button>
      </SidebarGroupLabel>

      {(open || (isChildActive && !group.defaultCollapsed)) && (
        <SidebarMenu className="mt-1">
          {group.children.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.title} className="text-xs">
                  <Link href={item.href}>
                    <item.icon className="size-4" />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { readOnly } = useRole();

  // Viewers never see admin-only entries (the rbac list is the single source —
  // the proxy enforces, this hiding is the UX half). Groups left empty vanish.
  const groups = readOnly
    ? NAV_GROUPS.map((g) => ({
        ...g,
        children: g.children.filter((c) => !isAdminOnlyPage(c.href)),
      })).filter((g) => g.children.length > 0)
    : NAV_GROUPS;

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
        {groups.map((group) => (
          <NavGroupSection key={group.label} group={group} pathname={pathname} />
        ))}
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}

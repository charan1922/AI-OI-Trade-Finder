"use client"

import Link from "next/link"
import { Eye, LogOut, Settings, ShieldCheck } from "lucide-react"
import { useState } from "react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useRole } from "@/lib/auth/use-role"
import { cn } from "@/lib/utils"

/**
 * Profile menu (top-right): avatar button → dropdown with the signed-in
 * identity (Google name/email or password-login username), the role badge,
 * Settings (admin only — moved here from the header), and Sign out.
 * Enforcement lives in the proxy/RBAC — everything here is UX only.
 */
export function UserMenu() {
  const { username, email, image, readOnly, gateEnabled } = useRole()
  const [open, setOpen] = useState(false)

  const initial = (username || "?").trim().charAt(0).toUpperCase()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Profile menu"
          className="flex items-center rounded-full transition-shadow hover:ring-2 hover:ring-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar image={image} initial={initial} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64 p-0">
        {/* Identity */}
        <div className="flex items-center gap-3 border-b border-border p-3">
          <Avatar image={image} initial={initial} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{username}</p>
            {email && <p className="truncate text-xs text-muted-foreground">{email}</p>}
            <span
              className={cn(
                "mt-1 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                readOnly
                  ? "border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                  : "border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
              )}
              title={readOnly ? "Read-only session — actions are disabled" : "Operator session — full access"}
            >
              {readOnly ? <Eye className="size-3" /> : <ShieldCheck className="size-3" />}
              {readOnly ? "Read-only" : "Operator"}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="p-1">
          {!readOnly && (
            <Link
              href="/config"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <Settings className="size-4 text-muted-foreground" />
              Settings
            </Link>
          )}
          {gateEnabled && (
            <>
              {/* Deliberate <a>: logout must be ONE full browser navigation (the
                  API route clears cookies + redirects) — a client-side <Link />
                  transition would not carry the Set-Cookie response through. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/api/auth/logout"
                className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <LogOut className="size-4 text-muted-foreground" />
                Sign out
              </a>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Avatar({ image, initial, size = "sm" }: { image: string | null; initial: string; size?: "sm" | "lg" }) {
  const cls = size === "lg" ? "size-10 text-base" : "size-8 text-sm"
  if (image) {
    // Deliberate <img>: Google avatar hosts (lh3.googleusercontent.com) are not
    // in next/image remotePatterns; a 32px avatar gains nothing from optimization.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={image} alt="" referrerPolicy="no-referrer" className={cn(cls, "rounded-full object-cover")} />
    )
  }
  return (
    <span
      className={cn(
        cls,
        "grid place-items-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 font-bold text-white",
      )}
    >
      {initial}
    </span>
  )
}

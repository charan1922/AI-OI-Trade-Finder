import { Geist_Mono, Inter } from "next/font/google"
import { cookies, headers } from "next/headers"
import { ThemeProvider } from "next-themes"

import "./globals.css"
import { LayoutShell } from "@/components/layout-shell"
import { RoleProvider, type RoleInfo } from "@/components/role-provider"
import { ThemeHotkey } from "@/components/theme-hotkey"
import { ROLE_HEADER, type Role } from "@/lib/auth/rbac"
import { USERNAME_COOKIE } from "@/lib/auth/session"
import { cn } from "@/lib/utils"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

/** Resolve the caller's role from the proxy's trusted header + display cookie,
 *  server-side, so the UI knows it from the first render (no client fetch). */
async function resolveRoleInfo(): Promise<RoleInfo> {
  const [hdrs, cookieStore] = [await headers(), await cookies()]
  const role: Role = hdrs.get(ROLE_HEADER) === "viewer" ? "viewer" : "admin"
  const gateEnabled = !!process.env.APP_PASSWORD
  const rawUser = cookieStore.get(USERNAME_COOKIE)?.value
  let username = role === "viewer" ? "Guest" : "Analyst"
  if (rawUser) {
    try {
      const v = decodeURIComponent(rawUser).trim()
      if (v) username = v
    } catch {
      /* malformed cookie — keep default */
    }
  }
  return { role, readOnly: role === "viewer", username, gateEnabled }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const roleInfo = await resolveRoleInfo()

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", inter.variable)}
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <RoleProvider value={roleInfo}>
            <ThemeHotkey />
            <LayoutShell>{children}</LayoutShell>
          </RoleProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

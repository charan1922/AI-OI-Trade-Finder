"use client"

import "swagger-ui-dist/swagger-ui.css"

import { useEffect, useRef, useState } from "react"

/**
 * Swagger UI for the simulator API, rendered from the locally-installed
 * swagger-ui-dist package (no CDN) and pointed at /api/openapi. The bundle is
 * imported dynamically inside the effect so its UMD `window` references never run
 * during SSR.
 */
export default function ApiDocsPage() {
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (started.current) return
    started.current = true

    import("swagger-ui-dist/swagger-ui-bundle.js")
      .then((mod) => {
        const SwaggerUIBundle = mod.default
        SwaggerUIBundle({
          url: "/api/openapi",
          dom_id: "#swagger-ui",
          deepLinking: true,
          tryItOutEnabled: true,
          displayRequestDuration: true,
          defaultModelsExpandDepth: 0,
        })
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="min-h-screen bg-white">
      <div className="border-b bg-slate-50 px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">API Explorer</h1>
        <p className="text-sm text-slate-500">
          Live OpenAPI spec at{" "}
          <a href="/api/openapi" className="text-blue-600 underline" target="_blank" rel="noreferrer">
            /api/openapi
          </a>
          . Use “Try it out” to call endpoints against this dev server.
        </p>
      </div>
      {error && <div className="px-6 py-4 text-sm text-red-600">Failed to load Swagger UI: {error}</div>}
      <div id="swagger-ui" />
    </div>
  )
}
